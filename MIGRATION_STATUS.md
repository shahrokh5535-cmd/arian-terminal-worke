# Collector migration status

Audit started 2026-10-01 UTC. Initial GitHub HEAD: `909b489`; package 0.8.0, HTTP API 0.7.0.
Worker 0.8.1 committed/published (code commit `50421c0`) aligns versions and adds discovery/detail/enrichment probes and discovery/detail status.
Production project: `ctikvqtvzoaqqgnxqbgu`. No paid services, history deletion, RLS changes, or scoring-weight changes.

| Collector | Legacy cron IDs | Worker version | External RPC | Status / last verification | Rollback |
|---|---|---|---|---|---|
| Canonical DexScreener | 1,2 | live API 0.7.0 | arian_external_ingest_dexscreener_v1 | Success, 0 errors, normalized snapshot at 05:33 UTC; legacy inactive | Stop worker collector, enable 1,2 |
| Jupiter quote | 3,4 | live API 0.7.0 | arian_external_ingest_jupiter_v1 | Success, 0 errors at 05:33 UTC; legacy inactive | Stop worker collector, enable 3,4 |
| Solana signatures | 5 | live API 0.7.0 | arian_external_ingest_solana_signatures_v1 | Success, 3 transactions at 05:33 UTC; legacy inactive | Stop signature collector, enable 5 |
| Solana details / Raydium detection | 6 | 0.8.1 on GitHub, deploy pending | arian_external_claim_solana_transaction_details_v1 / arian_external_ingest_solana_transaction_detail_v1 | Gap confirmed; job 6 re-enabled at ~05:34 UTC; 2 details finalized at 05:35. New RPCs installed; external verification pending | Set ENABLE_SOLANA_DETAILS_INGEST=false; restore job 6 command to SELECT public.arian_run_solana_transaction_worker(); and active=true |
| RugCheck canonical SOL | 9,10 | live API 0.7.0 | arian_external_ingest_rugcheck_v1 | Canonical external success at 05:29 UTC. Job 9 inactive; DB-only job 10 restored ~05:49 for discovered-risk requests | Stop canonical worker collector, enable 9; keep DB finalizer 10 active while 18 enqueues |
| Token discovery | 12,13 | 0.8.1 on GitHub, deploy pending | arian_external_ingest_token_discovery_v1 | Existing external successful writes observed; legacy remains active pending full probes/status verification | Stop discovery collector, enable 12,13 |
| Jupiter token enrichment | 16,17 | 0.8.1 on GitHub, deploy pending | arian_external_claim_jupiter_token_enrichment_v1 / arian_external_ingest_jupiter_token_enrichment_v1 | Existing external successful writes; claim row locking and failure release installed; legacy active pending verification | Stop enrichment collector, enable 16,17 |

Cutover rule: verify live probes write=false, two scheduled successes with transport=blitz_worker/error_count=0 and expected raw/normalized rows, then alter legacy active=false. Never delete jobs.

Solana job 6 cutover will keep it **active** and change its command to
`SELECT public.arian_run_solana_local_processing_v1();` only after external details succeed.
That function drains legacy responses and detects canonical swaps without enqueueing HTTP.
Existing job 26 retains PumpSwap detection. Old worker function remains intact for rollback.
Claims exclude pg_net requests and processed rows; expired leases are reclaimable. Ingest locks the transaction/run and repeated delivery cannot duplicate detail raw events.

## Remaining candidate classification

| Jobs | Class | Action |
|---|---|---|
| 18 discovered risk enqueue | Mixed: DB target selection calls RugCheck HTTP enqueue | Split selection/fetch; restored job 10 finalized 2 stalled requests successfully |
| 19 promotion | DB-local compute/storage | Keep in Supabase |
| 20 promoted market enqueue | Mixed: DB selection + DexScreener HTTP | Candidate for external fetch |
| 21 promoted market worker | DB-local response handling + normalization; no HTTP calls | Keep in Supabase |
| 23 promoted signatures enqueue | Mixed: DB selection + Solana HTTP | Candidate for external fetch |
| 24 promoted signature worker | DB-local response handling + transaction storage; no HTTP calls | Keep in Supabase |
| 30 X mirror enqueue | Mixed: DB selection + free mirror HTTP | Inspect source health before replacement |
| 31 X mirror worker | DB-local response handling + scoring; no HTTP calls | Keep in Supabase |
| 32 X profile enqueue | Mixed: DB selection calls profile HTTP helper | Inspect source health before replacement |
| 33 X profile worker | DB-local response handling + scoring; no HTTP calls | Keep in Supabase |

2026-10-01 ~05:36 UTC sizes (total relation bytes, rows from pg_stat estimates):
asset_feature_snapshots 278,233,088 / 116,497; wallet_feature_snapshots 135,921,664 / 194,028;
raw_events 131,760,128 / 20,236; ingestion_runs 10,428,416 / 12,981;
blockchain_transactions 10,125,312 / 7,357; cron.job_run_details 27,983,872.
No retention performed. No measured IO/CPU reduction claimed yet.

## Verification and deployment blocker (~05:50 UTC)

Blitz `/health` and `/status` both return HTTP 200, but still expose 0.7.0 and the same 05:28 startup time.
GitHub has no Actions runs, check runs or deployments for this repository; no Blitz deployment API/credentials are available in the session.
A manual Blitz deployment of the latest `main` is required before live 0.8.1 probes/cutovers.
Jobs 12/13/16/17 remain active. External discovery success at 05:38, enrichment success at 05:43 (0 errors); replacement verification remains pending.
Solana fallback detail records advanced at 05:36/05:39/05:42, and job 6 retains detection.
Do not label new Solana external RPC test records as real Blitz writes: success/idempotence and null-failure checks ran inside rolled-back transactions.
RPC ACLs verified: SECURITY DEFINER/search_path=pg_catalog, anon/authenticated cannot execute, service_role can execute.
Security advisor returned informational RLS-without-policy findings only; existing restrictive RLS preserved.
Provider audit: promoted market/signature collectors have recent successful runs; X mirror has both successes and failures and requires source stability checks before offload.
The full production-function audit is stored outside the repository and is not published.
Automatic approval initially rejected a push due to suspected audit disclosure; committed tree and credential scan proved the audit absent, and publishing was subsequently allowed.

Final session freshness check at 05:52 UTC: 16 detail raw events recovered since 05:34;
latest transaction detail **and swap** at 05:51 UTC. Jobs 6,10,26 have recent succeeded executions.
Detail states: 6,513 processed, 2 pending, 851 unclaimed. Backlog remains and throughput should be measured after deployment.
Worker code published at `d98aaa4`; local startup `/health` and `/status` return 200/version 0.8.1.
Six Node tests passed; database success/idempotence/null-release checks passed and were rolled back.
Blitz still reports 0.7.0; external Solana scheduled-write verification and collector cutovers are pending manual deployment.
