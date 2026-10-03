import test from "node:test";
import assert from "node:assert/strict";
import { createXPublicSocialCollector } from "../src/x-public-social.js";

function setup({ apiError = false, mismatch = false, timeout = false, unknownDelivery = false, idle = false, block = null, batchSize = 1 } = {}) {
  const calls = []; let fetches = 0, deliveries = 0;
  const worker = createXPublicSocialCollector({ enabled: true, intervalMs: 1, batchSize, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("peek")) return { status: "ready", tweet_id: "123" };
      if (name.includes("claim")) return idle ? { status: "idle" } : { status: "claimed", run_id: 42, tweet_id: "123" };
      if (!body.p_error && (timeout || unknownDelivery) && ++deliveries <= (unknownDelivery ? 2 : 1)) throw new Error("timeout");
      return { status: unknownDelivery || !body.p_error ? "success" : "failed", run_id: 42, content_id: 11 };
    },
    fetchJson: async () => {
      fetches++;
      if (block) await block;
      if (apiError && fetches > 1) return { response: { ok: false, status: 404 } };
      return { response: { ok: true }, payload: { code: 200, tweet: { id: mismatch ? "999" : "123", text: "Token news", author: { screen_name: "test" } } } };
    }
  });
  return { worker, calls };
}

test("probe is read-only and interval cannot exceed free API polling budget", async () => {
  const { worker, calls } = setup();
  assert.equal((await worker.probe()).writes_to_supabase, false);
  assert.equal(calls.length, 1); assert.match(calls[0].name, /peek/);
  assert.equal(worker.status().interval_ms, 600_000);
});

test("mismatched tweet identity is rejected before claiming", async () => {
  const { worker, calls } = setup({ mismatch: true });
  assert.equal((await worker.run()).status, "error");
  assert.equal(calls.some(x => x.name.includes("claim")), false);
});

test("404 persists a bounded backoff reason and releases the claim", async () => {
  const { worker, calls } = setup({ apiError: true });
  assert.equal((await worker.run()).status, "error");
  const release = calls.find(x => x.body?.p_error);
  assert.deepEqual(release.body, { p_run_id: 42, p_payload: null, p_error: "HTTP 404" });
  assert.equal(worker.status().running, false);
});

test("lost ingestion response retries identical run and payload", async () => {
  const { worker, calls } = setup({ timeout: true });
  assert.equal((await worker.run()).status, "success");
  const deliveries = calls.filter(x => x.name.includes("ingest"));
  assert.equal(deliveries.length, 2); assert.deepEqual(deliveries[0].body, deliveries[1].body);
});

test("terminal success remains success when both delivery responses are lost", async () => {
  const { worker, calls } = setup({ unknownDelivery: true });
  const result = await worker.run();
  assert.equal(result.status, "success"); assert.equal(result.error, undefined);
  assert.equal(calls.filter(x => x.name.includes("ingest")).length, 3);
});

test("idle target is reported without ingestion", async () => {
  const { worker, calls } = setup({ idle: true });
  assert.equal((await worker.run()).status, "idle");
  assert.equal(calls.some(x => x.name.includes("ingest")), false);
});

test("overlapping run is skipped and lock is released", async () => {
  let unblock; const block = new Promise(resolve => { unblock = resolve; });
  const { worker } = setup({ block }); const first = worker.run();
  assert.equal((await worker.run()).reason, "already_running");
  unblock(); await first; assert.equal(worker.status().running, false);
});

test("default X social batch processes five posts sequentially", async () => {
  const calls = [];
  let nextRun = 1;
  const worker = createXPublicSocialCollector({ enabled: true, intervalMs: 600_000, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("peek")) return { status: "ready", tweet_id: "123" };
      if (name.includes("claim")) {
        const id = String(122 + nextRun);
        return { status: "claimed", run_id: nextRun++, tweet_id: id };
      }
      return { status: "success", run_id: body.p_run_id, content_id: body.p_run_id };
    },
    fetchJson: async (url) => {
      const id = url.split("/").pop();
      return { response: { ok: true }, payload: { code: 200, tweet: { id, text: "Token news", author: { screen_name: "test" } } } };
    }
  });

  const result = await worker.run();
  assert.equal(result.status, "success");
  assert.equal(result.batch_size, 5);
  assert.equal(result.targets_processed, 5);
  assert.equal(result.succeeded, 5);
  assert.equal(result.failed, 0);
  assert.equal(calls.filter(x => x.name.includes("claim")).length, 5);
  assert.equal(calls.filter(x => x.name.includes("ingest")).length, 5);
  assert.equal(worker.status().batch_size, 5);
});
