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

-- Live triage addendum 2026-10-09 04:40 UTC:
-- A plain SELECT 1 succeeded at 04:39:17 UTC, but follow-up session and
-- cron queries failed with connection timeout. In 03:55-04:40 UTC logs:
-- 92 PostgreSQL statement timeouts; PostgREST, postgres_exporter, and pg_cron
-- were all affected. No single lock holder has been proved responsible.
-- Run the following ONLY when a database connection is stable enough.
-- None of these queries mutates a job, terminates a session, or writes data.
--
-- 6. Recent cron outcomes from the last 300 runs (bounded by runid index).
WITH recent AS (
  SELECT jobid, status, start_time, end_time
  FROM cron.job_run_details
  ORDER BY runid DESC
  LIMIT 300
)
SELECT r.jobid, j.jobname, j.active,
       count(*) AS sampled_runs,
       count(*) FILTER (WHERE r.status = 'succeeded') AS succeeded,
       count(*) FILTER (WHERE r.status = 'failed') AS failed,
       max(r.start_time) AS last_started_at,
       max(r.end_time) AS last_finished_at
FROM recent r
LEFT JOIN cron.job j ON j.jobid = r.jobid
GROUP BY r.jobid, j.jobname, j.active
ORDER BY failed DESC, last_started_at DESC
LIMIT 40;

-- 7. Live blocked sessions / wait classes; no raw SQL or user records.
WITH sessions AS (
  SELECT application_name, state, wait_event_type, wait_event,
         cardinality(pg_blocking_pids(pid)) AS blocker_count
  FROM pg_stat_activity
  WHERE datname = current_database()
)
SELECT application_name, state, wait_event_type, wait_event,
       count(*) AS sessions, sum(blocker_count) AS blocker_references
FROM sessions
GROUP BY application_name, state, wait_event_type, wait_event
ORDER BY sessions DESC, blocker_references DESC
LIMIT 40;

-- 8. Match slow query IDs extracted from recent PostgreSQL timeout logs
-- (03:55-04:40 UTC) to pg_stat_statements, without revealing query text.
-- If query IDs are absent or the database restarted, zero rows is not proof
-- that the corresponding operations are fast or healthy.
SELECT queryid::text AS query_id, calls,
       round(total_exec_time::numeric,1) AS total_exec_ms,
       round(mean_exec_time::numeric,1) AS mean_exec_ms,
       temp_blks_written, shared_blks_read
FROM pg_stat_statements
WHERE queryid IN (
  -3134452293363749722, 6826527044204334315,
  3534378358638132998, -6045657266442029659,
  -2943341968674305036, -1230749210927073808,
  5197431765113000632, -8285757822602875730
)
ORDER BY total_exec_time DESC
LIMIT 12;

-- Exit criteria before any canary:
--   SQL reads return reliably; 2 consecutive promoted_market scheduled
--   successes with new valid snapshots; no worsening 57014/PGRST003 errors.
--   Do not change pg_cron schedules, force-kill sessions, or relax gates here.
