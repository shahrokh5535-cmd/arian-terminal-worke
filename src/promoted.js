// Keep target selection and all normalization/scoring in the existing database.
export function createPromotedCollector({ kind, rpc, fetchJson, enabled, intervalMs = 300_000,
  batchSize = kind === "market" ? 20 : 1, log = console.log }) {
  if (!["market", "signatures"].includes(kind)) throw new Error("Invalid promoted collector kind");
  let running = false, lastRun = null, probePassed = false;
  const name = `promoted_${kind}`;
  const claimRpc = `arian_external_claim_${name}_v1`;
  const ingestRpc = `arian_external_ingest_${name}_v1`;
  const peekRpc = `arian_external_peek_${name}_v1`;
  const maxBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, kind === "market" ? 20 : 10));

  function providerErrorForDatabase(error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (kind === "market" && message === "Promoted DexScreener pair identity mismatch") return message;
    return "External HTTP collection failed";
  }

  async function collect(target) {
    const address = kind === "market" ? target.pair_address : target.pool_address;
    if (typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("Invalid promoted pool address");
    if (kind === "market") {
      const { response, payload } = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`, {}, 12_000);
      if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
      const pair = payload?.pair || payload?.pairs?.find(x => x?.pairAddress === address);
      if (!pair || pair.chainId !== "solana" || pair.dexId !== "pumpswap" || pair.pairAddress !== address) {
        throw new Error("Promoted DexScreener pair identity mismatch");
      }
      return { payload: { pair }, summary: { pair_address: address, price_usd: pair.priceUsd ?? null } };
    }
    const { response, payload } = await fetchJson("https://api.mainnet-beta.solana.com", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
        params: [address, { limit: 3, commitment: "finalized" }] })
    }, 12_000);
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    if (payload?.error) throw new Error(`Solana RPC error ${payload.error.code}`);
    if (payload?.jsonrpc !== "2.0" || !Array.isArray(payload.result) || payload.result.some(x => typeof x?.signature !== "string" || !x.signature)) {
      throw new Error("Invalid promoted Solana signature payload");
    }
    return { payload, summary: { pool_address: address, signatures_fetched: payload.result.length } };
  }

  async function probe() {
    const started = Date.now();
    const target = await rpc(peekRpc, {});
    if (target?.status === "idle") return { status: "idle", mode: "shadow_probe", writes_to_supabase: false };
    if (target?.status !== "ready") throw new Error("Invalid promoted target response");
    const result = await collect(target);
    return { status: "success", mode: "shadow_probe", provider: kind === "market" ? "dexscreener" : "solana_rpc",
      writes_to_supabase: false, ...result.summary, latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
  }

  async function run() {
    if (running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    running = true;
    const startedAt = new Date().toISOString();
    let claim = null, writes = false;
    const items = [];
    const failures = [];
    let attempted = 0;
    try {
      if (!probePassed) {
        const shadow = await probe();
        if (shadow.status !== "success") {
          lastRun = { ...shadow, mode: "external_ingest", started_at: startedAt, finished_at: new Date().toISOString() };
          return lastRun;
        }
        probePassed = true;
      }
      writes = true;
      for (let i = 0; i < maxBatchSize; i++) {
        claim = null;
        claim = await rpc(claimRpc, {});
        if (claim?.status === "idle") break;
        if (claim?.status !== "claimed" || !claim.run_id) throw new Error("Invalid promoted claim response");
        attempted++;

        try {
          const result = await collect(claim);
          const body = { p_run_id: claim.run_id, p_payload: result.payload, p_error: null };
          let db;
          try { db = await rpc(ingestRpc, body, 45_000); }
          catch (e) {
            if (!/timeout|aborted|fetch failed/i.test(e.message)) throw e;
            // The run ID is an idempotency key. Retry only a lost/timeout delivery once.
            db = await rpc(ingestRpc, body, 45_000);
          }
          if (db?.status !== "success") throw new Error("Promoted ingestion did not succeed");
          items.push({ run_id: claim.run_id, ...result.summary, database_result: db });
        } catch (e) {
          let db = null;
          try {
            db = await rpc(ingestRpc, {
              p_run_id: claim.run_id,
              p_payload: null,
              p_error: providerErrorForDatabase(e)
            });
          } catch {}
          failures.push({ run_id: claim.run_id, error: e instanceof Error ? e.message : "unknown_error", database_result: db });
        } finally {
          claim = null;
        }
      }

      if (attempted === 0) {
        lastRun = { status: "idle", mode: "external_ingest", writes_to_supabase: true, started_at: startedAt,
          finished_at: new Date().toISOString(), reason: "no_target", batch_size: maxBatchSize, targets_processed: 0,
          successful_targets: 0, failed_targets: 0 };
        return lastRun;
      }

      const status = items.length > 0 ? "success" : "error";
      lastRun = { status, mode: "external_ingest", provider: kind === "market" ? "dexscreener" : "solana_rpc",
        started_at: startedAt, finished_at: new Date().toISOString(), checked_at: new Date().toISOString(),
        latency_ms: Date.now() - Date.parse(startedAt), writes_to_supabase: true,
        batch_size: maxBatchSize, targets_processed: attempted, successful_targets: items.length,
        failed_targets: failures.length, items, failures,
        ...(status === "error" ? { error: "Promoted batch failed" } : {}) };
      log(JSON.stringify({ event: `${name}_run`, ...lastRun }));
      return lastRun;
    } catch (e) {
      if (claim?.run_id) {
        await rpc(ingestRpc, {
          p_run_id: claim.run_id,
          p_payload: null,
          p_error: providerErrorForDatabase(e)
        }).catch(() => {});
      }
      lastRun = { status: "error", mode: "external_ingest", provider: kind === "market" ? "dexscreener" : "solana_rpc",
        started_at: startedAt, finished_at: new Date().toISOString(), writes_to_supabase: writes,
        batch_size: maxBatchSize, targets_processed: attempted, successful_targets: items.length,
        failed_targets: failures.length, error: e instanceof Error ? e.message : "unknown_error" };
      log(JSON.stringify({ event: `${name}_run`, ...lastRun }));
      throw e;
    } finally { running = false; }
  }

  return { run, probe, status: () => ({ enabled, interval_ms: intervalMs, batch_size: maxBatchSize, running, last_run: lastRun }) };
}
