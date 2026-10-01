export function createSolanaDetails({ rpc, fetchJson, fetchSignatures, enabled, intervalMs = 300_000, log = console.log }) {
  const state = { running: false, lastRun: null };
  async function fetchDetail(txHash) {
    const { response, payload } = await fetchJson("https://api.mainnet-beta.solana.com", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [txHash, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 }] })
    }, 12_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!payload || payload.jsonrpc !== "2.0" || !("result" in payload || "error" in payload)) throw new Error("Invalid Solana RPC envelope");
    if (payload.error) throw new Error(`Solana RPC error ${payload.error.code}`);
    if (payload.result !== null && (!Array.isArray(payload.result?.transaction?.message?.accountKeys) || !payload.result?.meta)) {
      throw new Error("Invalid Solana transaction payload");
    }
    return payload;
  }
  async function probe() {
    const signatures = await fetchSignatures();
    const txHash = signatures.result[0]?.signature;
    if (!txHash) throw new Error("No signature available for detail shadow probe");
    const started = Date.now();
    const payload = await fetchDetail(txHash);
    if (!payload.result) throw new Error("Solana detail shadow probe returned null");
    return { status: "success", mode: "shadow_probe", provider: "solana_rpc", writes_to_supabase: false,
      tx_hash: txHash, slot: payload.result.slot, account_keys: payload.result.transaction.message.accountKeys.length,
      latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
  }
  async function run() {
    if (state.running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    state.running = true;
    const startedAt = new Date().toISOString();
    let wrote = false;
    try {
      // Validate the live response shape before the first scheduled claim after startup.
      if (!state.lastRun || state.lastRun.mode === "shadow_probe") await probe();
      wrote = true;
      const claim = await rpc("arian_external_claim_solana_transaction_details_v1", { p_limit: 2 });
      if (!Array.isArray(claim?.claims)) throw new Error("Invalid detail claim response");
      const results = [];
      for (const tx of claim.claims) {
        let payload = null, error = null;
        try { payload = await fetchDetail(tx.tx_hash); }
        catch (e) { error = e.message === "Solana RPC error 429" ? "HTTP 429" : e.message; }
        // Failed delivery leaves a bounded lease; another cycle can safely reclaim it.
        results.push(await rpc("arian_external_ingest_solana_transaction_detail_v1", {
          p_transaction_id: tx.transaction_id, p_run_id: tx.run_id, p_payload: payload, p_error: error
        }));
      }
      state.lastRun = { status: results.some(x => x.status !== "success") ? "error" : results.length ? "success" : "idle",
        mode: "external_ingest", provider: "solana_rpc", started_at: startedAt, finished_at: new Date().toISOString(),
        latency_ms: Date.now() - Date.parse(startedAt), checked_at: new Date().toISOString(), writes_to_supabase: true,
        database_result: results };
      log(JSON.stringify({ event: "solana_details_run", ...state.lastRun }));
      return state.lastRun;
    } catch (e) {
      state.lastRun = { status: "error", mode: "external_ingest", provider: "solana_rpc", started_at: startedAt,
        finished_at: new Date().toISOString(), writes_to_supabase: wrote, error: e.message };
      log(JSON.stringify({ event: "solana_details_run", ...state.lastRun }));
      throw e;
    } finally { state.running = false; }
  }
  return { run, probe, status: () => ({ enabled, interval_ms: intervalMs, running: state.running, last_run: state.lastRun }) };
}
