# ARIAN TERMINAL — PostgREST Recovery

Date: 2026-10-11

## Root cause
PostgREST was repeatedly returning HTTP 503 / PGRST002 because it could not query/load its schema cache before the authenticator role's 8-second statement timeout expired.

The database was also under broad load from overlapping recurring jobs whose observed runtimes included roughly 50–95 seconds, causing multiple jobs to overlap on a small instance.

## Temporary mitigation
The following high-cost/nonessential cron jobs were temporarily disabled:
- 22 arian-production-intelligence-sync
- 27 arian-production-runtime-health
- 29 arian-production-reports
- 34 arian-production-fusion-batch-v1
- 35 arian-terminal-public-cache-refresh
- 36 arian-terminal-discovery-wallet-cache
- 37 arian-terminal-token-detail-cache

No application rows were deleted. No Worker deploy or restart was performed.

The authenticator role statement_timeout was temporarily increased from 8s to 30s and PostgREST config/schema reload notifications were sent.

## Verified recovery
PostgREST subsequently logged:
- Schema cache queried in 25,760.3 ms
- Schema cache loaded in 2,717.3 ms
- 112 Relations
- 78 Relationships
- 180 Functions
- 1,196 Timezones

A direct SQL ping succeeded.

market_snapshots resumed:
- latest verified snapshot_at: 2026-10-11 17:43:06.499806+00
- verification database time: 2026-10-11 17:43:41.449834+00
- freshness at verification: about 35 seconds

## Remaining caution
The database still showed intermittent management-connection timeouts during follow-up diagnostics. Keep the temporary load shed in place and monitor before re-enabling jobs. Re-enable jobs one at a time with less overlap / lower cadence.
