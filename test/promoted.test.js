import test from "node:test";
import assert from "node:assert/strict";
import { createPromotedCollector } from "../src/promoted.js";

const address = "A".repeat(32);
function setup(kind, { mismatch = false, lostDelivery = false, apiError = false } = {}) {
  const calls = [];
  let fetched = 0, delivered = 0;
  const target = { pair_address: address, pool_address: address };
  const worker = createPromotedCollector({ kind, enabled: true, batchSize: 1, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("peek")) return { status: "ready", ...target };
      if (name.includes("claim")) return { status: "claimed", run_id: 123, ...target };
      delivered++;
      if (lostDelivery && delivered === 1) throw new Error("The operation was aborted due to timeout");
      return { status: body.p_error ? "failed" : "success", run_id: 123 };
    },
    fetchJson: async () => {
      fetched++;
      if (apiError && fetched > 1) return { response: { ok: false, status: 429 } };
      return { response: { ok: true }, payload: kind === "market"
        ? { pairs: [{ pairAddress: mismatch ? "B".repeat(32) : address, chainId: "solana", dexId: "pumpswap", priceUsd: "1" }] }
        : { jsonrpc: "2.0", result: [{ signature: "signature", slot: 123, err: null }] } };
    }
  });
  return { worker, calls };
}
for (const kind of ["market", "signatures"]) {
  test(`${kind} probe only uses the read-only target RPC`, async () => {
    const { worker, calls } = setup(kind);
    assert.equal((await worker.probe()).writes_to_supabase, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].name, /peek/);
  });
  test(`${kind} ingestion retries a lost response with the same run ID`, async () => {
    const { worker, calls } = setup(kind, { lostDelivery: true });
    assert.equal((await worker.run()).status, "success");
    const deliveries = calls.filter(x => x.name.includes("ingest"));
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries[0].body, deliveries[1].body);
    assert.equal(worker.status().running, false);
  });
  test(`${kind} provider failure releases a claimed run without wedging the scheduler`, async () => {
    const { worker, calls } = setup(kind, { apiError: true });
    const result = await worker.run();
    assert.equal(result.status, "error");
    assert.equal(result.failed_targets, 1);
    const release = calls.find(x => x.body?.p_error);
    assert.equal(release.body.p_run_id, 123);
    assert.equal(release.body.p_payload, null);
    assert.equal(release.body.p_error, "External HTTP collection failed");
    assert.equal(worker.status().running, false);
  });
}
test("market rejects mismatched pair identity before claiming any work", async () => {
  const { worker, calls } = setup("market", { mismatch: true });
  await assert.rejects(worker.run(), /identity mismatch/);
  assert.equal(calls.some(x => x.name.includes("claim")), false);
});

test("market default batch processes twenty promoted targets sequentially", async () => {
  const calls = [];
  let nextRun = 1;
  const worker = createPromotedCollector({ kind: "market", enabled: true, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("peek")) return { status: "ready", pair_address: address };
      if (name.includes("claim")) return { status: "claimed", run_id: nextRun++, pair_address: address };
      return { status: "success", run_id: body.p_run_id };
    },
    fetchJson: async () => ({ response: { ok: true }, payload: {
      pairs: [{ pairAddress: address, chainId: "solana", dexId: "pumpswap", priceUsd: "1" }]
    } })
  });

  const result = await worker.run();
  assert.equal(result.status, "success");
  assert.equal(result.batch_size, 20);
  assert.equal(result.targets_processed, 20);
  assert.equal(result.successful_targets, 20);
  assert.equal(result.failed_targets, 0);
  assert.equal(calls.filter(x => x.name.includes("claim")).length, 20);
  assert.equal(calls.filter(x => x.name.includes("ingest")).length, 20);
  assert.equal(worker.status().batch_size, 20);
});

test("market batch continues after one claimed target fails identity validation", async () => {
  const calls = [];
  let nextRun = 1;
  let claimCount = 0;
  const badAddress = "B".repeat(32);
  const worker = createPromotedCollector({ kind: "market", enabled: true, log: () => {},
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("peek")) return { status: "ready", pair_address: address };
      if (name.includes("claim")) {
        claimCount++;
        return { status: "claimed", run_id: nextRun++, pair_address: claimCount === 1 ? badAddress : address };
      }
      return { status: body.p_error ? "failed" : "success", run_id: body.p_run_id };
    },
    fetchJson: async (url) => {
      const requested = url.split('/').at(-1);
      return { response: { ok: true }, payload: {
        pairs: [{ pairAddress: requested === badAddress ? address : requested, chainId: "solana", dexId: "pumpswap", priceUsd: "1" }]
      } };
    }
  });

  const result = await worker.run();
  assert.equal(result.status, "success");
  assert.equal(result.targets_processed, 20);
  assert.equal(result.successful_targets, 19);
  assert.equal(result.failed_targets, 1);
  assert.equal(calls.filter(x => x.name.includes("claim")).length, 20);
  assert.equal(calls.filter(x => x.name.includes("ingest")).length, 20);
  const failedDelivery = calls.find(x => x.body?.p_error);
  assert.equal(failedDelivery.body.p_error, "Promoted DexScreener pair identity mismatch");
});
