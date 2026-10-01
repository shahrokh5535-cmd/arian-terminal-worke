import { scheduleInterval } from "./schedule.js";

// Only HTTP collection lives here; target selection and safety scoring stay in SQL.
export function createDiscoveredRiskCollector({ rpc, fetchJson, enabled, intervalMs = 600_000, log = console.log }) {
  intervalMs = scheduleInterval(intervalMs, 600_000, 600_000);
  let running = false, lastRun = null, probePassed = false;
  const ingest = "arian_external_ingest_discovered_risk_v1";
  async function collect(mint) {
    if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("Invalid Solana mint");
    const { response, payload } = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {}, 12_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const score = payload?.score_normalised;
    if (!payload || Array.isArray(payload) || typeof payload !== "object" ||
        !["number", "string"].includes(typeof score) || String(score).trim() === "" ||
        !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 100 ||
        (payload.mint !== undefined && payload.mint !== mint)) throw new Error("Invalid RugCheck summary");
    return payload;
  }
  async function probe() {
    const started = Date.now();
    // A known live mint validates the provider without claiming or blocking on an unsupported discovered token.
    const mint = "So11111111111111111111111111111111111111112";
    await collect(mint);
    return { status: "success", mode: "shadow_probe", provider: "rugcheck", sample_mint: mint,
      writes_to_supabase: false, checked_at: new Date().toISOString(), latency_ms: Date.now() - started };
  }
  async function run() {
    if (running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    running = true;
    const startedAt = new Date().toISOString();
    let writes = false;
    try {
      if (!probePassed) { await probe(); probePassed = true; }
      writes = true;
      const batch = await rpc("arian_external_claim_discovered_risk_v1", { p_limit: 2 });
      if (!["claimed", "idle"].includes(batch?.status) || !Array.isArray(batch.claims) || batch.claims.length > 2) {
        throw new Error("Invalid discovered-risk claim response");
      }
      const results = [];
      for (const claim of batch.claims) {
        if (!Number.isSafeInteger(claim.run_id) || claim.run_id < 1) throw new Error("Invalid discovered-risk run ID");
        try {
          const payload = await collect(claim.mint);
          const body = { p_run_id: claim.run_id, p_payload: payload, p_error: null, p_checked_at: new Date().toISOString() };
          let db;
          try { db = await rpc(ingest, body, 45_000); }
          catch (e) {
            if (!/timeout|aborted|fetch failed/i.test(e.message)) throw e;
            db = await rpc(ingest, body, 45_000);
          }
          if (db?.status !== "success") throw new Error("Discovered-risk ingestion did not succeed");
          results.push({ run_id: claim.run_id, status: "success", database_result: db });
        } catch (e) {
          // Persist only bounded errors from our own HTTP/shape checks, never provider bodies or credentials.
          const reason = /^HTTP \d{3}$/.test(e.message) ? e.message : "External discovered-risk collection failed";
          let db = null;
          try { db = await rpc(ingest, { p_run_id: claim.run_id, p_payload: null, p_error: reason }); } catch {}
          // A lost successful response can be confirmed by this idempotent release call.
          results.push({ run_id: claim.run_id, status: db?.status === "success" ? "success" : "error",
            database_result: db, ...(db?.status === "success" ? {} : { error: reason }) });
        }
      }
      const succeeded = results.filter(x => x.status === "success").length;
      lastRun = { status: !results.length ? "idle" : succeeded === results.length ? "success" : succeeded ? "partial_error" : "error",
        mode: "external_ingest", provider: "rugcheck", started_at: startedAt, finished_at: new Date().toISOString(),
        checked_at: new Date().toISOString(), latency_ms: Date.now() - Date.parse(startedAt), writes_to_supabase: true,
        database_results: results };
    } catch {
      lastRun = { status: "error", mode: "external_ingest", provider: "rugcheck", started_at: startedAt,
        finished_at: new Date().toISOString(), writes_to_supabase: writes, error: "Discovered-risk scheduler failed" };
    } finally { running = false; }
    log(JSON.stringify({ event: "discovered_risk_run", ...lastRun }));
    return lastRun;
  }
  return { run, probe, status: () => ({ enabled, interval_ms: intervalMs, running, last_run: lastRun }) };
}
