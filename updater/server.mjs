import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const app=express();
const port=8096;
const workerVersion='0.4.1';
const root=process.env.WOLCOM_INSTALL_DIR||'/opt/wolcom';
const token=process.env.WOLCOM_UPDATER_TOKEN||'';
const data=path.join(root,'data');
const inbox=path.join(root,'update-inbox');
const jobs=path.join(data,'update-job.json');
await fsp.mkdir(inbox,{recursive:true});
await fsp.mkdir(data,{recursive:true});
// Migrate the pre-0.4.1 single GitHub configuration to the private Cloud target once.
try{
  const oldCfg=path.join(data,'github.json'),oldTok=path.join(data,'github-token'),newCfg=path.join(data,'github-cloud.json'),newTok=path.join(data,'github-cloud-token');
  if(fs.existsSync(oldCfg)&&!fs.existsSync(newCfg))await fsp.copyFile(oldCfg,newCfg);
  if(fs.existsSync(oldTok)&&!fs.existsSync(newTok))await fsp.copyFile(oldTok,newTok);
}catch(e){console.warn('GitHub legacy config migration:',e.message)}


const auth=(req,res,next)=>{if(!token||req.get('x-wolcom-updater-token')!==token)return res.status(401).json({error:'Unauthorized'});next()};
app.use('/api',auth);
app.use('/api/config',express.json({limit:'64kb'}));
app.use('/api/github',express.json({limit:'64kb'}));

function run(cmd,args,{cwd=root,env={}}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,...env}});let out='';
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);
    p.on('close',c=>c===0?resolve(out):reject(new Error(out||`${cmd} failed (${c})`)));
  });
}
async function state(v){await fsp.writeFile(jobs,JSON.stringify({...v,worker_version:workerVersion,time:new Date().toISOString()},null,2))}
async function readState(){try{return {...JSON.parse(await fsp.readFile(jobs,'utf8')),worker_version:workerVersion}}catch{return {status:'idle',worker_version:workerVersion}}}
function trimLog(s){return s.length>12000?s.slice(-12000):s}

async function runUpdateScript(script,{cwd,env,baseState}){
  return new Promise((resolve,reject)=>{
    const p=spawn('bash',[script],{cwd,env:{...process.env,...env}});
    let full='', pending='';
    let q=Promise.resolve();
    const consume=(chunk)=>{
      const text=chunk.toString(); full+=text; pending+=text;
      const lines=pending.split(/\r?\n/); pending=lines.pop()||'';
      for(const line of lines){
        const m=line.match(/^WOLCOM_PHASE\|([^|]+)\|(.*)$/);
        if(m){
          q=q.then(()=>state({...baseState,status:'installing',step:m[1],message:m[2],log_tail:trimLog(full)})).catch(()=>{});
        }
      }
    };
    p.stdout.on('data',consume); p.stderr.on('data',consume);
    p.on('close',async c=>{await q;if(c===0)resolve(full);else reject(new Error(full||`update.sh failed (${c})`))});
  });
}

app.get('/api/status',async(_q,r)=>r.json(await readState()));
app.get('/api/health',(_q,r)=>r.json({ok:true,service:'wolcom-updater',version:workerVersion}));

