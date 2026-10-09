#!/usr/bin/env bash
# ARIAN TERMINAL: copy-only backup using pg_dump 17 + age encryption.
# Requirements: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD,
# AGE_RECIPIENT, ARCHIVE_DIR. No plaintext database dump is written.
# IMPORTANT: run on a secure, separate machine only after DB capacity is stable.
set -Eeuo pipefail
umask 077
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD must come from a secure secret store}"
: "${AGE_RECIPIENT:?owner-controlled age public recipient is required}"
: "${ARCHIVE_DIR:?output directory is required}"
command -v age >/dev/null || { echo 'Missing age CLI' >&2; exit 2; }
command -v pg_dump >/dev/null || { echo 'Missing pg_dump' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'Missing sha256sum' >&2; exit 2; }
case "$ARCHIVE_DIR" in /*) ;; *) echo 'ARCHIVE_DIR must be an absolute path' >&2; exit 2 ;; esac
test -d "$ARCHIVE_DIR" || { echo 'ARCHIVE_DIR must exist' >&2; exit 2; }
if [[ "$AGE_RECIPIENT" != age1* ]]; then
  echo 'AGE_RECIPIENT must be an age public-key recipient, not a secret' >&2; exit 2
fi
if [[ "$(pg_dump --version)" != *" 17."* ]]; then
  echo 'pg_dump 17 required for the current PostgreSQL 17 source' >&2; exit 2
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$ARCHIVE_DIR/arian-terminal-snapshot-copy-$STAMP"
OUT="$BASE.pgcustom.age"
TMP="$BASE.partial"
MANIFEST="$BASE.sha256"
trap 'rm -f -- "$TMP"' EXIT
if [[ -e "$OUT" || -e "$TMP" || -e "$MANIFEST" ]]; then
  echo 'Refusing to overwrite existing archive' >&2; exit 2
fi
# All three tables are BACKED UP only; raw_events must never be auto-deleted.
# Single pg_dump process gives one consistent snapshot across selected tables.
pg_dump --format=custom --no-owner --no-acl \
  --table=public.asset_feature_snapshots \
  --table=public.wallet_feature_snapshots \
  --table=public.raw_events \
  | age -r "$AGE_RECIPIENT" -o "$TMP"
test -s "$TMP" || { echo 'Empty encrypted output' >&2; exit 1; }
mv -n -- "$TMP" "$OUT"
sha256sum "$OUT" > "$MANIFEST"
sha256sum --check --status "$MANIFEST" || { echo 'Checksum verification failed' >&2; exit 1; }
printf 'COPY ONLY: %s\nSHA256: %s\n' "$OUT" "$MANIFEST"
printf 'NOT A RECOVERY CERTIFICATE: restore to isolated PostgreSQL 17 and validate rows/FKs before any deletion.\n'
