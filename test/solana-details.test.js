import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaDetails } from "../src/solana-details.js";

const result = { slot: 10, transaction: { message: { accountKeys: [{ pubkey: "payer", signer: true }] } }, meta: { fee: 5000, err: null } };
function setup({ failure = false, deliveryFailure = false } = {}) {
  const calls = []; let requests = 0;
  const worker = createSolanaDetails({ enabled: true, log: () => {},
    fetchSignatures: async () => ({ result: [{ signature: "signature" }] }),
    fetchJson: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.params[1], { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 });
      requests++;
      return failure && requests > 1 ? { response: { ok: false, status: 429 }, payload: {} }
        : { response: { ok: true }, payload: { jsonrpc: "2.0", result } };
    },
    rpc: async (name, body) => {
      calls.push({ name, body });
      if (name.includes("claim")) return { claims: [{ transaction_id: 1, run_id: 2, tx_hash: "signature" }] };
      if (deliveryFailure) throw new Error("delivery unavailable");
      return { status: body.p_error ? "failed" : "success" };
    }
  });
  return { worker, calls };
}
test("shadow probe validates transaction shape without any database calls", async () => {
  const { worker, calls } = setup();
  assert.equal((await worker.probe()).writes_to_supabase, false);
  assert.equal(calls.length, 0);
});
test("scheduled collection probes first, claims and submits matching identifiers", async () => {
  const { worker, calls } = setup();
  const run = await worker.run();
  assert.equal(run.status, "success");
  assert.equal(run.writes_to_supabase, true);
  assert.equal(calls[1].body.p_transaction_id, 1);
  assert.equal(calls[1].body.p_run_id, 2);
  assert.equal(worker.status().running, false);
});
test("rate limit releases the claim through the ingestion RPC", async () => {
  const { worker, calls } = setup({ failure: true });
  assert.equal((await worker.run()).status, "error");
  assert.equal(calls[1].body.p_error, "HTTP 429");
  assert.equal(calls[1].body.p_payload, null);
});
test("failed database delivery releases the in-process lock", async () => {
  const { worker } = setup({ deliveryFailure: true });
  await assert.rejects(worker.run(), /delivery unavailable/);
  assert.equal(worker.status().running, false);
});
test("overlapping schedules are skipped", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const worker = createSolanaDetails({ enabled: true, log: () => {}, fetchSignatures: async () => {
    await wait; return { result: [] };
  } });
  const run = worker.run();
  assert.equal((await worker.run()).reason, "already_running");
  release();
  await assert.rejects(run, /No signature/);
});
