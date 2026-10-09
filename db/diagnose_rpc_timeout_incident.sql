-- ARIAN TERMINAL / incident triage: PostgREST RPC 500 + stale promoted snapshots
-- Read-only, non-destructive. Run in Supabase SQL editor as a privileged operator.
-- Scope: diagnosing collector-to-DB delivery; no DDL, no cron edits, no retries.
-- Evidence 2026-10-09 00:32-00:35 UTC:
--   latest market snapshot 2026-10-08 21:47:43 UTC; valid last 30m = 0.
--   Worker user agent arian-terminal-worker/0.11.0 still sent RPCs;
--   PostgREST returned HTTP 500 for promoted market and multiple other collectors.
--   PostgreSQL logged "canceling statement due to statement timeout",
--   and several cron jobs logged startup timeout.
-- Thus do NOT interpret missing snapshots as proof that Blitz is offline.
-- Do NOT raise promoted batch to 15/20 during the RPC timeout incident.
--
-- 1. Verify last successfully stored market data (historical baseline).
SELECT now() AS checked_at,
       count(*) FILTER (
         WHERE snapshot_at >= now() - interval '30 minutes'
           AND price_usd IS NOT NULL
           AND liquidity_usd IS NOT NULL
       ) AS valid_30m,
       max(snapshot_at) AS last_snapshot
FROM public.market_snapshots;

-- 2. Lightweight live database session/wait overview.
SELECT state, wait_event_type, wait_event, count(*) AS sessions
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state, wait_event_type, wait_event
ORDER BY sessions DESC;

-- 3. Confirm cutover jobs remain unchanged (read only).
-- Legacy HTTP enqueue jobs 20/23/30 should remain disabled.
-- DB-local processing jobs 10/21/24/31 should remain enabled.
SELECT jobid, active, jobname
FROM cron.job
WHERE jobid IN (10, 20, 21, 23, 24, 30, 31)
ORDER BY jobid;

-- 4. Inspect cumulative database counters; do not infer current rate from totals.
SELECT numbackends, deadlocks, temp_bytes, blks_read, blks_hit,
       xact_commit, xact_rollback
FROM pg_stat_database
WHERE datname = current_database();

-- 5. Optional query-performance aggregate; no query text or user data returned.
SELECT queryid, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       temp_blks_written, shared_blks_read
FROM pg_stat_statements
ORDER BY temp_blks_written DESC
LIMIT 12;

-- Log verification (Supabase unified logs API, not executable in Postgres):
-- Check postgrest_logs: HTTP status by 5-minute bucket for worker RPCs.
-- Check postgres_logs: statement timeout, cron startup timeout, SQLSTATE.
-- Recovery gate: require two consecutive successful promoted-market RPC cycles,
-- no unexpected HTTP 500, new valid snapshots <=15 minutes old, and the
-- existing production Fusion/Risk/Social/Smart Money quality gates.
-- Keep PROMOTED_MARKET_BATCH_SIZE at 10 until the database incident is resolved.
-- Rollback: none required for this file; it makes no changes.
