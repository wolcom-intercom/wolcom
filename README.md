# Wolcom 0.4.10 — BackupHub 0.2.54 metadata

This app-only update extends the **existing authenticated** `GET /api/backup/v1/export` with the optional `X-BackupHub-Metadata` response header. It does **not** add a new route, contact GitHub or contact BackupHub during export. The unchanged archive and `X-Backup-SHA256` continue to be returned as before.

The header is compact ASCII JSON (at most 8,192 bytes) containing the installed application version and the status of Wolcom's **existing** GitHub synchronization, read when the backup export finishes. Wolcom has two GitHub destinations: the Cloud source is reported if configured, otherwise the Open Source destination; there is no mixing of the two histories.

- `status`: `success`, `failed`, `running`, `not_configured`, or `unknown`.
- `last_attempt_at`: UTC time from the latest sync attempt (`null` if unknown).
- `last_success_at`, `synced_version`, `commit_sha`: retained from the most recent successful sync, even after a failed attempt.
- `last_error`: a secret-safe failure summary; full diagnostics remain in HQ → GitHub history.
- GitHub tokens are **never read by the metadata builder**; it checks only whether the configured token file exists. No GitHub verification is claimed.

The existing `data/github-sync-history.jsonl`, `data/update-job.json`, and GitHub config files are mounted read-only at `/data` in the Wolcom app container. No new credentials, migrations, or network integrations are required. Existing BackupHub nodes and authentication are unchanged.

## Install

Upload `wolcom-update-0.4.10.tar.gz` via HQ → Updates, verify and install. Alternatively unpack it and run `sudo bash update.sh` against an existing installation. Only the app container is recreated: LiveKit, Redis, PostgreSQL, and the updater stay running.

## Verify

A paired BackupHub node can use its existing node Bearer token:

```bash
curl -sS -D response-headers.txt -o wolcom-backup.tar.gz \
  -H "Authorization: Bearer <existing-node-token>" \
  https://call.wolcom.se/api/backup/v1/export

grep -iE '^X-Backup(SHA256|Hub-Metadata):' response-headers.txt
sha256sum wolcom-backup.tar.gz
```

The `X-Backup-SHA256` value must match the hash of the downloaded tar.gz. `X-BackupHub-Metadata` describes the GitHub status at that export; it does not verify GitHub content or assert a backup includes Git source.

## Tests

Run `node --test app/test/*.test.mjs` to verify unconfigured, successful, failed, running, dual-repository selection, SHA validation and secret safety. These are unit tests; live Docker/BackupHub interoperability must be checked in the target environment.


## 0.4.10 — BackupHub status integration

`GET /api/backup/v1/status` now returns `installed_version` and `github_sync` from the same local Wolcom GitHub sync status source used by the export metadata header. The endpoint remains authenticated, performs no backup work and does not contact GitHub. Existing fields are preserved. `capabilities.remote_update` is currently `false`; Wolcom does not expose a BackupHub-triggered remote updater endpoint.
