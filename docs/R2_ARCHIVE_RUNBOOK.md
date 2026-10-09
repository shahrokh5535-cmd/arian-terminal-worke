# ARIAN TERMINAL — safe R2 archival preflight (2026-10-09)

STATUS: DESIGN / READ-ONLY. No production backup uploaded, no deletion, no R2 bucket confirmed.
Separate from Worker PR #7; do not merge or deploy this branch by default.

## Scope and invariants

1. Use the EXISTING Cloudflare account that owns ARIAN TERMINAL / arena23; R2 is a storage service inside that account, not a second website/account. The dashboard may ask to activate an R2 subscription. STOP before any checkout, billing, payment method, or plan change unless the owner explicitly approves the exact charge conditions.
2. Provision one dedicated PRIVATE R2 Standard bucket with a unique name such as `arian-terminal-archive-private` if available. Leave public access, r2.dev URLs, custom domains, lifecycle deletions and Workers bindings OFF. Never touch DNS, arena23 Pages, production Worker, or security gates.
3. Use a bucket-scoped read/write R2 credential through the provider's secure UI. Never paste or commit secrets; no public objects. Store recovery encryption key independently (owner-controlled). Verify ability to decrypt BEFORE relying on the archive.
4. Existing active DB: Supabase project `ctikvqtvzoaqqgnxqbgu` (PostgreSQL 17). Last recorded ~1,056 MiB total. Free plan; verify current actual quota and usage. Current Cron/RPC timeout incident must be resolved before a large pg_dump; taking a ~1 GB dump during pool saturation could worsen an outage.
5. The data copy and retention/deletion are separate approvals. READ-ONLY COPY FIRST. Even if an R2 upload succeeds, DELETE FROM, TRUNCATE, DROP, rewrites, table swaps, pg_repack, VACUUM FULL, and cron toggles remain forbidden without separate explicit approval and migration/rollback/verification plan.
6. On-chain/event provenance is critical. `public.raw_events` has 5 inbound foreign keys using ON DELETE SET NULL (blockchain_transactions, content_items, jupiter_quotes, swaps, token_discovery_events); deleting event records silently severs traceability. EXCLUDE raw_events from any proposed retention deletion. The two feature-snapshot tables each have 3 outbound FKs and identity triggers; report and audit every reader before considering retention.
7. Never move recent market_snapshots, risk scores, wallets/trades, Smart Money history, intelligence_scores, RLS/policies, connector state, recovery or notification tables. Fusion readiness rules remain intact.

## Before first upload (stop-gates)

- Owner completes authenticated Cloudflare TinyFish profile sign-in and Save profile (MFA stays in Cloudflare). Verify R2 existing subscription and billing status without changing them.
- Verify read-only preflight SQL in `db/r2_archive_preflight.sql` and snapshot current schema/migration/function/permissions metadata, record exact cutoff UTC + transaction snapshot. Ensure Postgres connections are stable and 2 consecutive worker cycles succeed first.
- Create encryption key pair outside GitHub, with owner-held recovery backup. Perform encrypted local round-trip on a synthetic test payload.
- Export a CONSISTENT, encrypted copy of the required table/schema scope, without disk-stored plaintext. Include schema, dependencies, enum/extension/migration inventory and a restore plan. Use a version-compatible pg_dump 17 in a secure runner with sufficient disk, memory and network allowance, separate from the already overloaded production Worker.
- Organize private R2 keys as `arian-terminal/YYYY-MM-DD/run-id/{encrypted-backup,manifest,verification}`. Manifest records UTC cutoff, source project ref, table/row counts, IDs/ranges, checksum SHA-256, encryption/format tool versions, schema identifier and expected restore scope; never contain secrets or private row data.
- Verify HEAD/GET on R2 and compare downloaded encrypted file SHA-256 to locally recorded hash, independently decrypt using owner key, parse backup, and actually restore to a disposable NON-PRODUCTION database. Compare referential integrity, PK uniqueness, row counts and representative values; record PASS/FAIL. A pg_restore catalog listing alone is not a restore test.
- Post-upload, confirm production data and all gates unchanged. A stored copy does NOT free any PostgreSQL space.

## Conditional retention (NOT AUTHORIZED BY THIS PLAN)

- Select ONLY fully verified, explicitly approved old snapshot rows; prove no reader needs them (function/view/SQL/code audit) and preserve all required relationship keys plus restore index.
- Use a separate migration and a small canary, restore plan and gates; user must approve exact selection, maintenance, retention and rollback. Physical reclaimed disk is measured after maintenance, never estimated from the uploaded object size.
- Existing production incident first: 0 recent valid market snapshots and repeated pg_cron/PostgREST timeouts were observed. Do not interpret successful bucket creation as incident resolution.

## Rollback

- Before retention: simply stop; database unchanged. Keep encrypted R2 objects and manifest; never overwrite a prior version.
- After separately approved retention: restore the original verified rows by primary key to a NON-PRODUCTION database first, then perform a verified production migration if necessary with explicit approval. No blind INSERT/DELETE.
- Cloudflare arena23 stays untouched; rollback is independent of Pages, DNS, billing and worker deployment.
