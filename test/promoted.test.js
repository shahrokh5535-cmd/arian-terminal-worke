import test from "node:test";
import assert from "node:assert/strict";
import { createPromotedCollector } from "../src/promoted.js";

const address = "A".repeat(32);
function setup(kind, { mismatch = false, lostDelivery = false, apiError = false } = {}) {
  const calls = [];
  let fetched = 0, delivered = 0;
  const target = { pair_address: address, pool_address: address };
  const worker = createPromotedCollector({ kind, enabled: true, log: () => {},
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
  test(`${kind} provider failure releases a claimed run`, async () => {
    const { worker, calls } = setup(kind, { apiError: true });
    await assert.rejects(worker.run(), /429/);
    const release = calls.find(x => x.body?.p_error);
    assert.equal(release.body.p_run_id, 123);
    assert.equal(release.body.p_payload, null);
    assert.equal(worker.status().running, false);
  });
}
test("market rejects mismatched pair identity before claiming any work", async () => {
  const { worker, calls } = setup("market", { mismatch: true });
  await assert.rejects(worker.run(), /identity mismatch/);
  assert.equal(calls.some(x => x.name.includes("claim")), false);
});
