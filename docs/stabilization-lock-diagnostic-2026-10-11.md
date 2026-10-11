# ARIAN TERMINAL — Stabilization Lock Diagnostic

Date: 2026-10-11
Scope: read-only diagnosis of current Production timeouts. No Production database write was performed by this diagnostic.

## Fresh finding
A separate Supabase management/MCP operation attempted to add this partial index on public.raw_events:

idx_arian_raw_events_promoted_pool_recent

Target expression:
(metadata_json ->> 'pool_id'), received_at DESC
WHERE event_type = 'solana_promoted_pool_signature_batch'

Observed sequence:
- 15:55 UTC: CREATE INDEX attempt started and hit statement timeout.
- 15:58 UTC: CREATE INDEX CONCURRENTLY attempt started and hit statement timeout.
- 16:06 UTC: cleanup DROP INDEX attempt started.
- 16:07 UTC: another cleanup attempt waited for AccessExclusiveLock and failed with SQLSTATE 55P03 lock timeout.
- Lock diagnostic identified PID 2735552 as the lock holder for PID 2735569.

## Current database symptoms
Direct MCP SQL access is still timing out, including a trivial SELECT 1 test.
Recent PostgreSQL errors include repeated SQLSTATE 57014 statement timeouts from PostgREST, pg_cron, management API, and exporter queries.
Recent pg_cron timeouts include:
- arian_refresh_production_reports()
- arian_sync_all_production_intelligence()
- arian_refresh_terminal_token_detail_cache_v1()
- arian_detect_promoted_pumpswap_swaps(50)
- arian_run_solana_local_processing_v1()
- arian_run_production_fusion_batch(20)
- arian_check_production_runtime_health()

## Interpretation
The database is under broad pressure, not just one Worker endpoint. The failed/unfinished index stabilization attempt may have added additional lock pressure, but the available evidence does not prove it is the sole root cause.

## Safety decision
Do not run another schema write, index create/drop, Worker deploy/restart, or cleanup concurrently while direct SQL access is unstable.
When read-only SQL access recovers, first inspect whether idx_arian_raw_events_promoted_pool_recent exists and whether pg_index marks it valid/ready before any corrective action.
