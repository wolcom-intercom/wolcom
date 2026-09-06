# Wolcom BackupHub restore

Wolcom BackupHub v1 exports contain a PostgreSQL custom-format dump and sanitized metadata. Secrets are intentionally excluded.

## Restore
1. Install the same or a compatible Wolcom release and stop writes to the application.
2. Extract the backup archive and locate `backup/database/database.dump`.
3. Restore into the Wolcom PostgreSQL database with `pg_restore --clean --if-exists --no-owner` using the database credentials from the new installation.
4. Start/restart Wolcom and verify `/api/health`, customer/event data and HQ login.
5. Reconfigure machine secrets and integrations (`.env`, LiveKit keys, GitHub token). They are not present in the backup.
6. Pair Wolcom with BackupHub again. BackupHub node tokens and the cluster shared secret are intentionally not portable disaster-recovery secrets.

## Excluded data
`.env`, passwords/secrets outside the database, private keys, Docker socket/data, node_modules, cache, logs, updater inbox/backups and Git source are excluded. Wolcom 0.3.3 has no user-uploaded persistent file store; unique business/event/customer data is in PostgreSQL.

## Verification
After restore, run `curl -fsS http://127.0.0.1:<web-port>/api/health` and verify HQ, customer portal and at least one event. Then perform a fresh BackupHub pairing and a test backup.