function ghTarget(v){return String(v||'cloud')==='open_source'?'open_source':'cloud'}
function ghFiles(target){const t=ghTarget(target);return {cfg:path.join(data,`github-${t}.json`),token:path.join(data,`github-${t}-token`)}}
app.get('/api/config/github',async(req,r)=>{const target=ghTarget(req.query.target);const f=ghFiles(target);try{const j=JSON.parse(await fsp.readFile(f.cfg,'utf8'));r.json({...j,target,token_configured:fs.existsSync(f.token)})}catch{r.json({target,repo:'',branch:'main',token_configured:false})}});
app.post('/api/config/github',async(req,res)=>{const target=ghTarget(req.body.target),f=ghFiles(target);const repo=String(req.body.repo||'').trim().replace(/^https?:\/\/github.com\//,'').replace(/\.git$/,'');const branch=String(req.body.branch||'main').trim()||'main';const tok=String(req.body.token||'').trim();if(repo&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))return res.status(400).json({error:'Repo must be owner/repository'});await fsp.writeFile(f.cfg,JSON.stringify({repo,branch,target},null,2),{mode:0o600});if(tok)await fsp.writeFile(f.token,tok,{mode:0o600});res.json({ok:true,target,repo,branch,token_configured:Boolean(tok||fs.existsSync(f.token))})});

app.post('/api/upload' ,express.raw({type:['application/gzip','application/x-gzip','application/octet-stream'],limit:'250mb'}),async(req,res)=>{try{const name=path.basename(req.get('x-update-filename')||'wolcom-update.tar.gz');if(!name.endsWith('.tar.gz'))return res.status(400).json({error:'Only .tar.gz packages are accepted'});const buf=req.body;if(!Buffer.isBuffer(buf)||buf.length<100)return res.status(400).json({error:'Empty update package'});const sha=crypto.createHash('sha256').update(buf).digest('hex');const file=path.join(inbox,`${Date.now()}-${name}`);await fsp.writeFile(file,buf,{mode:0o600});const list=await run('tar',['-tzf',file],{cwd:'/tmp'});if(list.split('\n').some(x=>x.startsWith('/')||x.split('/').includes('..'))){await fsp.unlink(file);return res.status(400).json({error:'Unsafe archive paths'})}const tmp=path.join('/tmp','wolcom-verify-'+crypto.randomUUID());await fsp.mkdir(tmp);await run('tar',['-xzf',file,'-C',tmp]);const manifests=[];for(const d of await fsp.readdir(tmp)){const p=path.join(tmp,d,'manifest.json');if(fs.existsSync(p))manifests.push(p)}if(!manifests.length&&fs.existsSync(path.join(tmp,'manifest.json')))manifests.push(path.join(tmp,'manifest.json'));if(manifests.length!==1)throw new Error('Package must contain one manifest.json');const manifest=JSON.parse(await fsp.readFile(manifests[0],'utf8'));if(manifest.product!=='wolcom'||manifest.type!=='update')throw new Error('Not a Wolcom update package');const base=path.dirname(manifests[0]),sums=path.join(base,'checksums.sha256');if(fs.existsSync(sums))await run('sha256sum',['-c','checksums.sha256'],{cwd:base});await fsp.rm(tmp,{recursive:true,force:true});await state({status:'verified',file,filename:name,sha256:sha,manifest});res.json({ok:true,sha256:sha,manifest,worker_version:workerVersion})}catch(e){res.status(400).json({error:e.message})}});

app.post('/api/install',async(_req,res)=>{const s=await readState();if(!s.file||s.status!=='verified')return res.status(409).json({error:'No verified update ready'});if(s.manifest?.requires_cli===true)return res.status(409).json({error:s.manifest.cli_reason||'Den här uppdateringen måste installeras via CLI.'});res.json({ok:true,status:'starting'});setTimeout(()=>install(s).catch(async e=>state({...s,status:'failed',step:'FAILED',error:String(e.message).slice(-10000)})),50)});

async function install(s){
  await state({...s,status:'installing',step:'EXTRACTING',message:'Packar upp verifierad release'});
  const tmp=path.join('/tmp','wolcom-install-'+crypto.randomUUID());
  await fsp.mkdir(tmp);
  try{
    await run('tar',['-xzf',s.file,'-C',tmp]);let base=tmp;const dirs=await fsp.readdir(tmp);if(dirs.length===1&&fs.statSync(path.join(tmp,dirs[0])).isDirectory())base=path.join(tmp,dirs[0]);const mf=JSON.parse(await fsp.readFile(path.join(base,'manifest.json'),'utf8'));
    const bs={...s,manifest:mf};
    await state({...bs,status:'installing',step:'STARTING',message:'Startar selektiv uppdatering'});
    const output=await runUpdateScript(path.join(base,'update.sh'),{cwd:base,env:{WOLCOM_DIR:root,WOLCOM_WEB_UPDATE:'1'},baseState:bs});
    await run('curl',['-fsS','http://app:3000/api/health'],{cwd:'/tmp'});
    await state({...bs,status:'success',step:'SUCCESS',message:'Healthcheck passed',log_tail:trimLog(output),installed_at:new Date().toISOString()});
  } finally { await fsp.rm(tmp,{recursive:true,force:true}).catch(()=>{}); }
}

async function githubContext(target){target=ghTarget(target);const f=ghFiles(target);const cfg=JSON.parse(await fsp.readFile(f.cfg,'utf8'));const tok=(await fsp.readFile(f.token,'utf8')).trim();if(!cfg.repo||!tok)throw new Error(`GitHub ${target} is not configured`);const tmp=path.join('/tmp','wolcom-gh-'+target+'-'+crypto.randomUUID());await fsp.mkdir(tmp);const ask=path.join(tmp,'askpass.sh');await fsp.writeFile(ask,`#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) cat "$WOLCOM_GH_TOKEN_FILE";; esac\n`,{mode:0o700});return {target,cfg,tok,tmp,ask,tokenFile:f.token,remote:`https://github.com/${cfg.repo}.git`,env:{GIT_ASKPASS:ask,GIT_TERMINAL_PROMPT:'0',WOLCOM_GH_TOKEN_FILE:f.token}}}
app.post('/api/github/test',async(req,res)=>{let c;try{c=await githubContext(req.body?.target);const ar=await fetch(`https://api.github.com/repos/${c.cfg.repo}`,{headers:{authorization:`Bearer ${c.tok}`,'user-agent':'Wolcom-HQ','accept':'application/vnd.github+json'},signal:AbortSignal.timeout(12000)});const aj=await ar.json().catch(()=>({}));if(!ar.ok)throw new Error(`GitHub API ${ar.status}: ${aj.message||'åtkomst nekad'}`);if(aj.permissions&&aj.permissions.push===false)throw new Error('GitHub-token saknar skrivrättighet (Contents: Read and write) för repot');const out=await run('git',['ls-remote','--heads',c.remote],{cwd:'/tmp',env:c.env});await fsp.rm(c.tmp,{recursive:true,force:true});res.json({ok:true,target:c.target,repo:c.cfg.repo,branch:c.cfg.branch||'main',reachable:true,push_permission:aj.permissions?.push!==false,refs:out.trim().split('\n').filter(Boolean).length})}catch(e){if(c?.tmp)await fsp.rm(c.tmp,{recursive:true,force:true}).catch(()=>{});res.status(400).json({error:String(e.message).slice(-3000)})}});
app.post('/api/github/sync',async(req,res)=>{const target=ghTarget(req.body?.target);res.json({ok:true,status:'starting',target});setTimeout(()=>syncGitHub(target).catch(async e=>{const st=await readState();await state({...st,github:{...(st.github||{}),[target]:{status:'failed',error:String(e.message).slice(-5000),time:new Date().toISOString()}}})}),50)});
async function sourceTreeFor(target,tmp){if(target==='cloud')return root;const out=path.join(tmp,'open-source.tar.gz');await run('bash',[path.join(root,'scripts','export-open-source.sh'),out],{cwd:root});const ext=path.join(tmp,'open-source');await fsp.mkdir(ext);await run('tar',['-xzf',out,'-C',ext],{cwd:tmp});const dirs=await fsp.readdir(ext);if(dirs.length!==1)throw new Error('Open-source export produced unexpected structure');return path.join(ext,dirs[0])}
async function syncGitHub(target){target=ghTarget(target);const s=await readState();await run('curl',['-fsS','http://app:3000/api/health'],{cwd:'/tmp'});const c=await githubContext(target),{cfg,tmp,ask,remote}=c;await state({...s,github:{...(s.github||{}),[target]:{status:'syncing',error:null,time:new Date().toISOString()}}});try{await run('git',['ls-remote','--heads',remote],{cwd:'/tmp',env:c.env});try{await run('git',['clone','--depth','1','--branch',cfg.branch||'main',remote,tmp+'/repo'],{cwd:'/tmp',env:c.env})}catch{await run('git',['clone','--depth','1',remote,tmp+'/repo'],{cwd:'/tmp',env:c.env})}const repo=tmp+'/repo';for(const n of await fsp.readdir(repo)){if(n!=='.git')await fsp.rm(path.join(repo,n),{recursive:true,force:true})}const srcRoot=await sourceTreeFor(target,tmp);for(const n of await fsp.readdir(srcRoot)){if(n!=='.git')await fsp.cp(path.join(srcRoot,n),path.join(repo,n),{recursive:true})}await fsp.writeFile(path.join(repo,'.gitignore'),`data/\n.env\nupdate-inbox/\nupdate-backups/\nlivekit/livekit.yaml\n`);await run('git',['add','-A'],{cwd:repo});await run('git',['config','user.name','Wolcom HQ'],{cwd:repo});await run('git',['config','user.email','hq@wolcom.se'],{cwd:repo});const ver=s.manifest?.version||'current';try{await run('git',['commit','-m',`Wolcom ${ver} · ${target}`],{cwd:repo})}catch{}await run('git',['branch','-M',cfg.branch||'main'],{cwd:repo});await run('git',['push','origin',cfg.branch||'main'],{cwd:repo,env:{GIT_ASKPASS:ask,GIT_TERMINAL_PROMPT:'0',WOLCOM_GH_TOKEN_FILE:c.tokenFile}});const st=await readState();await state({...st,github:{...(st.github||{}),[target]:{status:'success',synced_at:new Date().toISOString(),error:null,repo:cfg.repo,branch:cfg.branch||'main'}}})}finally{await fsp.rm(tmp,{recursive:true,force:true}).catch(()=>{})}}

app.listen(port,'0.0.0.0',()=>console.log(`Wolcom updater ${workerVersion} listening on ${port}`));
