import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../backuphub.mjs', import.meta.url), 'utf8');

test('status route remains authenticated and reports shared BackupHub status', () => {
  assert.match(source, /app\.get\('\/api\/backup\/v1\/status'/);
  assert.match(source, /const node=await authNode\(req,res\);if\(!node\)return/);
  assert.match(source, /const source=await getBackupHubStatus\(version\)/);
  assert.match(source, /installed_version:source\.installed_version/);
  assert.match(source, /github_sync:source\.github_sync/);
  assert.match(source, /capabilities:\{remote_update:false\}/);
});

test('export metadata uses the same local GitHub status module', () => {
  assert.match(source, /X-BackupHub-Metadata/);
  assert.match(source, /backupHubMetadataHeader\(version\)/);
});

test('status route does not trigger export, GitHub sync, git, or GitHub network calls', () => {
  const start = source.indexOf("app.get('/api/backup/v1/status'");
  const end = source.indexOf("app.get('/api/backup/v1/export'", start);
  assert.ok(start >= 0 && end > start, 'status route found');
  const route = source.slice(start, end);
  assert.doesNotMatch(route, /pg_dump|tar|-czf|github\.com|api\.github|hubFetch|fetch\(|spawn\(|git\s/);
});
