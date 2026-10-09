import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("incident SQL is bounded and entirely read-only", () => {
  const sql = readFileSync(new URL("../db/diagnose_rpc_timeout_incident.sql", import.meta.url), "utf8");
  const executable = sql.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  const statements = executable.split(";").map(s => s.trim()).filter(Boolean);
  assert.ok(statements.length >= 8, "expected historical and new incident triage checks");
  for (const statement of statements) assert.match(statement, /^(SELECT|WITH)\b/i);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|ANALYZE|CALL|DO|EXECUTE|pg_cancel_backend|pg_terminate_backend)\b/i);
  assert.match(executable, /cron\.job_run_details[\s\S]*?ORDER BY runid DESC\s+LIMIT 300/i);
  assert.match(executable, /pg_blocking_pids\(pid\)/);
  assert.match(executable, /pg_stat_statements[\s\S]*?ORDER BY total_exec_time DESC\s+LIMIT 12/i);
});
