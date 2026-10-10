# ARIAN TERMINAL — Safe Archive Readiness

Date: 2026-10-10

This document records a read-only archive readiness checkpoint. It contains no credentials or secrets.

## Safety rules
- No production rows are deleted or modified during archive preparation.
- No Worker deploy/restart is performed.
- No secret, token, password, service-role key, or connection string is committed.
- Production cleanup is forbidden until an external archive is created, verified, and restore-tested.

## Current database observations
- Supabase project: arian-terminal
- Project status observed: ACTIVE_HEALTHY
- Approximate database size observed: 1.15 GB

Largest historical-data candidates observed:
- public.asset_feature_snapshots — ~500 MB
- public.raw_events — ~220 MB
- public.wallet_feature_snapshots — ~190 MB

These are candidates only. Nothing has been deleted, truncated, moved, or altered.

## Required archive sequence
1. Confirm a writable external archive destination.
2. Export historical rows in bounded date ranges.
3. Record per-chunk row counts and checksums/hashes where practical.
4. Verify archive readability.
5. Perform restore test into a non-production target.
6. Compare row counts / integrity checks.
7. Only after successful restore verification, prepare a separate reviewed cleanup proposal.
8. Production deletion remains out of scope until explicit later approval and verified backup recovery.

## Current blocker
A direct Supabase metadata query intermittently returned connection timeout. Archive writes to an external destination must not begin until destination access is confirmed and the source connection is stable enough for bounded read-only exports.
