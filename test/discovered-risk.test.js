import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveredRiskCollector } from "../src/discovered-risk.js";

function setup({ failFirst = false, invalidScore = false, timeout = false, block = null } = {}) {
  const calls = []; let fetches = 0, deliveries = 0;
  const worker = createDiscoveredRiskCollector({ enabled: true, intervalMs: 1, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("claim")) return { status: "claimed", claims: [1, 2].map(run_id => ({ run_id, mint: "A".repeat(32) })) };
      if (!body.p_error && timeout && ++deliveries === 1) throw new Error("timeout");
      return { status: body.p_error ? "failed" : "success", run_id: body.p_run_id };
    },
    fetchJson: async () => {
      fetches++;
      if (block) await block;
      if (failFirst && fetches === 2) return { response: { ok: false, status: 404 } };
      return { response: { ok: true }, payload: { score_normalised: invalidScore ? null : 20 } };
    }
  });
  return { worker, calls };
}
test("probe performs no database writes and enforces conservative interval", async () => {
  const { worker, calls } = setup();
  assert.equal((await worker.probe()).writes_to_supabase, false);
  assert.equal(calls.length, 0);
  assert.equal(worker.status().interval_ms, 600_000);
});
test("404 releases first claim with backoff reason and second token still succeeds", async () => {
  const { worker, calls } = setup({ failFirst: true });
  const result = await worker.run();
  assert.equal(result.status, "partial_error");
  assert.equal(result.database_results[1].status, "success");
  const failed = calls.find(x => x.body.p_error);
  assert.equal(failed.body.p_error, "HTTP 404");
  assert.equal(failed.body.p_run_id, 1);
  assert.equal(failed.body.p_payload, null);
});
test("lost ingestion response retries identical idempotency payload", async () => {
  const { worker, calls } = setup({ timeout: true });
  assert.equal((await worker.run()).status, "success");
  const deliveries = calls.filter(x => x.name.includes("ingest"));
  assert.deepEqual(deliveries[0].body, deliveries[1].body);
});
test("null score cannot become zero and no claim is created after failed probe", async () => {
  const { worker, calls } = setup({ invalidScore: true });
  await assert.rejects(worker.probe(), /Invalid RugCheck/);
  assert.equal((await worker.run()).status, "error");
  assert.equal(calls.length, 0);
});
test("overlapping scheduler run is skipped", async () => {
  let unblock; const block = new Promise(resolve => { unblock = resolve; });
  const { worker } = setup({ block });
  const first = worker.run();
  assert.equal((await worker.run()).reason, "already_running");
  unblock(); await first;
  assert.equal(worker.status().running, false);
});
