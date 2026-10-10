import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script = readFileSync(new URL('../scripts/export-full-database-encrypted.sh', import.meta.url),'utf8');
test('full encrypted backup: no plaintext file and no destructive commands',()=>{
  assert.match(script,/set -Eeuo pipefail/);
  assert.match(script,/umask 077/);
  assert.match(script,/pg_dump --format=custom --no-owner --no-acl/);
  assert.match(script,/\| age -r/);
  assert.match(script,/sha256sum -c --status/);
  assert.match(script,/PGSSLMODE/);
  assert.match(script,/NOT VERIFIED FOR RESTORE/);
  assert.doesNotMatch(script,/--table=public\./);
  assert.doesNotMatch(script,/\b(?:DELETE FROM|TRUNCATE TABLE|DROP TABLE|VACUUM FULL|pg_restore\s+--clean)\b/i);
});
