import fs from 'node:fs/promises';
import path from 'node:path';

const STATUSES = new Set(['success', 'failed', 'running', 'not_configured', 'unknown']);
const COMMIT = /^[0-9a-f]{7,64}$/i;
const iso = value => {
  if (typeof value !== 'string' || !value.trim() || !/[zZ]|[+-]\d\d:\d\d$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const version = value => typeof value === 'string' && value.length <= 128 && /^[\w.+-]+$/.test(value) ? value : null;
const commit = value => typeof value === 'string' && COMMIT.test(value) ? value.toLowerCase() : null;
// A diagnostics string is never allowed to become a conduit for a bearer token.
// On failure, direct staff to HQ, where the original error is already available.
const failure = () => 'GitHub sync failed; see HQ GitHub history';
const asciiJson = data => JSON.stringify(data).replace(/[\u007f-\uffff]/g, ch =>
  `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function jsonFile(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function configured(dataDir, target) {
  const cfg = await jsonFile(path.join(dataDir, `github-${target}.json`));
  if (!cfg || typeof cfg.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) return false;
  // Check presence, not value: never load GitHub tokens into backup metadata code.
  try { const stat = await fs.stat(path.join(dataDir, `github-${target}-token`)); return stat.isFile() && stat.size > 0; }
  catch { return false; }
}
async function historyFor(dataDir, target) {
  try {
    const file = path.join(dataDir, 'github-sync-history.jsonl');
    const {size} = await fs.stat(file);
    // Read newest 8 MiB of append-only history; ignore the first partial line if truncated.
    const length = Math.min(size, 8 * 1024 * 1024);
    const f = await fs.open(file, 'r');
    let buf;
    try { buf = Buffer.alloc(length); const result = await f.read(buf, 0, length, size - length); buf = buf.subarray(0, result.bytesRead); }
    finally { await f.close(); }
    const txt = buf.toString('utf8');
    const rows = (length < size ? txt.slice(txt.indexOf('\n') + 1) : txt).split('\n');
    return rows.flatMap(line => {
      try { const row = JSON.parse(line); return row?.target === target && (row.status === 'success' || row.status === 'failed') ? [row] : []; }
      catch { return []; }
    });
  } catch { return []; }
}

export async function getBackupHubStatus(installedVersion, dataDir = '/data') {
  const installed_version = version(installedVersion);
  const github_sync = {
    status: 'not_configured', last_attempt_at: null, last_success_at: null,
    synced_version: null, commit_sha: null, last_error: null,
  };
  try {
    const target = await configured(dataDir, 'cloud') ? 'cloud' :
      await configured(dataDir, 'open_source') ? 'open_source' : null;
    if (!target) return {installed_version, github_sync};
    github_sync.status = 'unknown';
    const records = await historyFor(dataDir, target);
    const last = records.at(-1) || null;
    const good = [...records].reverse().find(row => row.status === 'success' &&
      iso(row.synced_at || row.time)) || null;
    if (good) {
      github_sync.last_success_at = iso(good.synced_at || good.time);
      github_sync.synced_version = version(good.version);
      github_sync.commit_sha = commit(good.commit);
    }
    if (last) {
      github_sync.status = last.status;
      github_sync.last_attempt_at = iso(last.started_at || last.time);
      github_sync.last_error = last.status === 'failed' ? failure() : null;
    }
    const job = await jsonFile(path.join(dataDir, 'update-job.json'));
    const running = job?.github?.[target];
    const inProgress = running?.status === 'syncing';
    const pendingAt = iso(running?.time);
    if (inProgress && pendingAt && (!github_sync.last_attempt_at ||
      Date.parse(pendingAt) >= Date.parse(github_sync.last_attempt_at))) {
      github_sync.status = 'running';
      github_sync.last_attempt_at = pendingAt;
      github_sync.last_error = null;
    }
  } catch {
    // Backup must still work if the GitHub status files are unreadable.
    github_sync.status = github_sync.status === 'not_configured' ? 'not_configured' : 'unknown';
  }
  if (!STATUSES.has(github_sync.status)) github_sync.status = 'unknown';
  return {installed_version, github_sync};
}

// Backwards-compatible alias used by existing tests/importers.
export const backupHubMetadata = getBackupHubStatus;

export async function backupHubMetadataHeader(installedVersion, dataDir = '/data') {
  let metadata = await getBackupHubStatus(installedVersion, dataDir);
  let header = asciiJson(metadata);
  if (Buffer.byteLength(header, 'ascii') > 8192) {
    metadata = {installed_version: version(installedVersion), github_sync: {
      status: 'unknown', last_attempt_at: null, last_success_at: null,
      synced_version: null, commit_sha: null, last_error: null,
    }};
    header = asciiJson(metadata);
  }
  return header;
}
