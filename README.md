# ARIAN TERMINAL Worker

Plain Node.js external collectors for the existing Solana-first database. Start with `npm start` (Node >=20).
Database normalization, scoring, fusion and swap detection stay in Supabase. See [MIGRATION_STATUS.md](MIGRATION_STATUS.md) for live verification and rollback.

`/health` and `/status` expose safe operational summaries. Read-only shadow probes:
`/probe/dexscreener`, `/probe/jupiter`, `/probe/solana-rpc`, `/probe/rugcheck`,
`/probe/token-discovery`, `/probe/jupiter-token-enrichment`, `/probe/solana-details`.
Probes never claim work or write to Supabase.

Secrets belong only in Blitz environment variables. Never commit `.env` or service-role keys.
Existing collector gates are retained. Solana details additionally respect `ENABLE_SOLANA_DETAILS_INGEST`
(default true when the existing signature gate is true). Details fetch two transactions sequentially every five minutes.
Discovery runs every ten minutes; enrichment every five. One collector failure cannot crash the process.

SQL preparation files in `db/` are already applied as documented; they do not cut over cron jobs.
Verify external scheduled writes and downstream freshness before disabling any legacy collector.
Job 6 must continue DB-local swap detection after its HTTP work is offloaded.

Validation: `node --check src/server.js`, `npm test`.
