# Collector migration status

Project `ctikvqtvzoaqqgnxqbgu`; repository name remains `arian-terminal-worke`.
Live worker: **0.8.1** (startup 2026-10-01 06:29:50 UTC). Prepared next worker: **0.9.0**.
All historical functions/jobs remain available. No retention, table drops, RLS relaxations, or scoring-weight changes.

| Collector | Legacy cron IDs | Worker | External RPC | Status / last verification | Rollback |
|---|---|---|---|---|---|
| Canonical DexScreener | 1,2 | 0.8.1 | arian_external_ingest_dexscreener_v1 | Migrated; snapshot success 06:34 UTC, legacy inactive | Stop collector; enable 1,2 |
| Jupiter quote | 3,4 | 0.8.1 | arian_external_ingest_jupiter_v1 | Migrated; 06:30 delivery timeout had committed successfully; next 06:34 scheduler success, legacy inactive | Stop collector; enable 3,4 |
| Canonical Solana signatures | 5 | 0.8.1 | arian_external_ingest_solana_signatures_v1 | Migrated; 3 new signatures at 06:34 UTC, legacy inactive | Stop collector; enable 5 |
| Solana details | 6 (mixed job split) | 0.8.1 | arian_external_claim_solana_transaction_details_v1 / arian_external_ingest_solana_transaction_detail_v1 | Two distinct successful cycles 06:31 and 06:34; 4 raw details, 0 errors. HTTP cutover ~06:38 UTC; job 6 active with DB-only command | Set ENABLE_SOLANA_DETAILS_INGEST=false; restore job 6 command SELECT public.arian_run_solana_transaction_worker(); active=true |
| Canonical RugCheck SOL | 9 | 0.8.1 | arian_external_ingest_rugcheck_v1 | Migrated; external assessment success 06:30 UTC, job 9 inactive | Stop canonical collector; enable 9 |
| Discovered-token RugCheck finalizer | 10 (job 18 still enqueues HTTP) | DB-local | Existing arian_run_rugcheck_worker | Kept active: disabling it had stranded discovered-token assessments; two recovered at 05:48 UTC | Keep 10 active while 18 still enqueues |
| Token Discovery | 12,13 | 0.8.1 | arian_external_ingest_token_discovery_v1 | Two cycles 06:31/06:39 successful, each 2 raw records; latter created 3 instances/events/scores. Job 12 disabled ~06:41; legacy drained, then 13 disabled | Set ENABLE_TOKEN_DISCOVERY=false; enable 12,13 |
| Jupiter Token Enrichment | 16,17 | 0.8.1 | arian_external_claim_jupiter_token_enrichment_v1 / arian_external_ingest_jupiter_token_enrichment_v1 | Two cycles 06:30/06:34, 0 errors, 2 raw records each, decimals/metadata/route updated. Both jobs disabled ~06:38 UTC | Set ENABLE_JUPITER_TOKEN_ENRICHMENT=false; enable 16,17 |
| Promoted market snapshots | 20 HTTP/selection; 21 DB-local | Prepared 0.9.0 | arian_external_claim_promoted_market_v1 / arian_external_peek_promoted_market_v1 / arian_external_ingest_promoted_market_v1 | Secure RPCs installed; same legacy normalization/scoring preserved. Live Blitz verification pending. Both old jobs active | Stop new collector; ensure 20,21 active |
| Promoted pool signatures | 23 HTTP/selection; 24 DB-local | Prepared 0.9.0 | arian_external_claim_promoted_signatures_v1 / arian_external_peek_promoted_signatures_v1 / arian_external_ingest_promoted_signatures_v1 | Secure RPCs installed; same transaction metadata/upsert preserved. Live Blitz verification pending. Both old jobs active | Stop new collector; ensure 23,24 active |

## Production cutover evidence

