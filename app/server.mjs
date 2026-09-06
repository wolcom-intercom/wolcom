import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AccessToken } from 'livekit-server-sdk';
import { initBackupHub, registerBackupHubRoutes } from './backuphub.mjs';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const version = process.env.WOLCOM_VERSION || 'dev';
const livekitUrl = process.env.LIVEKIT_URL || '';
const adminUser = process.env.WOLCOM_ADMIN_USER || 'admin';
const adminPassword = process.env.WOLCOM_ADMIN_PASSWORD || '';
const sessionSecret = process.env.WOLCOM_SESSION_SECRET || process.env.LIVEKIT_API_SECRET || 'change-me';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const updaterUrl=process.env.WOLCOM_UPDATER_URL||'http://updater:8096';
const updaterToken=process.env.WOLCOM_UPDATER_TOKEN||'';
let cloudHooks={canCreateEvent:async()=>({ok:true})};

app.set('trust proxy', 1);
app.use('/api/hq/update/upload', express.raw({type:['application/gzip','application/x-gzip','application/octet-stream'],limit:'250mb'}));
app.use('/api/hq/branding/logo', express.raw({type:['image/png','image/jpeg','image/webp','application/octet-stream'],limit:'2mb'}));
app.use('/api/hq/branding/favicon', express.raw({type:['image/png','image/x-icon','image/vnd.microsoft.icon','application/octet-stream'],limit:'512kb'}));
// Stripe must receive the exact raw request body for webhook signature verification.
app.use('/api/cloud/stripe/webhook', express.raw({type:'application/json',limit:'2mb'}));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/vendor/livekit', express.static('/app/node_modules/livekit-client/dist'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function hashSecret(value, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(value), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifySecret(value, encoded) {
  try {
    const [salt, expected] = String(encoded).split(':');
    const actual = crypto.scryptSync(String(value), salt, 32);
    const exp = Buffer.from(expected, 'hex');
    return actual.length === exp.length && crypto.timingSafeEqual(actual, exp);
  } catch { return false; }
}
function safeEq(a,b){
  const A=Buffer.from(String(a)); const B=Buffer.from(String(b));
  return A.length===B.length && crypto.timingSafeEqual(A,B);
}
function cookieMap(req){
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('='); return i<0?[v,'']:[v.slice(0,i),decodeURIComponent(v.slice(i+1))]}));
}
function signedSession(data, exp = Date.now()+12*3600_000){
  const payload = Buffer.from(JSON.stringify({...data,e:exp})).toString('base64url');
  const sig = crypto.createHmac('sha256',sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(req,cookie){
  try {
    const tok=cookieMap(req)[cookie] || '';
    const [payload,sig]=tok.split('.');
    if(!payload||!sig) return null;
    const expected=crypto.createHmac('sha256',sessionSecret).update(payload).digest('base64url');
    if(!safeEq(sig,expected)) return null;
    const data=JSON.parse(Buffer.from(payload,'base64url').toString());
    return Number(data.e)>Date.now()?data:null;
  } catch { return null; }
}
function hqSession(req){const s=readSession(req,'wolcom_hq'); return s?.type==='hq'?s:null;}
async function getHqUser(req){
  const s=hqSession(req); if(!s) return null;
  if(s.legacy===true && s.user===adminUser) return {id:'legacy',name:'Bootstrap admin',email:adminUser,username:adminUser,role:'owner',active:true,legacy:true};
  if(!s.uid) return null;
  const {rows}=await pool.query('SELECT id,name,email,username,role,active,last_login,created_at FROM hq_users WHERE id=$1',[s.uid]);
  return rows[0]?.active?rows[0]:null;
}
function requireHq(req,res,next){getHqUser(req).then(u=>{if(!u)return res.status(401).json({error:'Unauthorized'});req.hqUser=u;next()}).catch(next)}
function requireOwner(req,res,next){requireHq(req,res,()=>{if(req.hqUser?.role!=='owner')return res.status(403).json({error:'Owner-behörighet krävs'});next()})}

async function portalSession(req){
  const s=readSession(req,'wolcom_portal'); if(s?.type!=='portal'||!s.uid) return null;
  const {rows}=await pool.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.organization_id,o.name organization_name,o.slug organization_slug,o.active organization_active
    FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1`,[s.uid]);
  return rows[0]?.active&&rows[0]?.organization_active?rows[0]:null;
}
function requirePortal(req,res,next){portalSession(req).then(u=>{if(!u)return res.status(401).json({error:'Unauthorized'});req.portalUser=u;next()}).catch(next)}
function requireCustomerAdmin(req,res,next){requirePortal(req,res,()=>{if(!['org_admin','customer_admin'].includes(req.portalUser?.role))return res.status(403).json({error:'Customer Admin-behörighet krävs'});next()})}
function slugify(s){ return String(s||'').toLowerCase().trim().replace(/å/g,'a').replace(/ä/g,'a').replace(/ö/g,'o').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64); }
function normalizeEmail(s){return String(s||'').trim().toLowerCase().slice(0,180)}
function eventPayload(body){
  const name=String(body.name||'').trim().slice(0,100); const slug=slugify(body.slug||name); const pin=String(body.pin||'').trim();
  const channels=Array.isArray(body.channels)?body.channels.map(x=>String(x).trim()).filter(Boolean).slice(0,32):[];
  return {name,slug,pin,channels};
}
async function createEvent(orgId,body,{bypassBilling=false}={}){
  const {name,slug,pin,channels}=eventPayload(body);
  if(!bypassBilling){const gate=await cloudHooks.canCreateEvent(orgId);if(!gate?.ok){const e=new Error(gate?.error||'Planen tillåter inte nya event');e.status=402;throw e;}}
  if(!name||!slug||pin.length<4) {const e=new Error('Name, slug and PIN (min 4 chars) are required');e.status=400;throw e;}
  const id=crypto.randomUUID();
  try{
    await pool.query('BEGIN');
    await pool.query('INSERT INTO events(id,name,slug,pin_hash,organization_id) VALUES($1,$2,$3,$4,$5)',[id,name,slug,hashSecret(pin),orgId]);
    for(const [i,ch] of channels.entries()) await pool.query('INSERT INTO channels(id,event_id,name,position) VALUES($1,$2,$3,$4)',[crypto.randomUUID(),id,ch.slice(0,80),i]);
    await pool.query('COMMIT'); return {id,name,slug};
  }catch(e){await pool.query('ROLLBACK');if(e.code==='23505'){e.status=409;e.message='Slug already exists'}throw e}
}

async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      kind text NOT NULL DEFAULT 'customer',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'org_admin',
      active boolean NOT NULL DEFAULT true,
      last_login timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text UNIQUE NOT NULL,
      pin_hash text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS channels (
      id uuid PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS hq_users (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      email text UNIQUE NOT NULL,
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'admin',
      active boolean NOT NULL DEFAULT true,
      last_login timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS branding_settings (
      id integer PRIMARY KEY CHECK (id=1),
      logo_data bytea,
      logo_mime text,
      logo_name text,
      favicon_data bytea,
      favicon_mime text,
      favicon_name text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS customer_number text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS organization_number text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_name text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_phone text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_address text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS notes text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'event'; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'manual'; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_events integer; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_participants integer;`);
  let ir=await pool.query(`SELECT id FROM organizations WHERE slug='wolcom'`);
  let internalId=ir.rows[0]?.id;
  if(!internalId){internalId=crypto.randomUUID();await pool.query(`INSERT INTO organizations(id,name,slug,kind) VALUES($1,'Wolcom','wolcom','internal')`,[internalId]);}
  await pool.query(`UPDATE events SET organization_id=$1 WHERE organization_id IS NULL`,[internalId]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM events');
  if(rows[0].n===0){
    const eventId=crypto.randomUUID();
    await pool.query('INSERT INTO events(id,name,slug,pin_hash,organization_id) VALUES($1,$2,$3,$4,$5)',[eventId,'Wolcom Demo','demo',hashSecret('2468'),internalId]);
    for(const [i,name] of ['Producer','Audio','Lighting','Video','Stage Manager'].entries())
      await pool.query('INSERT INTO channels(id,event_id,name,position) VALUES($1,$2,$3,$4)',[crypto.randomUUID(),eventId,name,i]);
    console.log('Demo event created: /demo PIN 2468');
  }
}


const LOGO_MIMES=new Set(['image/png','image/jpeg','image/webp']);
const FAVICON_MIMES=new Set(['image/png','image/x-icon','image/vnd.microsoft.icon']);
async function brandingRow(){
  const {rows}=await pool.query(`SELECT logo_mime,logo_name,octet_length(logo_data) logo_bytes,favicon_mime,favicon_name,octet_length(favicon_data) favicon_bytes,updated_at FROM branding_settings WHERE id=1`);
  return rows[0]||{};
}
app.get('/api/branding',async (_req,res)=>{try{const b=await brandingRow();res.json({has_logo:!!b.logo_bytes,logo_name:b.logo_name||null,logo_mime:b.logo_mime||null,logo_bytes:Number(b.logo_bytes||0),has_favicon:!!b.favicon_bytes,favicon_name:b.favicon_name||null,favicon_mime:b.favicon_mime||null,favicon_bytes:Number(b.favicon_bytes||0),updated_at:b.updated_at||null,logo_url:'/branding/logo',favicon_url:'/branding/favicon'});}catch(e){res.status(500).json({error:'Branding unavailable'})}});
app.get('/branding/logo',async (_req,res)=>{try{const {rows}=await pool.query('SELECT logo_data,logo_mime,updated_at FROM branding_settings WHERE id=1');const b=rows[0];if(!b?.logo_data)return res.status(404).end();res.setHeader('Content-Type',b.logo_mime||'image/png');res.setHeader('Cache-Control','public,max-age=300');res.send(b.logo_data)}catch{res.status(404).end()}});
app.get('/branding/favicon',async (_req,res)=>{try{const {rows}=await pool.query('SELECT favicon_data,favicon_mime FROM branding_settings WHERE id=1');const b=rows[0];if(!b?.favicon_data)return res.status(404).end();res.setHeader('Content-Type',b.favicon_mime||'image/png');res.setHeader('Cache-Control','public,max-age=300');res.send(b.favicon_data)}catch{res.status(404).end()}});
app.get('/api/hq/branding',requireHq,async (_req,res)=>{res.json(await brandingRow())});
app.post('/api/hq/branding/logo',requireHq,async (req,res)=>{const mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();const name=String(req.headers['x-file-name']||'logo').slice(0,180);if(!Buffer.isBuffer(req.body)||req.body.length<16)return res.status(400).json({error:'Tom eller ogiltig logotypfil'});if(req.body.length>2*1024*1024)return res.status(413).json({error:'Logotypen får vara max 2 MB'});if(!LOGO_MIMES.has(mime))return res.status(415).json({error:'Logotyp måste vara PNG, JPG eller WebP'});await pool.query(`INSERT INTO branding_settings(id,logo_data,logo_mime,logo_name,updated_at) VALUES(1,$1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET logo_data=EXCLUDED.logo_data,logo_mime=EXCLUDED.logo_mime,logo_name=EXCLUDED.logo_name,updated_at=now()`,[req.body,mime,name]);res.json({ok:true,name,mime,bytes:req.body.length})});
app.delete('/api/hq/branding/logo',requireHq,async (_req,res)=>{await pool.query(`INSERT INTO branding_settings(id,updated_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET logo_data=NULL,logo_mime=NULL,logo_name=NULL,updated_at=now()`);res.json({ok:true})});
app.post('/api/hq/branding/favicon',requireHq,async (req,res)=>{let mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(mime==='application/octet-stream')mime='image/x-icon';const name=String(req.headers['x-file-name']||'favicon').slice(0,180);if(!Buffer.isBuffer(req.body)||req.body.length<4)return res.status(400).json({error:'Tom eller ogiltig faviconfil'});if(req.body.length>512*1024)return res.status(413).json({error:'Favicon får vara max 512 KB'});if(!FAVICON_MIMES.has(mime))return res.status(415).json({error:'Favicon måste vara PNG eller ICO'});await pool.query(`INSERT INTO branding_settings(id,favicon_data,favicon_mime,favicon_name,updated_at) VALUES(1,$1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET favicon_data=EXCLUDED.favicon_data,favicon_mime=EXCLUDED.favicon_mime,favicon_name=EXCLUDED.favicon_name,updated_at=now()`,[req.body,mime,name]);res.json({ok:true,name,mime,bytes:req.body.length})});
app.delete('/api/hq/branding/favicon',requireHq,async (_req,res)=>{await pool.query(`INSERT INTO branding_settings(id,updated_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET favicon_data=NULL,favicon_mime=NULL,favicon_name=NULL,updated_at=now()`);res.json({ok:true})});

app.get('/api/health', async (_req,res)=>{
  try { await pool.query('SELECT 1'); res.json({ok:true,service:'wolcom',version,livekit:livekitUrl}); }
  catch { res.status(503).json({ok:false,service:'wolcom',version,error:'database unavailable'}); }
});
app.get('/api/public/event/:slug', async (req,res)=>{
  const {rows}=await pool.query(`SELECT e.name,e.slug,e.active,o.name organization_name FROM events e JOIN organizations o ON o.id=e.organization_id WHERE e.slug=$1`,[req.params.slug]);
  if(!rows[0]||!rows[0].active) return res.status(404).json({error:'Event not found'});
  res.json(rows[0]);
});
app.post('/api/join/:slug', async (req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,48); const pin=String(req.body.pin||'').trim();
  if(!name) return res.status(400).json({error:'Name required'});
  const {rows}=await pool.query(`SELECT e.*,o.name organization_name FROM events e JOIN organizations o ON o.id=e.organization_id WHERE e.slug=$1 AND e.active=true AND o.active=true`,[req.params.slug]);
  const event=rows[0];
  if(!event || !verifySecret(pin,event.pin_hash)) return res.status(401).json({error:'Wrong PIN or inactive event'});
  const cr=await pool.query('SELECT id,name,position FROM channels WHERE event_id=$1 ORDER BY position,name',[event.id]);
  const identity=`${name.replace(/[^\p{L}\p{N}_. -]/gu,'').slice(0,32)}-${crypto.randomBytes(3).toString('hex')}`;
  const at=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity,name,ttl:'8h'});
  at.addGrant({roomJoin:true,room:`event-${event.id}`,canPublish:true,canSubscribe:true,canPublishData:true});
  res.json({token:await at.toJwt(),livekitUrl,event:{id:event.id,name:event.name,slug:event.slug,organization_name:event.organization_name},channels:cr.rows,identity});
});

