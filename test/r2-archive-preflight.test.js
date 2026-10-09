import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("R2 preflight SQL is read-only and bounded", () => {
  const sql = readFileSync(new URL("../db/r2_archive_preflight.sql", import.meta.url), "utf8");
  const plain = sql.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  const statements = plain.split(";").map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 8);
  for (const statement of statements) assert.match(statement, /^SELECT\b/i);
  assert.doesNotMatch(plain, /\b(?:DELETE|TRUNCATE|DROP|ALTER|INSERT|UPDATE|CREATE|REVOKE|GRANT|VACUUM|pg_terminate_backend|pg_cancel_backend|COPY|CALL|DO)\b/i);
  assert.match(plain, /cron\.job_run_details ORDER BY runid DESC LIMIT 12/i);
  assert.match(plain, /pg_total_relation_size\(relid\)/i);
  assert.match(plain, /pg_stat_activity/i);
});

test("archive runbook has explicit key safety gates", () => {
  const x = readFileSync(new URL("../docs/R2_ARCHIVE_RUNBOOK.md", import.meta.url), "utf8");
  for (const k of [
    "Cloudflare", "ON DELETE SET NULL", "raw_events", "SHA-256",
    "NON-PRODUCTION", "restore", "billing", "MFA", "No blind"
  ]) assert.ok(x.includes(k), `missing safety gate: ${k}`);
});
