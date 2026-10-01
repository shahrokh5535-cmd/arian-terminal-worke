# Collector migration status

Audit started 2026-10-01 UTC. Initial GitHub HEAD: `909b489`; package 0.8.0, HTTP API 0.7.0.
Prepared worker 0.8.1 aligns versions and adds discovery/detail/enrichment probes and discovery/detail status.
Production project: `ctikvqtvzoaqqgnxqbgu`. No paid services, history deletion, RLS changes, or scoring-weight changes.

| Collector | Legacy cron IDs | Worker version | External RPC | Status / last verification | Rollback |
|---|---|---|---|---|---|
| Canonical DexScreener | 1,2 | live API 0.7.0 | arian_external_ingest_dexscreener_v1 | Success, 0 errors, normalized snapshot at 05:33 UTC; legacy inactive | Stop worker collector, enable 1,2 |
| Jupiter quote | 3,4 | live API 0.7.0 | arian_external_ingest_jupiter_v1 | Success, 0 errors at 05:33 UTC; legacy inactive | Stop worker collector, enable 3,4 |
| Solana signatures | 5 | live API 0.7.0 | arian_external_ingest_solana_signatures_v1 | Success, 3 transactions at 05:33 UTC; legacy inactive | Stop signature collector, enable 5 |
| Solana details / Raydium detection | 6 | prepared 0.8.1 | arian_external_claim_solana_transaction_details_v1 / arian_external_ingest_solana_transaction_detail_v1 | Gap confirmed; job 6 re-enabled at ~05:34 UTC; 2 details finalized at 05:35. New RPCs installed; external verification pending | Set ENABLE_SOLANA_DETAILS_INGEST=false; restore job 6 command to SELECT public.arian_run_solana_transaction_worker(); and active=true |
| RugCheck canonical SOL | 9,10 | live API 0.7.0 | arian_external_ingest_rugcheck_v1 | Success, 0 errors at 05:29 UTC; legacy inactive | Stop worker collector, enable 9,10 |
| Token discovery | 12,13 | prepared 0.8.1 | arian_external_ingest_token_discovery_v1 | Existing external successful writes observed; legacy remains active pending full probes/status verification | Stop discovery collector, enable 12,13 |
| Jupiter token enrichment | 16,17 | prepared 0.8.1 | arian_external_claim_jupiter_token_enrichment_v1 / arian_external_ingest_jupiter_token_enrichment_v1 | Existing external successful writes; claim row locking and failure release installed; legacy active pending verification | Stop enrichment collector, enable 16,17 |

Cutover rule: verify live probes write=false, two scheduled successes with transport=blitz_worker/error_count=0 and expected raw/normalized rows, then alter legacy active=false. Never delete jobs.

Solana job 6 cutover will keep it **active** and change its command to
`SELECT public.arian_run_solana_local_processing_v1();` only after external details succeed.
That function drains legacy responses and detects canonical swaps without enqueueing HTTP.
Existing job 26 retains PumpSwap detection. Old worker function remains intact for rollback.
Claims exclude pg_net requests and processed rows; expired leases are reclaimable. Ingest locks the transaction/run and repeated delivery cannot duplicate detail raw events.

## Remaining candidate classification

| Jobs | Class | Action |
|---|---|---|
| 18 discovered risk enqueue | Mixed: DB target selection calls RugCheck HTTP enqueue | Split selection/fetch; investigate legacy finalization because job 10 is inactive |
| 19 promotion | DB-local compute/storage | Keep in Supabase |
| 20 promoted market enqueue | Mixed: DB selection + DexScreener HTTP | Candidate for external fetch |
| 21 promoted market worker | Mixed: response handling + normalization | Preserve DB normalization |
| 23 promoted signatures enqueue | Mixed: DB selection + Solana HTTP | Candidate for external fetch |
| 24 promoted signature worker | Mixed: response handling + transaction storage | Preserve DB storage |
| 30 X mirror enqueue | Mixed: DB selection + free mirror HTTP | Inspect source health before replacement |
| 31 X mirror worker | Mixed: response handling + DB processing | Preserve DB processing |
| 32 X profile enqueue | Mixed: DB selection calls profile HTTP helper | Inspect source health before replacement |
| 33 X profile worker | Mixed: response handling + DB processing | Preserve DB processing |

2026-10-01 ~05:36 UTC sizes (total relation bytes, rows from pg_stat estimates):
asset_feature_snapshots 278,233,088 / 116,497; wallet_feature_snapshots 135,921,664 / 194,028;
raw_events 131,760,128 / 20,236; ingestion_runs 10,428,416 / 12,981;
blockchain_transactions 10,125,312 / 7,357; cron.job_run_details 27,983,872.
No retention performed. No measured IO/CPU reduction claimed yet.
