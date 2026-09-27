import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getBackupHubStatus, backupHubMetadataHeader} from './backuphub-github-metadata.mjs';

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const fp = v => sha256(v).slice(0,10);
const safe = (a,b) => { try { const A=Buffer.from(String(a),'hex'),B=Buffer.from(String(b),'hex'); return A.length===B.length&&crypto.timingSafeEqual(A,B);} catch{return false} };
const cleanUrl = raw => { const u=new URL(String(raw||'').trim()); if(u.pathname!=='/'||u.search||u.hash) throw new Error('Ange endast BackupHub-klustrets bas-URL'); u.pathname=''; return u.toString().replace(/\/$/,''); };
function enc(secret, master){ const key=crypto.createHash('sha256').update(master).digest(); const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm',key,iv); const body=Buffer.concat([c.update(secret,'utf8'),c.final()]); return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`; }
function dec(payload, master){ const [a,b,c]=String(payload||'').split('.'); const key=crypto.createHash('sha256').update(master).digest(); const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(a,'base64url')); d.setAuthTag(Buffer.from(b,'base64url')); return Buffer.concat([d.update(Buffer.from(c,'base64url')),d.final()]).toString(); }
function run(cmd,args,{cwd,env={}}={}){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd,env:{...process.env,...env}});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('close',code=>code===0?resolve(out):reject(new Error(out||`${cmd} failed (${code})`)))})}

