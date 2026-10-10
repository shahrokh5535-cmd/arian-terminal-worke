-- ARIAN TERMINAL: live read-only health checks (2026-10-10)
-- Execute in the authorized Supabase SQL editor; SELECT only.
-- No user rows, secrets, data changes, locks, exports or deployments.
-- Timestamps are UTC; interpret with your local timezone.
-- Freshness thresholds below are monitoring hints, not production SLAs.

-- 1. Market snapshot ingestion cadence.
SELECT now() AS checked_at,
       count(*) FILTER (WHERE snapshot_at >= now() - interval '30 minutes') AS snapshots_30m,
       count(*) FILTER (WHERE snapshot_at >= now() - interval '1 hour') AS snapshots_1h,
       max(snapshot_at) AS last_snapshot_at,
       now() - max(snapshot_at) AS snapshot_age
FROM public.market_snapshots;

-- 2. Pipeline v2.9 execution health in the last hour.
SELECT now() AS checked_at,
       count(*) FILTER (WHERE started_at >= now() - interval '1 hour') AS runs_1h,
       count(*) FILTER (WHERE started_at >= now() - interval '1 hour'
           AND lower(pipeline_status) = 'completed') AS completed_1h,
       count(*) FILTER (WHERE started_at >= now() - interval '1 hour'
           AND lower(pipeline_status) IN ('failed','error','blocked')) AS failures_1h,
       max(started_at) AS last_pipeline_at
FROM public.arian_pipeline_runs;

-- 3. Health history freshness (can be stale even while pipeline runs succeed).
SELECT now() AS checked_at, max(checked_at) AS last_health_check,
       now() - max(checked_at) AS health_history_age
FROM public.arian_pipeline_health_history;

-- 4. Database usage and waiting lock sessions.
SELECT now() AS checked_at, pg_database_size(current_database()) AS db_bytes,
       (SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock') AS lock_waiters;

-- Interpretation:
-- * A healthy Supabase project plus fresh market_snapshots is NOT proof that
--   Cloudflare Worker Blitz itself is healthy; inspect Worker telemetry separately.
-- * arian_pipeline_health_history has historically been stale. Do not infer
--   pipeline failure from an old history row without checking arian_pipeline_runs.
-- * PostgreSQL dump is NOT a complete Supabase recovery: Storage object bytes,
--   roles, extensions and independent restore tests remain out of scope.