0.8.1 `/health` and `/status`: 200. Discovery, enrichment and detail probes: 200/success/writes_to_supabase=false.
External run IDs: details 13104/13105 (one cycle), 13112/13113 (second cycle);
enrichment 13102 and 13111; discovery 13103 and 13120.
All successful with error_count=0 and transport=blitz_worker.
Raw/normalized records checked directly; discovery 13120 had 3 instances, 3 discovery events and 3 scores.
Job 6 command is now `SELECT public.arian_run_solana_local_processing_v1();`.
It drains old detail responses and runs canonical swap detection without enqueueing HTTP.
Job 26 retains PumpSwap detection; job 10 retains discovered-risk finalization.
Old discovery requests were drained before job 13 was disabled.

## Next deployment and verification

Build latest main in Blitz for 0.9.0. No deployment API available in this session.
New collectors automatically run a read-only provider probe before claiming work, then poll one selected pool every 5 minutes.
Public probes: `/probe/promoted-market`, `/probe/promoted-signatures`; status includes both collectors.
Workspace DexScreener provider request returned HTTP 403: source reachability must be verified from Blitz before cutover.
Legacy 20/21/23/24 remain active. Confirm two independent scheduled successes, error_count=0,
raw event plus normalized snapshot/transactions and downstream freshness before disabling HTTP jobs 20/23.
Keep DB-local workers 21/24 while draining legacy responses; they contain no external HTTP calls.
Claims serialize on the connector, respect outstanding legacy runs, and expire abandoned runs after 10 minutes.
Ingest locks run ID; repeated delivery creates no duplicate evidence/snapshots. Provider failures release the run.
No scoring logic moved to Node. DB success/idempotence/failure tests use rolled-back transactions; they are not Blitz success evidence.
RPC ACLs verified: SECURITY DEFINER/search_path=pg_catalog; no anon/authenticated execute; service_role enabled.
Security advisor reported only existing informational RLS-without-policy findings; restrictive RLS retained.

## Remaining collector audit

18: mixed DB selection plus RugCheck HTTP; split next, keep 10 finalizing.
19: DB-local promotion, keep in Supabase.
30: mixed DB target selection plus free FxTwitter HTTP; 31: DB-local response handling/scoring.
32: mixed DB selection plus profile HTTP; 33: DB-local response handling/scoring.
X mirror has recent successes and failures; source stability must be proven before any legacy cutover.

## Storage baseline / recovery history

2026-10-01 ~05:36 UTC total relation bytes / estimated rows:
asset_feature_snapshots 278,233,088 / 116,497; wallet_feature_snapshots 135,921,664 / 194,028;
raw_events 131,760,128 / 20,236; ingestion_runs 10,428,416 / 12,981;
blockchain_transactions 10,125,312 / 7,357; cron.job_run_details 27,983,872.
No measured IO/CPU reduction claimed; history size is a separate retention phase requiring explicit approval.
Original disabled-job-6 gap was recovered at ~05:34; 16 detail records and new swaps advanced to 05:51 before external cutover.
Full production audit dump stays outside the repository. Published SQL contains only the targeted authorized RPC definitions.

Post-cutover check 2026-10-01 06:48 UTC: jobs 12/13/16/17 inactive, job 6 DB-only active;
external details/enrichment succeeded at 06:39 and 06:44 with zero errors; latest swap at 06:45.
Live 0.8.1 health/status healthy. New 0.9.0 local health/status both 200, seven new collector tests passed.
Rolled-back SQL verified market/signature ingestion idempotence and signature failure release.

06:50 verification: external discovery 13145 created 3 further records after legacy disable;
enrichment 13146 and details 13147/13148 succeeded, error_count=0.
One legacy Jupiter request (13116) had started at 06:38 just before cutover;
manually drained both token/route stages successfully at ~06:51 without re-enabling enqueue cron.
Prepared 0.9.0 code published in commit d48f41e; production 20/21/23/24 remain active pending Blitz deployment.