// Customer / renter portal
app.post('/api/portal/login',async (req,res)=>{
  const email=normalizeEmail(req.body.email); const password=String(req.body.password||'');
  const {rows}=await pool.query(`SELECT u.id,u.password_hash,u.active,o.active organization_active FROM users u JOIN organizations o ON o.id=u.organization_id WHERE lower(u.email)=$1`,[email]);
  const u=rows[0]; if(!u||!u.active||!u.organization_active||!verifySecret(password,u.password_hash)) return res.status(401).json({error:'Wrong email or password'});
  await pool.query('UPDATE users SET last_login=now() WHERE id=$1',[u.id]);
  res.setHeader('Set-Cookie',`wolcom_portal=${encodeURIComponent(signedSession({type:'portal',uid:u.id}))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
  res.json({ok:true});
});
app.post('/api/portal/logout',(_req,res)=>{res.setHeader('Set-Cookie','wolcom_portal=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');res.json({ok:true})});
app.get('/api/portal/me',async (req,res)=>{const u=await portalSession(req);res.json({authenticated:!!u,user:u?{id:u.id,name:u.name,email:u.email,role:u.role,organization:{id:u.organization_id,name:u.organization_name,slug:u.organization_slug}}:null,version})});
app.get('/api/portal/events',requirePortal,async (req,res)=>{
  const {rows}=await pool.query(`SELECT e.id,e.name,e.slug,e.active,e.created_at,count(c.id)::int channel_count FROM events e LEFT JOIN channels c ON c.event_id=e.id WHERE e.organization_id=$1 GROUP BY e.id ORDER BY e.created_at DESC`,[req.portalUser.organization_id]);res.json(rows)
});
app.post('/api/portal/events',requireCustomerAdmin,async (req,res)=>{try{res.status(201).json(await createEvent(req.portalUser.organization_id,req.body))}catch(e){res.status(e.status||500).json({error:e.message||'Could not create event'})}});
app.get('/api/portal/events/:id',requirePortal,async (req,res)=>{
  const er=await pool.query('SELECT id,name,slug,active,created_at FROM events WHERE id=$1 AND organization_id=$2',[req.params.id,req.portalUser.organization_id]); if(!er.rows[0])return res.status(404).json({error:'Not found'});
  const cr=await pool.query('SELECT id,name,position FROM channels WHERE event_id=$1 ORDER BY position,name',[req.params.id]);res.json({...er.rows[0],channels:cr.rows})
});
app.patch('/api/portal/events/:id',requirePortal,async (req,res)=>{
  const f=await pool.query('SELECT id FROM events WHERE id=$1 AND organization_id=$2',[req.params.id,req.portalUser.organization_id]);if(!f.rows[0])return res.status(404).json({error:'Not found'});
  if(typeof req.body.active==='boolean')await pool.query('UPDATE events SET active=$1 WHERE id=$2',[req.body.active,req.params.id]);
  if(String(req.body.pin||'').trim().length>=4)await pool.query('UPDATE events SET pin_hash=$1 WHERE id=$2',[hashSecret(String(req.body.pin).trim()),req.params.id]);res.json({ok:true})
});
app.post('/api/portal/events/:id/channels',requirePortal,async (req,res)=>{
  const f=await pool.query('SELECT id FROM events WHERE id=$1 AND organization_id=$2',[req.params.id,req.portalUser.organization_id]);if(!f.rows[0])return res.status(404).json({error:'Not found'});
  const name=String(req.body.name||'').trim().slice(0,80);if(!name)return res.status(400).json({error:'Name required'});const {rows}=await pool.query('SELECT coalesce(max(position),-1)+1 AS p FROM channels WHERE event_id=$1',[req.params.id]);const id=crypto.randomUUID();await pool.query('INSERT INTO channels(id,event_id,name,position) VALUES($1,$2,$3,$4)',[id,req.params.id,name,rows[0].p]);res.status(201).json({id,name})
});
app.delete('/api/portal/events/:eventId/channels/:channelId',requirePortal,async (req,res)=>{
  const f=await pool.query('SELECT id FROM events WHERE id=$1 AND organization_id=$2',[req.params.eventId,req.portalUser.organization_id]);if(!f.rows[0])return res.status(404).json({error:'Not found'});await pool.query('DELETE FROM channels WHERE id=$1 AND event_id=$2',[req.params.channelId,req.params.eventId]);res.json({ok:true})
});


app.get('/api/portal/users',requireCustomerAdmin,async(req,res)=>{
  const {rows}=await pool.query(`SELECT id,name,email,role,active,last_login,created_at FROM users WHERE organization_id=$1 ORDER BY active DESC,name`,[req.portalUser.organization_id]);
  res.json(rows)
});
app.post('/api/portal/users',requireCustomerAdmin,async(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),password=String(req.body.password||''),role=String(req.body.role||'event_admin');
  if(!name||!email||password.length<8)return res.status(400).json({error:'Namn, e-post och lösenord (minst 8 tecken) krävs'});
  if(!['customer_admin','event_admin'].includes(role))return res.status(400).json({error:'Ogiltig kundroll'});
  try{const id=crypto.randomUUID();await pool.query(`INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)`,[id,req.portalUser.organization_id,name,email,hashSecret(password),role]);res.status(201).json({id,name,email,role})}
  catch(e){if(e.code==='23505')return res.status(409).json({error:'E-postadressen används redan'});throw e}
});
app.patch('/api/portal/users/:id',requireCustomerAdmin,async(req,res)=>{
  const current=(await pool.query('SELECT id,role,active FROM users WHERE id=$1 AND organization_id=$2',[req.params.id,req.portalUser.organization_id])).rows[0];
  if(!current)return res.status(404).json({error:'Användaren finns inte'});
  const fields=[],vals=[];
  if(Object.hasOwn(req.body,'name')){vals.push(String(req.body.name||'').trim().slice(0,100));fields.push(`name=$${vals.length}`)}
  if(Object.hasOwn(req.body,'email')){vals.push(normalizeEmail(req.body.email));fields.push(`email=$${vals.length}`)}
  if(Object.hasOwn(req.body,'role')){const role=String(req.body.role);if(!['customer_admin','event_admin'].includes(role))return res.status(400).json({error:'Ogiltig kundroll'});vals.push(role);fields.push(`role=$${vals.length}`)}
  if(Object.hasOwn(req.body,'active')){vals.push(!!req.body.active);fields.push(`active=$${vals.length}`)}
  if(!fields.length)return res.json({ok:true}); vals.push(req.params.id,req.portalUser.organization_id);
  try{await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length-1} AND organization_id=$${vals.length}`,vals);res.json({ok:true})}catch(e){if(e.code==='23505')return res.status(409).json({error:'E-postadressen används redan'});throw e}
});
app.post('/api/portal/users/:id/password',requireCustomerAdmin,async(req,res)=>{
  const password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'Lösenordet måste vara minst 8 tecken'});
  const r=await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND organization_id=$3',[hashSecret(password),req.params.id,req.portalUser.organization_id]);
  if(!r.rowCount)return res.status(404).json({error:'Användaren finns inte'});res.json({ok:true})
});

