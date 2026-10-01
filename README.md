# ARIAN TERMINAL Worker

Plain Node.js external collectors for the existing Solana-first database. Start with `npm start` (Node >=20).
Database normalization, scoring, fusion and swap detection stay in Supabase. See [MIGRATION_STATUS.md](MIGRATION_STATUS.md) for live verification and rollback.

`/health` and `/status` expose safe operational summaries. Read-only shadow probes:
`/probe/dexscreener`, `/probe/jupiter`, `/probe/solana-rpc`, `/probe/rugcheck`,
`/probe/token-discovery`, `/probe/jupiter-token-enrichment`, `/probe/solana-details`,
`/probe/promoted-market`, `/probe/promoted-signatures`.
Probes never claim work or write to Supabase.

Secrets belong only in Blitz environment variables. Never commit `.env` or service-role keys.
Existing collector gates are retained. Solana details additionally respect `ENABLE_SOLANA_DETAILS_INGEST`
(default true when the existing signature gate is true). Details fetch two transactions sequentially every five minutes.
Discovery runs every ten minutes; enrichment every five. One collector failure cannot crash the process.

SQL preparation files in `db/` are already applied as documented; they do not cut over cron jobs.
Verify external scheduled writes and downstream freshness before disabling any legacy collector.
Job 6 must continue DB-local swap detection after its HTTP work is offloaded.

Validation: `node --check src/server.js`, `npm test`.

Promoted market/signature collectors in v0.9.0 respect `ENABLE_PROMOTED_MARKET_INGEST` and
`ENABLE_PROMOTED_SIGNATURES_INGEST` (both default true when credentials are configured).
Each performs a read-only shadow probe before its first claim. Selection uses the existing DB policy.
An outstanding legacy run causes the external scheduler to wait; legacy jobs remain active until real writes are verified.
Runs are locked, ingestion is idempotent by run ID, and a lost delivery can be retried once safely.

Discovered-token risk in v0.10.0 uses `ENABLE_DISCOVERED_RISK_INGEST` (default true with
credentials) and `DISCOVERED_RISK_INTERVAL_MS` (minimum/default 600000). It claims at
most two eligible Solana tokens per cycle, respecting pending legacy requests and
24-hour risk freshness. `/probe/discovered-risk` checks a known SOL mint without
writing. Unsupported tokens receive a six-hour 404 backoff; 429 receives ten minutes.
SQL preserves existing safety-score semantics and assessment/storage logic.
Job 18 was disabled after two actual Blitz batches and normalized assessments were verified.
DB-only job 10 remains available; see MIGRATION_STATUS.md for rollback.

Linked X public-post HTTP collection is prepared in v0.11.0. It uses
`ENABLE_X_PUBLIC_SOCIAL_INGEST` (default true with credentials) and
`X_PUBLIC_SOCIAL_INTERVAL_MS` (minimum/default 600000), claiming one post per cycle.
`/probe/x-social` reads a previously ingested public post without claiming/writing.
`db/x_public_social_external.sql` keeps normalization and existing social scoring in SQL.
HTTP 404 backs off six hours; 429 fifteen minutes; other failures ten minutes.
External claims serialize on the existing connector and wait for pending linked-post runs.
Only job 30 is a cutover candidate after two verified real Blitz batches;
DB-only job 31 and profile jobs 32/33 remain active.
The collector follows discovery-linked posts; it does not provide broad search,
complete account timelines, confirmed wallet buys, or proof that a linked post endorses a token.
