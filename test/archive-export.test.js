import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("archive export only copies data and requires encryption", () => {
  const s = readFileSync(new URL("../scripts/export-snapshot-archive.sh", import.meta.url), "utf8");
  assert.match(s, /set -Eeuo pipefail/);
  assert.match(s, /umask 077/);
  for (const key of ["PGHOST","PGPORT","PGDATABASE","PGUSER","PGPASSWORD","AGE_RECIPIENT","ARCHIVE_DIR"]) {
    assert.ok(s.includes(key), key);
  }
  assert.match(s,/pg_dump --format=custom --no-owner --no-acl/);
  assert.match(s,/\| age -r/);
  assert.match(s,/sha256sum --check/);
  assert.match(s,/--table=public\.raw_events/);
  assert.doesNotMatch(s,/\b(?:DELETE FROM|TRUNCATE|DROP TABLE|ALTER TABLE|VACUUM FULL|pg_terminate_backend)\b/i);
  assert.doesNotMatch(s,/r2\.cloudflarestorage\.com|dash\.cloudflare\.com/);
});
