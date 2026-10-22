-- ARIAN TERMINAL safe rollback for 2026-10-22 temporary DB-local ingestion fallback.
-- Only jobs 1, 2 and 20 were changed. Restores their exact prior schedules and inactive state.
-- Review actual running queue before rollback: do not interrupt a still-pending HTTP response.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $guard$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobid IN(1,2,20) AND active)<>3 THEN
    RAISE EXCEPTION 'Expected exactly 3 active fallback jobs; review cron.job before rollback';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE
    (jobid=1 AND schedule='*/15 * * * *'
     AND command='SELECT public.arian_enqueue_dexscreener_market_ingestion();')
    OR (jobid=2 AND schedule='5,20,35,50 * * * *'
     AND command='SELECT public.arian_run_dexscreener_ingestion_worker();')
    OR (jobid=20 AND schedule='8,23,38,53 * * * *'
     AND command='SELECT public.arian_enqueue_promoted_market_snapshot();')
  )<>3 THEN RAISE EXCEPTION 'Fallback schedules/commands changed; manual review required'; END IF;
  PERFORM cron.alter_job(job_id=>1,schedule=>'*/5 * * * *',active=>false);
  PERFORM cron.alter_job(job_id=>2,schedule=>'1-59/3 * * * *',active=>false);
  PERFORM cron.alter_job(job_id=>20,schedule=>'2-59/5 * * * *',active=>false);
END $guard$;
COMMIT;
-- Safe verification:
-- SELECT jobid,schedule,active FROM cron.job WHERE jobid IN (1,2,20);
-- SELECT max(snapshot_at) FROM public.market_snapshots;

-- Context: On 2026-10-22 external Blitz-based ingestion last wrote around
-- 2026-10-18T10:16Z. Two isolated legacy HTTP/DB pilots succeeded:
-- ingestion_runs 60496 (DexScreener), 60497 (promoted market), HTTP 200.
-- Workload: each enqueuer every 15 min; processing job 2 every 15 min;
-- existing DB-local promoted worker job 21 unchanged.
-- Protected cron jobs 15,22,27,28,29,34,35,36,37 stay DISABLED.
-- Replacing/redeploying Blitz, changing secrets, or merging Stage D is OUT OF SCOPE.
