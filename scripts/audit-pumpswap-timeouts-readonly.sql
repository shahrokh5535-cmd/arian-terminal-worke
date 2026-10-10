-- ARIAN TERMINAL / PumpSwap timeout diagnostics (read-only, 2026-10-10)
-- Safe on production: catalog reads and bounded recent cron history only.
-- DO NOT run arian_detect_promoted_pumpswap_swaps() here: it WRITES to production.
-- No EXPLAIN ANALYZE, DDL, UPDATE, DELETE, grants, or scheduling changes.

-- A. Last 20 PumpSwap cron executions, including failure context.
SELECT d.start_time, d.end_time, d.status,
       left(d.return_message, 500) AS return_message
FROM cron.job_run_details AS d
JOIN cron.job AS j ON j.jobid = d.jobid
WHERE j.jobname = 'arian-pumpswap-swap-detector'
ORDER BY d.start_time DESC
LIMIT 20;

-- B. Two-hour success/failure trend; count running separately.
SELECT count(*) FILTER (WHERE d.status='succeeded') AS succeeded_2h,
       count(*) FILTER (WHERE d.status='failed') AS failed_2h,
       count(*) FILTER (WHERE d.status='running') AS running_2h,
       max(d.start_time) AS latest_started_at
FROM cron.job_run_details AS d
JOIN cron.job AS j ON j.jobid = d.jobid
WHERE j.jobname = 'arian-pumpswap-swap-detector'
  AND d.start_time >= now() - interval '2 hours';

-- C. Existing indexes on the hot tables (metadata-only, no scan).
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('blockchain_transactions','raw_events',
                    'swaps','liquidity_pools','markets')
ORDER BY tablename,indexname;

-- D. Planner statistics / table estimates (not COUNT(*) scans).
SELECT relname, n_live_tup, n_dead_tup, last_analyze,
       last_autoanalyze, seq_scan, idx_scan
FROM pg_stat_user_tables
WHERE schemaname='public'
  AND relname IN ('blockchain_transactions','raw_events',
                  'swaps','liquidity_pools','markets')
ORDER BY relname;

-- E. Current statement timeout and function metadata.
SELECT current_setting('statement_timeout') AS session_statement_timeout;
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       p.provolatile, p.prosecdef, p.proconfig
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname='arian_detect_promoted_pumpswap_swaps';

-- Interpretation (not yet proven by query plan):
-- Function's nested loop iterates active promoted PumpSwap pools, then joins
-- blockchain_transactions to raw_events and tests JSONB log/account arrays.
-- 120-second cron timeout may reflect repeated scans/JSONB processing.
-- Avoid index or function changes until reviewed plan, rollback, and verified backup.