export async function initBackupHub(pool){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backuphub_settings(
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), project_id uuid NOT NULL,
      cluster_url text, cluster_name text, shared_secret_enc text, provisioning_token_hash text,
      desired_copies integer, connected_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS backuphub_nodes(
      node_id text PRIMARY KEY, name text, token_hash text NOT NULL, token_fingerprint text NOT NULL,
      active boolean NOT NULL DEFAULT true, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const {rows}=await pool.query('SELECT project_id FROM backuphub_settings WHERE singleton=true');
  if(!rows[0]) await pool.query('INSERT INTO backuphub_settings(singleton,project_id) VALUES(true,$1)',[crypto.randomUUID()]);
}

export function registerBackupHubRoutes(app,{pool,requireHq,sessionSecret,version}){
  let exportBusy=false; const exportHits=new Map();
  async function settings(){ return (await pool.query('SELECT * FROM backuphub_settings WHERE singleton=true')).rows[0]; }
  async function shared(s){ if(!s?.shared_secret_enc) throw Object.assign(new Error('BackupHub är inte anslutet'),{status:409}); return dec(s.shared_secret_enc,sessionSecret); }
  async function hubFetch(base,route,{method='GET',secret,body}={}){
    const r=await fetch(base+route,{method,headers:{...(secret?{authorization:`Bearer ${secret}`}:{ } ),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    const j=await r.json().catch(()=>({})); if(!r.ok){const e=new Error(j.error||`BackupHub svarade ${r.status}`);e.status=r.status;throw e} return j;
  }
  async function authNode(req,res){
    const tok=String(req.get('authorization')||'').replace(/^Bearer\s+/i,''); if(!tok){res.status(401).json({error:'Unauthorized'});return null}
    const h=sha256(tok), {rows}=await pool.query('SELECT * FROM backuphub_nodes WHERE active=true');
    const node=rows.find(n=>safe(h,n.token_hash)); if(!node){res.status(401).json({error:'Unauthorized'});return null}
    await pool.query('UPDATE backuphub_nodes SET last_used_at=now() WHERE node_id=$1',[node.node_id]); return node;
  }
  app.get('/api/hq/backuphub',requireHq,async(_q,res)=>{const s=await settings();const {rows:nodes}=await pool.query('SELECT node_id,name,token_fingerprint,active,last_used_at,created_at FROM backuphub_nodes ORDER BY name,node_id');res.json({connected:!!s.cluster_url,project_id:s.project_id,cluster_url:s.cluster_url,cluster_name:s.cluster_name,desired_copies:s.desired_copies,nodes})});
  app.post('/api/hq/backuphub/pairing-info',requireHq,async(req,res)=>{try{const url=cleanUrl(req.body.url);if(new URL(url).protocol!=='https:'&&process.env.WOLCOM_BACKUPHUB_ALLOW_HTTP!=='1')return res.status(400).json({error:'BackupHub kräver HTTPS'});const j=await hubFetch(url,'/api/cluster/v1/pairing-info');if(j.protocol!=='BackupHub v1')return res.status(400).json({error:'Servern rapporterar inte BackupHub v1'});res.json({...j,normalized_url:url})}catch(e){res.status(e.status||400).json({error:e.message})}});
  app.post('/api/hq/backuphub/register',requireHq,async(req,res)=>{try{
    const url=cleanUrl(req.body.url), pairing=String(req.body.pairing_code||'').trim(); if(!pairing)return res.status(400).json({error:'Pairingkod krävs'});
    if(new URL(url).protocol!=='https:'&&process.env.WOLCOM_BACKUPHUB_ALLOW_HTTP!=='1')return res.status(400).json({error:'BackupHub kräver HTTPS'});
    const info=await hubFetch(url,'/api/cluster/v1/pairing-info'); if(info.protocol!=='BackupHub v1')throw new Error('Fel BackupHub-protokoll');
    const s=await settings(); const plain=new Map(); const nodeTokens={};
    for(const n of (info.nodes||[])){const t='wbh_'+crypto.randomBytes(32).toString('base64url');plain.set(n.node_id,t);nodeTokens[n.node_id]=t}
    const provision='wbhp_'+crypto.randomBytes(32).toString('base64url');
    const baseUrl=String(req.body.base_url||'').replace(/\/$/,'');
    const payload={pairing_code:pairing,cluster_provisioning_token:provision,project:{project_id:s.project_id,project_name:'Wolcom',base_url:baseUrl,status_url:`${baseUrl}/api/backup/v1/status`,export_url:`${baseUrl}/api/backup/v1/export`,app_version:version,hostname:os.hostname(),server_location:String(req.body.server_location||''),github_url:String(req.body.github_url||''),git_branch:String(req.body.git_branch||'main'),git_commit:String(req.body.git_commit||''),database_engine:'postgresql',backup_format_version:1,includes:['database'],estimated_data_bytes:0},node_tokens:nodeTokens};
    const r=await hubFetch(url,'/api/cluster/v1/register',{method:'POST',body:payload}); if(!r.project_shared_secret)throw new Error('BackupHub returnerade ingen project_shared_secret');
    await pool.query('BEGIN'); try{await pool.query('DELETE FROM backuphub_nodes');for(const n of (info.nodes||[])){const t=plain.get(n.node_id);await pool.query('INSERT INTO backuphub_nodes(node_id,name,token_hash,token_fingerprint) VALUES($1,$2,$3,$4)',[n.node_id,n.name||n.node_id,sha256(t),fp(t)])}await pool.query(`UPDATE backuphub_settings SET cluster_url=$1,cluster_name=$2,shared_secret_enc=$3,provisioning_token_hash=$4,desired_copies=$5,connected_at=now(),updated_at=now() WHERE singleton=true`,[url,info.cluster_name||'BackupHub',enc(r.project_shared_secret,sessionSecret),sha256(provision),r.desired_copies||info.backup_node_count||null]);await pool.query('COMMIT')}catch(e){await pool.query('ROLLBACK');throw e}
    res.json({ok:true,cluster_name:info.cluster_name,node_count:(info.nodes||[]).length});
  }catch(e){res.status(e.status||400).json({error:e.message})}});
  app.get('/api/hq/backuphub/status',requireHq,async(_q,res)=>{try{const s=await settings();res.json(await hubFetch(s.cluster_url,`/api/backup/v1/projects/${s.project_id}/status`,{secret:await shared(s)}))}catch(e){res.status(e.status||502).json({error:e.message})}});
  app.post('/api/hq/backuphub/nodes/:id/rotate',requireHq,async(req,res)=>{try{const s=await settings(), t='wbh_'+crypto.randomBytes(32).toString('base64url');await hubFetch(s.cluster_url,`/api/backup/v1/projects/${s.project_id}/nodes/${encodeURIComponent(req.params.id)}/credentials`,{method:'PUT',secret:await shared(s),body:{token:t,token_fingerprint:fp(t)}});await pool.query('UPDATE backuphub_nodes SET token_hash=$1,token_fingerprint=$2,active=true WHERE node_id=$3',[sha256(t),fp(t),req.params.id]);res.json({ok:true,fingerprint:fp(t)})}catch(e){res.status(e.status||502).json({error:e.message})}});
  app.post('/api/hq/backuphub/nodes/:id/revoke',requireHq,async(req,res)=>{await pool.query('UPDATE backuphub_nodes SET active=false WHERE node_id=$1',[req.params.id]);res.json({ok:true})});
  app.delete('/api/hq/backuphub',requireHq,async(_q,res)=>{try{const s=await settings();if(s.cluster_url&&s.shared_secret_enc)await hubFetch(s.cluster_url,`/api/backup/v1/projects/${s.project_id}`,{method:'DELETE',secret:await shared(s)});await pool.query('UPDATE backuphub_nodes SET active=false');await pool.query('UPDATE backuphub_settings SET cluster_url=NULL,cluster_name=NULL,shared_secret_enc=NULL,provisioning_token_hash=NULL,desired_copies=NULL,updated_at=now() WHERE singleton=true');res.json({ok:true})}catch(e){res.status(e.status||502).json({error:e.message})}});

  async function provision(req,res){const tok=String(req.get('authorization')||'').replace(/^Bearer\s+/i,'');const s=await settings();if(!tok||!s.provisioning_token_hash||!safe(sha256(tok),s.provisioning_token_hash))return res.status(401).json({error:'Unauthorized'});const id=String(req.body.node_id||'').trim(),name=String(req.body.node_name||id).trim();if(!id)return res.status(400).json({error:'node_id required'});const ex=(await pool.query('SELECT active FROM backuphub_nodes WHERE node_id=$1',[id])).rows[0];if(ex?.active)return res.status(409).json({error:'Node already active'});const nt='wbh_'+crypto.randomBytes(32).toString('base64url');await pool.query(`INSERT INTO backuphub_nodes(node_id,name,token_hash,token_fingerprint,active) VALUES($1,$2,$3,$4,true) ON CONFLICT(node_id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,token_fingerprint=excluded.token_fingerprint,active=true`,[id,name,sha256(nt),fp(nt)]);res.json({node_id:id,node_name:name,token:nt,token_fingerprint:fp(nt)})}
  app.post('/api/backup/v1/cluster/nodes/provision',provision);

  app.get('/api/backup/v1/status',async(req,res)=>{const node=await authNode(req,res);if(!node)return;const s=await settings();const source=await getBackupHubStatus(version);res.json({project_name:'Wolcom',project_id:s.project_id,installation_id:s.project_id,app_version:version,installed_version:source.installed_version,github_sync:source.github_sync,hostname:os.hostname(),server_name:os.hostname(),server_location:'',github_url:'',git_branch:'main',git_commit:'',database_engine:'postgresql',backup_format_version:1,includes:['database'],estimated_data_bytes:0,backup_ready:true,capabilities:{remote_update:false}})});
  app.get('/api/backup/v1/export',async(req,res)=>{const node=await authNode(req,res);if(!node)return;const now=Date.now(),hits=(exportHits.get(node.node_id)||[]).filter(t=>now-t<3600_000);if(hits.length>=4)return res.status(429).json({error:'Too many exports'});if(exportBusy)return res.status(429).json({error:'Export already running'});hits.push(now);exportHits.set(node.node_id,hits);exportBusy=true;let tmp;try{
    tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'wolcom-backup-'));const root=path.join(tmp,'backup');await fsp.mkdir(path.join(root,'database'),{recursive:true});await fsp.mkdir(path.join(root,'metadata'),{recursive:true});
    const dump=path.join(root,'database','database.dump');await run('pg_dump',['-Fc','--exclude-table-data=cloud_billing_config','-f',dump],{env:{PGHOST:process.env.PGHOST||'db',PGPORT:process.env.PGPORT||'5432',PGUSER:process.env.POSTGRES_USER||'',PGPASSWORD:process.env.POSTGRES_PASSWORD||'',PGDATABASE:process.env.POSTGRES_DB||''}});
    const dumpSha=sha256(await fsp.readFile(dump));const s=await settings();const manifest={project_name:'Wolcom',project_id:s.project_id,created_at:new Date().toISOString(),backup_format_version:1,database_engine:'postgresql',database_dump_format:'pg_dump custom -Fc',included_paths:['database/database.dump'],excluded_paths:['.env','secrets','private keys','Docker socket/data','node_modules','cache','logs','Git source'],git_commit:'',app_version:version,sha256:{'database/database.dump':dumpSha}};await fsp.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));await fsp.writeFile(path.join(root,'metadata','git-info.json'),JSON.stringify({branch:'main',commit:''},null,2));await fsp.writeFile(path.join(root,'metadata','sanitized-config.json'),JSON.stringify({database_engine:'postgresql',backup_format_version:1},null,2));await fsp.writeFile(path.join(root,'restore-notes.txt'),'See docs/BACKUP_RESTORE.md in the Wolcom source tree. Secrets and BackupHub credentials are intentionally excluded.\n');
    const archive=path.join(tmp,'wolcom-backup.tar.gz');await run('tar',['-czf',archive,'-C',tmp,'backup']);const body=await fsp.readFile(archive),sum=sha256(body);res.setHeader('Content-Type','application/gzip');res.setHeader('Content-Disposition',`attachment; filename="wolcom-backup-${new Date().toISOString().slice(0,10)}.tar.gz"`);res.setHeader('Content-Length',String(body.length));res.setHeader('X-Backup-SHA256',sum);res.setHeader('X-BackupHub-Metadata',await backupHubMetadataHeader(version));res.end(body);
  }catch(e){console.error('Backup export failed:',e.message);if(!res.headersSent)res.status(500).json({error:'Backup export failed'})}finally{exportBusy=false;if(tmp)await fsp.rm(tmp,{recursive:true,force:true}).catch(()=>{})}});

}
