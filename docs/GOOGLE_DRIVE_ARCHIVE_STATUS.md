# Google Drive archive transport: verified checkpoint (2026-10-09)

## Verified
- Destination: the **private** Google Drive folder `ARIAN TERMINAL - SECURE DATABASE ARCHIVE`, under `ChatGPT`.
- Transport probe `arian_archive_readiness_2026-10-09.json` was uploaded and **read back** on 2026-10-09.
- Payload is an operational-readiness report only; it contains no wallet trade records, raw blockchain events, database passwords, service-role keys, or encryption secrets.
- Supabase read-only preflight at 2026-10-09T07:59:52Z: database size 1,111,821,459 bytes; 17/60 connections; 0 lock waiters; 0 idle-in-transaction.
- In a bounded sample, Cron jobs 10, 11, 21, 35 each had six successes and zero failures.
- No Supabase write, DROP, DELETE, TRUNCATE, cron change, deploy, or live Worker change was performed.

## NOT verified / hard gate
- **No PostgreSQL table dump was exported**.
- **No actual encrypted database archive is in Drive**.
- **No restore was attempted or verified**.
- Therefore **NO data deletion or retention enforcement is allowed**.
- The isolated runner still needs valid scoped database credentials, PostgreSQL 17 `pg_dump`, `age` encryption recipient/public key with user-owned recoverable private identity, and authenticated private Drive upload.
- Never put a database password, Google OAuth refresh token, service-role key, or `age` private identity in repository files or chat.
- The test report is not a database backup; do not label it as one.

## Safe execution sequence
1. Provision a short-lived, secure PostgreSQL 17 client environment outside Production.
2. Confirm sufficient free space/CPU and an acceptable low-load backup window; use a direct TLS Postgres connection, not a publicly exposed service key.
3. Obtain owner-controlled `age` recipient and offline protected recovery identity; confirm owner can decrypt a separate test file.
4. Export consistent copy-only table snapshot with the existing `scripts/export-snapshot-archive.sh` on an isolated runner. Verify that source PostgreSQL remains healthy throughout.
5. Upload **only encrypted archives** and SHA-256 manifests to private Drive folder.
6. Download from Drive independently and verify exact byte hashes, decrypt, and restore to a completely separate PostgreSQL 17 instance. Validate expected schema dependencies, row counts, keys, and sample queries.
7. Document successful restore and have a distinct approved retention migration before *any* source-row deletion. The `raw_events` table has downstream FKs and must not be auto-deleted.

Cloudflare R2 is inactive because its subscription checkout requires billing details. Do not enable it as part of this Drive path.
