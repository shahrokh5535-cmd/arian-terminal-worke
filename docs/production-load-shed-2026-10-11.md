# ARIAN TERMINAL — Temporary Production Load Shed

Date: 2026-10-11

## Cause identified
PostgREST returned PGRST002 because it could not refresh/query its schema cache. PostgreSQL logged SQLSTATE 57014 statement timeouts while the database was under broad load. Worker 0.11.0 requests then received HTTP 503 even though the Worker itself was still sending requests.

Long-running recurring jobs observed immediately before mitigation included:
- arian-terminal-public-cache-refresh: ~95 s
- arian-terminal-token-detail-cache: ~92 s
- arian-production-runtime-health: ~51–81 s
- arian-production-intelligence-sync: ~52–55 s
- arian-production-fusion-batch-v1: >90 s in a live run
- arian-production-reports: also timed out in the same pressure window

The jobs are scheduled closely enough that these runtimes can overlap and saturate a small database instance.

## Temporary reversible mitigation applied
The following cron jobs were deactivated only; no application rows were deleted and no Worker deploy/restart was performed:
- 22 arian-production-intelligence-sync
- 27 arian-production-runtime-health
- 29 arian-production-reports
- 34 arian-production-fusion-batch-v1
- 35 arian-terminal-public-cache-refresh
- 36 arian-terminal-discovery-wallet-cache
- 37 arian-terminal-token-detail-cache

Core ingestion/market/risk/fusion jobs not listed above remain enabled.

## Rollback
Each job can be reactivated with cron.alter_job(job_id := <id>, active := true) after database latency is stable and schedules are redesigned to avoid overlap.

## Verification so far
- Direct SQL SELECT 1 succeeded after load shedding.
- Connection count was low at the verification point.
- market_snapshots was still stale at 2026-10-11 14:32:47 UTC at the last direct read, so ingestion recovery was not yet confirmed.