// Wolcom HQ
app.post('/api/hq/login',async (req,res)=>{
  const login=normalizeEmail(req.body.user||''); const password=String(req.body.password||'');
  const {rows}=await pool.query(`SELECT id,name,email,username,password_hash,role,active FROM hq_users WHERE lower(email)=$1 OR lower(username)=$1 LIMIT 1`,[login]);
  const u=rows[0];
  if(u && u.active && verifySecret(password,u.password_hash)){
    await pool.query('UPDATE hq_users SET last_login=now() WHERE id=$1',[u.id]);
    res.setHeader('Set-Cookie',`wolcom_hq=${encodeURIComponent(signedSession({type:'hq',uid:u.id}))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
    return res.json({ok:true,user:{id:u.id,name:u.name,email:u.email,username:u.username,role:u.role}});
  }
  if(adminPassword && safeEq(req.body.user||'',adminUser) && safeEq(password,adminPassword)){
    res.setHeader('Set-Cookie',`wolcom_hq=${encodeURIComponent(signedSession({type:'hq',legacy:true,user:adminUser}))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
    return res.json({ok:true,user:{name:'Bootstrap admin',username:adminUser,role:'owner',legacy:true}});
  }
  return res.status(401).json({error:'Fel användarnamn/e-post eller lösenord'});
});
app.post('/api/hq/logout',(_req,res)=>{res.setHeader('Set-Cookie','wolcom_hq=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');res.json({ok:true})});
app.get('/api/hq/me',async (req,res)=>{const u=await getHqUser(req);res.json({authenticated:!!u,user:u||null,version})});

app.get('/api/hq/users',requireHq,async (_req,res)=>{
  const {rows}=await pool.query(`SELECT id,name,email,username,role,active,last_login,created_at FROM hq_users ORDER BY active DESC,name`);
  res.json({users:rows,bootstrap:{username:adminUser,configured:!!adminPassword}})
});
app.post('/api/hq/users',requireOwner,async (req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),username=String(req.body.username||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,60),password=String(req.body.password||''),role=String(req.body.role||'admin');
  if(!name||!email||!username||password.length<10)return res.status(400).json({error:'Namn, e-post, användarnamn och lösenord (minst 10 tecken) krävs'});
  if(!['owner','admin','support'].includes(role))return res.status(400).json({error:'Ogiltig HQ-roll'});
  try{const id=crypto.randomUUID();await pool.query(`INSERT INTO hq_users(id,name,email,username,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)`,[id,name,email,username,hashSecret(password),role]);res.status(201).json({id,name,email,username,role})}
  catch(e){if(e.code==='23505')return res.status(409).json({error:'E-post eller användarnamn finns redan'});throw e}
});
app.patch('/api/hq/users/:id',requireHq,async (req,res)=>{
  const current=(await pool.query('SELECT id,role,active FROM hq_users WHERE id=$1',[req.params.id])).rows[0]; if(!current)return res.status(404).json({error:'HQ-användaren finns inte'});
  if(Object.hasOwn(req.body,'role') && req.hqUser.role!=='owner') return res.status(403).json({error:'Endast Owner kan ändra HQ-roll'});
  if(Object.hasOwn(req.body,'active') && req.hqUser.role!=='owner') return res.status(403).json({error:'Endast Owner kan aktivera/inaktivera HQ-användare'});
  const nextRole=Object.hasOwn(req.body,'role')?String(req.body.role):current.role, nextActive=Object.hasOwn(req.body,'active')?!!req.body.active:current.active;
  if(current.role==='owner' && current.active && (nextRole!=='owner'||!nextActive)){const c=(await pool.query("SELECT count(*)::int n FROM hq_users WHERE role='owner' AND active=true")).rows[0].n;if(c<=1)return res.status(409).json({error:'Den sista aktiva Owner-användaren kan inte nedgraderas eller stängas av'});}
  const fields=[],vals=[];
  for(const k of ['name','email','username','role','active']) if(Object.hasOwn(req.body,k)){
    let v=req.body[k]; if(k==='email')v=normalizeEmail(v); if(k==='username')v=String(v||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,60); if(k==='role'&&!['owner','admin','support'].includes(String(v)))return res.status(400).json({error:'Ogiltig HQ-roll'});
    vals.push(v); fields.push(`${k}=$${vals.length}`)
  }
  if(!fields.length)return res.json({ok:true}); vals.push(req.params.id);
  try{await pool.query(`UPDATE hq_users SET ${fields.join(',')} WHERE id=$${vals.length}`,vals);res.json({ok:true})}catch(e){if(e.code==='23505')return res.status(409).json({error:'E-post eller användarnamn finns redan'});throw e}
});
app.post('/api/hq/users/:id/password',requireHq,async (req,res)=>{const password=String(req.body.password||'');if(password.length<10)return res.status(400).json({error:'Lösenordet måste vara minst 10 tecken'});await pool.query('UPDATE hq_users SET password_hash=$1 WHERE id=$2',[hashSecret(password),req.params.id]);res.json({ok:true})});

app.get('/api/hq/organizations',requireHq,async (_req,res)=>{const {rows}=await pool.query(`SELECT o.*,count(DISTINCT u.id)::int user_count,count(DISTINCT e.id)::int event_count FROM organizations o LEFT JOIN users u ON u.organization_id=o.id LEFT JOIN events e ON e.organization_id=o.id GROUP BY o.id ORDER BY (o.kind='internal') DESC,o.name`);res.json(rows)});
app.post('/api/hq/organizations',requireHq,async (req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),slug=slugify(req.body.slug||name);if(!name||!slug)return res.status(400).json({error:'Name required'});try{const id=crypto.randomUUID(),cn=String(req.body.customer_number||'').trim().slice(0,40),on=String(req.body.organization_number||'').trim().slice(0,40),ce=normalizeEmail(req.body.contact_email),be=normalizeEmail(req.body.billing_email);await pool.query(`INSERT INTO organizations(id,name,slug,kind,customer_number,organization_number,contact_name,contact_email,contact_phone,billing_email,billing_address,notes,plan,subscription_status,max_events,max_participants) VALUES($1,$2,$3,'customer',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[id,name,slug,cn,on,String(req.body.contact_name||'').slice(0,100),ce,String(req.body.contact_phone||'').slice(0,60),be,String(req.body.billing_address||'').slice(0,500),String(req.body.notes||'').slice(0,2000),String(req.body.plan||'event').slice(0,40),String(req.body.subscription_status||'manual').slice(0,40),req.body.max_events?Number(req.body.max_events):null,req.body.max_participants?Number(req.body.max_participants):null]);res.status(201).json({id,name,slug})}catch(e){if(e.code==='23505')return res.status(409).json({error:'Customer slug already exists'});throw e}});
app.patch('/api/hq/organizations/:id',requireHq,async(req,res)=>{const allowed=['name','customer_number','organization_number','contact_name','contact_email','contact_phone','billing_email','billing_address','notes','plan','subscription_status','max_events','max_participants','active'];const sets=[],vals=[];for(const k of allowed)if(Object.hasOwn(req.body,k)){vals.push(req.body[k]===''?null:req.body[k]);sets.push(`${k}=$${vals.length}`)}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE organizations SET ${sets.join(',')} WHERE id=$${vals.length}`,vals);res.json({ok:true})});
app.get('/api/hq/organizations/:id/users',requireHq,async(req,res)=>{const {rows}=await pool.query(`SELECT id,name,email,role,active,last_login,created_at FROM users WHERE organization_id=$1 ORDER BY active DESC,name`,[req.params.id]);res.json(rows)});
app.post('/api/hq/organizations/:id/users',requireHq,async (req,res)=>{const name=String(req.body.name||'').trim().slice(0,100),email=normalizeEmail(req.body.email),password=String(req.body.password||''),role=String(req.body.role||'customer_admin');if(!name||!email||password.length<8)return res.status(400).json({error:'Namn, e-post och lösenord (minst 8 tecken) krävs'});if(!['customer_admin','event_admin'].includes(role))return res.status(400).json({error:'Ogiltig kundroll'});try{const id=crypto.randomUUID();await pool.query(`INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)`,[id,req.params.id,name,email,hashSecret(password),role]);res.status(201).json({id,name,email,role})}catch(e){if(e.code==='23505')return res.status(409).json({error:'E-postadressen används redan'});throw e}});
app.patch('/api/hq/organizations/:orgId/users/:userId',requireHq,async(req,res)=>{const current=(await pool.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2',[req.params.userId,req.params.orgId])).rows[0];if(!current)return res.status(404).json({error:'Kundanvändaren finns inte'});const fields=[],vals=[];if(Object.hasOwn(req.body,'name')){vals.push(String(req.body.name||'').trim().slice(0,100));fields.push(`name=$${vals.length}`)}if(Object.hasOwn(req.body,'email')){vals.push(normalizeEmail(req.body.email));fields.push(`email=$${vals.length}`)}if(Object.hasOwn(req.body,'role')){const role=String(req.body.role);if(!['customer_admin','event_admin'].includes(role))return res.status(400).json({error:'Ogiltig kundroll'});vals.push(role);fields.push(`role=$${vals.length}`)}if(Object.hasOwn(req.body,'active')){vals.push(!!req.body.active);fields.push(`active=$${vals.length}`)}if(!fields.length)return res.json({ok:true});vals.push(req.params.userId,req.params.orgId);try{await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length-1} AND organization_id=$${vals.length}`,vals);res.json({ok:true})}catch(e){if(e.code==='23505')return res.status(409).json({error:'E-postadressen används redan'});throw e}});
app.post('/api/hq/organizations/:orgId/users/:userId/password',requireHq,async(req,res)=>{const password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'Lösenordet måste vara minst 8 tecken'});const r=await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND organization_id=$3',[hashSecret(password),req.params.userId,req.params.orgId]);if(!r.rowCount)return res.status(404).json({error:'Kundanvändaren finns inte'});res.json({ok:true})});
app.get('/api/hq/events',requireHq,async (_req,res)=>{const {rows}=await pool.query(`SELECT e.id,e.name,e.slug,e.active,e.created_at,e.organization_id,o.name organization_name,o.kind organization_kind,count(c.id)::int channel_count FROM events e JOIN organizations o ON o.id=e.organization_id LEFT JOIN channels c ON c.event_id=e.id GROUP BY e.id,o.id ORDER BY e.created_at DESC`);res.json(rows)});
app.post('/api/hq/events',requireHq,async (req,res)=>{try{const org=String(req.body.organization_id||'');if(!org)return res.status(400).json({error:'Customer/organization required'});res.status(201).json(await createEvent(org,req.body,{bypassBilling:true}))}catch(e){res.status(e.status||500).json({error:e.message||'Could not create event'})}});
app.patch('/api/hq/events/:id',requireHq,async (req,res)=>{if(typeof req.body.active==='boolean')await pool.query('UPDATE events SET active=$1 WHERE id=$2',[req.body.active,req.params.id]);if(String(req.body.pin||'').trim().length>=4)await pool.query('UPDATE events SET pin_hash=$1 WHERE id=$2',[hashSecret(String(req.body.pin).trim()),req.params.id]);if(Object.hasOwn(req.body,'organization_id')){const oid=String(req.body.organization_id||'');const org=(await pool.query('SELECT id FROM organizations WHERE id=$1',[oid])).rows[0];if(!org)return res.status(400).json({error:'Ogiltig kund/organisation'});await pool.query('UPDATE events SET organization_id=$1 WHERE id=$2',[oid,req.params.id])}res.json({ok:true})});

async function updaterFetch(route,options={}){const r=await fetch(updaterUrl+route,{...options,headers:{'x-wolcom-updater-token':updaterToken,...(options.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||'Updater request failed');e.status=r.status;throw e}return j}
app.get('/api/hq/updater/status',requireHq,async(_q,r)=>{try{r.json(await updaterFetch('/api/status'))}catch(e){r.status(503).json({error:e.message})}});
app.post('/api/hq/update/upload',requireHq,async(req,res)=>{try{const j=await updaterFetch('/api/upload',{method:'POST',body:req.body,headers:{'content-type':'application/gzip','x-update-filename':req.get('x-update-filename')||'wolcom-update.tar.gz'}});res.json(j)}catch(e){res.status(e.status||500).json({error:e.message})}});
app.post('/api/hq/update/install',requireHq,async(_q,r)=>{try{r.json(await updaterFetch('/api/install',{method:'POST'}))}catch(e){r.status(e.status||500).json({error:e.message})}});
app.get('/api/hq/github',requireHq,async(_q,r)=>{try{const [open_source,cloud]=await Promise.all([updaterFetch('/api/config/github?target=open_source'),updaterFetch('/api/config/github?target=cloud')]);r.json({open_source,cloud})}catch(e){r.status(503).json({error:e.message})}});
app.post('/api/hq/github',requireHq,async(req,res)=>{try{res.json(await updaterFetch('/api/config/github',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req.body)}))}catch(e){res.status(e.status||500).json({error:e.message})}});
app.post('/api/hq/github/sync',requireHq,async(req,r)=>{try{r.json(await updaterFetch('/api/github/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:req.body?.target||'cloud'})}))}catch(e){r.status(e.status||500).json({error:e.message})}});
app.post('/api/hq/github/test',requireHq,async(req,r)=>{try{r.json(await updaterFetch('/api/github/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:req.body?.target||'cloud'})}))}catch(e){r.status(e.status||500).json({error:e.message})}});


// Optional Wolcom Cloud commercial module. The public/self-host source export omits app/cloud entirely;
// core still runs because the module is loaded dynamically.
let cloudModule=null;
try{cloudModule=await import('./cloud/billing.mjs')}catch(e){if(process.env.WOLCOM_CLOUD_ENABLED==='1')console.warn('Wolcom Cloud module unavailable:',e.message)}
if(cloudModule?.registerCloudBillingRoutes){
  cloudHooks=cloudModule.registerCloudBillingRoutes(app,{pool,sessionSecret,requireHq,requireOwner,requirePortal,hashSecret});
}

registerBackupHubRoutes(app,{pool,requireHq,sessionSecret,version});

app.get('/api/hq/system',requireHq,async (_req,res)=>{let history=[];try{const txt=await fs.readFile('/data/update-history.jsonl','utf8');history=txt.trim().split('\n').filter(Boolean).slice(-20).reverse().map(x=>JSON.parse(x))}catch{}res.json({version,livekitUrl,history})});

app.get(['/hq','/hq/*splat'],(_req,res)=>res.sendFile(path.join(__dirname,'public','hq.html')));
app.get(['/control','/control/*splat'],(_req,res)=>res.sendFile(path.join(__dirname,'public','portal.html')));
app.get(['/event/:slug','/:slug'],(req,res,next)=>{if(['api','vendor','hq','control','assets'].includes(req.params.slug))return next();res.sendFile(path.join(__dirname,'public','event.html'))});
app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'})});
await initDb();
if(cloudModule?.initCloudBilling)await cloudModule.initCloudBilling({pool});
await initBackupHub(pool);
app.listen(port,'0.0.0.0',()=>console.log(`Wolcom ${version} listening on ${port}`));
