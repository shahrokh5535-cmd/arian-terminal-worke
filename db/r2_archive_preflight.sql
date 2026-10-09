-- READ ONLY - ARIAN TERMINAL R2 preflight, 2026-10-09.
-- Not an export, not a backup, not a data movement; run only on source Supabase.
-- NOTE: with free-plan connection timeouts, stop rather than retry in a tight loop.

-- 1. Source identity, quota baseline and transaction state.
SELECT now() AS checked_at,
       current_database() AS db_name,
       pg_database_size(current_database()) AS database_bytes,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('server_version') AS pg_version;

-- 2. Largest objects; catalog-based estimates avoid scanning JSONB rows.
SELECT schemaname, relname, pg_total_relation_size(relid) AS total_bytes,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname='public'
ORDER BY total_bytes DESC LIMIT 25;

-- 3. Incoming foreign-key dependencies, including ON DELETE action.
SELECT c.confrelid::regclass::text AS referenced,
       c.conrelid::regclass::text AS referencing,
       c.conname,
       CASE c.confdeltype
         WHEN 'n' THEN 'SET NULL' WHEN 'c' THEN 'CASCADE'
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         ELSE c.confdeltype::text END AS on_delete
FROM pg_constraint c
WHERE c.contype='f'
  AND c.confrelid IN ('public.asset_feature_snapshots'::regclass,
                      'public.wallet_feature_snapshots'::regclass,
                      'public.raw_events'::regclass)
ORDER BY referenced, referencing;

-- 4. Routine readers/writers: identify dependencies; do not call any routine.
SELECT n.nspname AS schema_name, p.proname AS routine_name
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','arian_private')
  AND (pg_get_functiondef(p.oid) ILIKE '%asset_feature_snapshots%'
    OR pg_get_functiondef(p.oid) ILIKE '%wallet_feature_snapshots%'
    OR pg_get_functiondef(p.oid) ILIKE '%raw_events%')
ORDER BY schema_name,routine_name LIMIT 100;

-- 5. Trigger inventory: source data has integrity checks.
SELECT tgrelid::regclass::text AS table_name,tgname
FROM pg_trigger
WHERE tgrelid IN ('public.asset_feature_snapshots'::regclass,
                  'public.wallet_feature_snapshots'::regclass,
                  'public.raw_events'::regclass)
  AND NOT tgisinternal ORDER BY table_name,tgname;

-- 6. Active scheduler / connection pressure at the time of export.
SELECT current_setting('max_connections') AS max_connections,
       (SELECT count(*) FROM cron.job WHERE active) AS enabled_cron_jobs,
       (SELECT count(*) FROM pg_stat_activity
         WHERE datname=current_database()) AS db_connections,
       (SELECT count(*) FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters;

-- 7. Last few Cron outcomes; do not alter running jobs.
SELECT runid,jobid,status,start_time,left(return_message,120) AS outcome
FROM cron.job_run_details ORDER BY runid DESC LIMIT 12;

-- 8. Fusion market freshness (not affected by a copy to R2).
SELECT now() AS checked_at,
       max(snapshot_at) AS last_snapshot,
       count(*) FILTER (WHERE snapshot_at >= now()-interval '30 minutes'
                        AND price_usd IS NOT NULL AND liquidity_usd IS NOT NULL) AS valid_30m
FROM public.market_snapshots;

-- No commands in this file mutate data, schedules, permissions or billing.
