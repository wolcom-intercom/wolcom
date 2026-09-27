import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {backupHubMetadata, backupHubMetadataHeader} from '../backuphub-github-metadata.mjs';

async function tmp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wolcom-gh-backup-test-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));return dir; }
async function config(dir, target = 'cloud') {
  await fs.writeFile(path.join(dir, `github-${target}.json`), JSON.stringify({repo:'wolcom/wolcom-cloud',branch:'main'}));
  await fs.writeFile(path.join(dir, `github-${target}-token`), 'TOP_SECRET_GITHUB_TOKEN');
}
async function record(dir, row) { await fs.appendFile(path.join(dir, 'github-sync-history.jsonl'), JSON.stringify(row)+'\n'); }

test('not_configured returns all-null sync metadata', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await backupHubMetadata('0.4.9',dir), {installed_version:'0.4.9',github_sync:{status:'not_configured',last_attempt_at:null,last_success_at:null,synced_version:null,commit_sha:null,last_error:null}});
});
test('success uses real GitHub history, uppercase SHA and timezone are normalized', async t => {
  const dir = await tmp(t);await config(dir);
  await record(dir,{target:'cloud',status:'success',version:'0.4.8',commit:'ABCDEF12345',time:'2026-09-23T12:30:00+02:00',synced_at:'2026-09-23T12:31:00+02:00'});
  const h=JSON.parse(await backupHubMetadataHeader('0.4.9',dir));
  assert.equal(h.github_sync.status,'success');
  assert.equal(h.github_sync.last_attempt_at,'2026-09-23T10:30:00.000Z');
  assert.equal(h.github_sync.last_success_at,'2026-09-23T10:31:00.000Z');
  assert.equal(h.github_sync.synced_version,'0.4.8');
  assert.equal(h.github_sync.commit_sha,'abcdef12345');
  assert.equal(h.github_sync.last_error,null);
});
test('failure retains prior successful version, date and SHA and never leaks tokens', async t => {
  const dir = await tmp(t);await config(dir);
  await record(dir,{target:'cloud',status:'success',version:'0.4.7',commit:'1234567',time:'2026-09-22T08:00:00Z'});
  await record(dir,{target:'cloud',status:'failed',version:'0.4.9',time:'2026-09-23T10:42:00Z',error:'failed: TOP_SECRET_GITHUB_TOKEN'});
  const header=await backupHubMetadataHeader('0.4.9',dir); const {github_sync:s}=JSON.parse(header);
  assert.equal(s.status,'failed');assert.equal(s.synced_version,'0.4.7');assert.equal(s.commit_sha,'1234567');
  assert.equal(s.last_success_at,'2026-09-22T08:00:00.000Z');assert.equal(s.last_attempt_at,'2026-09-23T10:42:00.000Z');
  assert.ok(s.last_error);assert.ok(!header.includes('TOP_SECRET_GITHUB_TOKEN'));
});
test('running state is used when newer than latest history; success remains', async t => {
  const dir=await tmp(t);await config(dir);
  await record(dir,{target:'cloud',status:'success',version:'0.4.8',commit:'abc1234',time:'2026-09-22T10:00:00Z'});
  await fs.writeFile(path.join(dir,'update-job.json'),JSON.stringify({github:{cloud:{status:'syncing',time:'2026-09-23T10:42:00Z'}}}));
  const {github_sync:s}=await backupHubMetadata('0.4.9',dir);
  assert.equal(s.status,'running');assert.equal(s.synced_version,'0.4.8');assert.equal(s.commit_sha,'abc1234');
});
test('cloud preferred, open source fallback, do not mix their success records', async t => {
  const dir=await tmp(t);await config(dir,'open_source');
  await record(dir,{target:'open_source',status:'success',version:'0.4.8',commit:'def1234',time:'2026-09-22T10:00:00Z'});
  assert.equal((await backupHubMetadata('0.4.9',dir)).github_sync.commit_sha,'def1234');
  await config(dir,'cloud');
  assert.equal((await backupHubMetadata('0.4.9',dir)).github_sync.status,'unknown');
});
test('no valid SHA is represented as null, header stays ASCII and under limit', async t => {
  const dir=await tmp(t);await config(dir);
  await record(dir,{target:'cloud',status:'success',version:'0.4.8',commit:'invalid',time:'2026-09-22T10:00:00Z'});
  const header=await backupHubMetadataHeader('0.4.9',dir);
  assert.ok(Buffer.byteLength(header,'ascii')<=8192);assert.match(header,/^[\x00-\x7f]*$/);
  assert.equal(JSON.parse(header).github_sync.commit_sha,null);
});
