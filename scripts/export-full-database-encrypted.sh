#!/usr/bin/env bash
# ARIAN TERMINAL logical disaster-recovery export (COPY ONLY).
# A full pg_dump, not just the three historical archive tables.
# Intended for a controlled, temporary, external backup runner.
set -Eeuo pipefail
umask 077

for var in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD AGE_RECIPIENT ARCHIVE_DIR; do
  if [[ -z "${!var:-}" ]]; then echo "Missing required setting: $var" >&2; exit 2; fi
done
for exe in pg_dump age sha256sum; do
  command -v "$exe" >/dev/null || { echo "Missing tool: $exe" >&2; exit 2; }
done
if [[ "$(pg_dump --version)" != *" 17."* ]]; then
  echo 'PostgreSQL 17 pg_dump is required' >&2; exit 2
fi
if [[ "$AGE_RECIPIENT" != age1* ]]; then
  echo 'Use the owner-held age public recipient only' >&2; exit 2
fi
case "$ARCHIVE_DIR" in
  /*) ;;
  *) echo 'ARCHIVE_DIR must be absolute' >&2; exit 2 ;;
esac
[[ -d "$ARCHIVE_DIR" && -w "$ARCHIVE_DIR" ]] || {
  echo 'ARCHIVE_DIR must exist and be writable' >&2; exit 2
}
# Do not permit cleartext PostgreSQL connections.
# verify-full is preferred when a trusted certificate chain is configured.
if [[ "${PGSSLMODE:-}" != "require" && "${PGSSLMODE:-}" != "verify-full" ]]; then
  echo 'PGSSLMODE must be require or verify-full' >&2; exit 2
fi

now="$(date -u +%Y%m%dT%H%M%SZ)"
base="$ARCHIVE_DIR/arian-terminal-full-pg17-$now"
partial="$base.partial"
encrypted="$base.pgcustom.age"
manifest="$base.sha256"
if [[ -e "$partial" || -e "$encrypted" || -e "$manifest" ]]; then
  echo 'Output already exists; refusing overwrite' >&2; exit 2
fi
trap 'rm -f -- "$partial"' EXIT
# PostgreSQL dump streams directly to age. No unencrypted dump on disk.
# No pg_dump --clean, --create, --disable-triggers, or destructive SQL.
# --no-owner/--no-acl ease isolated inspection; do NOT claim exact roles/grants restore.
pg_dump --format=custom --no-owner --no-acl \
  | age -r "$AGE_RECIPIENT" -o "$partial"
[[ -s "$partial" ]] || { echo 'Encrypted dump empty' >&2; exit 1; }
mv -n -- "$partial" "$encrypted"
sha256sum "$encrypted" > "$manifest"
sha256sum -c --status "$manifest" || { echo 'Checksum mismatch' >&2; exit 1; }
echo "Encrypted full logical dump: $encrypted"
echo "Manifest: $manifest"
echo 'NOT VERIFIED FOR RESTORE. Separate roles, extensions, grants, and auth/storage backing files must be assessed. Never delete production rows.'
