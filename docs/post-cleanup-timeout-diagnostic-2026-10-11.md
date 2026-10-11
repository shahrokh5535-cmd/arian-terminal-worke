# ARIAN TERMINAL — Post-cleanup Timeout Diagnostic

Date: 2026-10-11
Scope: read-only Production diagnostics after snapshot-table cleanup. No secrets included.

## Safety boundary
- No Production data changes were made during this diagnostic.
- No Worker deploy or restart was performed.
- No credentials, API keys, service-role keys, or connection strings are recorded here.
- No new paid service or add-on was enabled.

## Confirmed platform state
- Supabase project: arian-terminal
- Project ref: ctikvqtvzoaqqgnxqbgu
- Supabase management status: ACTIVE_HEALTHY
- Snapshot history cron jobs remain intentionally disabled from the previous cleanup:
  - arian-wallet-feature-refresh
  - arian-asset-feature-refresh

## Important finding
Reducing database size did not by itself eliminate application-level timeouts.

During the 2026-10-11 13:45–14:30 UTC diagnostic window, PostgreSQL logs showed repeated SQLSTATE 57014 statement timeouts from PostgREST RPC calls used by ARIAN TERMINAL Worker 0.11.0.

Observed timeout counts:
- claim_promoted_signatures: 8
- claim_promoted_market: 8
- claim_solana_tx_details: 8
- ingest_jupiter: 8
- claim_jupiter_enrichment: 8
- ingest_dexscreener: 7
- ingest_solana_signatures: 7
- claim_x_public: 4
- claim_x_profile: 4
- claim_discovered_risk: 4
- other: 2

In a 45-minute PostgREST sample, Worker-tagged requests returned:
- HTTP 500: 68
- HTTP 504: 2

This confirms the Worker is actively reaching Supabase, but the database RPC layer is timing out across multiple independent ingestion paths.

## GitHub validation
- Backup/offline validation workflow run 38068254661: success.
- Worker test workflow run 37887364647: success.
- Latest repository commit observed: 0c4355dd31899adc0b3c534cc784bcfd08216997 (2026-10-05).
- No pull-request workflow runs were returned for the latest commit by the available commit-run lookup.

## Interpretation
The historical snapshot volume was a major storage consumer, but it was not the sole cause of the current timeouts. Because many unrelated RPC functions time out in the same window, the next investigation should focus on shared database pressure, blocking/locking, expensive claim functions, query plans/index coverage, and concurrent Worker calls.

## Safe next steps
1. Keep the two historical snapshot cron jobs disabled while the project is unfinished.
2. Do not restart or redeploy the Worker solely to mask database timeouts.
3. Inspect timeout-heavy RPC definitions and query plans in a non-destructive/read-only manner when the SQL connection is stable.
4. Inspect concurrency and locking when read-only database access is available.
5. Re-check fresh market snapshots after RPC latency recovers.
6. Do not perform further cleanup/deletion until a separate reviewed decision is made.
