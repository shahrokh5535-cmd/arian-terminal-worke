import { scheduleInterval } from "./schedule.js";

export function createXProfileTimelineCollector({ rpc, fetchJson, enabled, intervalMs = 600_000, log = console.log }) {
  intervalMs = scheduleInterval(intervalMs, 600_000, 600_000);
  let running = false, lastRun = null;
  const ingestRpc = "arian_external_ingest_x_profile_timeline";

  async function collect(handle) {
    if (typeof handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid X profile handle");
    const { response, payload } = await fetchJson(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses?count=5`, {
      headers: { Accept: "application/json", "User-Agent": "ArianTerminal/1.0" }
    }, 10_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (String(payload?.code) !== "200" || !Array.isArray(payload?.results)) throw new Error("Invalid X profile timeline payload");
    const own = payload.results.filter(p => String(p?.author?.screen_name || "").toLowerCase() === handle.toLowerCase());
    if (!own.length) throw new Error("No own-account posts returned by profile timeline");
    return payload;
  }

  async function run() {
    if (running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    running = true;
    const startedAt = new Date().toISOString();
    let claim = null;
    try {
      claim = await rpc("arian_external_claim_x_profile_timeline", {});
      if (claim?.status === "idle") {
        lastRun = { status: "idle", mode: "external_ingest", provider: "fxtwitter", dataset: "x_profile_timeline",
          started_at: startedAt, finished_at: new Date().toISOString(), writes_to_supabase: false, reason: claim.reason };
        return lastRun;
      }
      if (claim?.status !== "claimed" || !Number.isSafeInteger(claim.run_id) || !/^[A-Za-z0-9_]{1,15}$/.test(claim.profile_handle || "")) {
        throw new Error("Invalid external X profile timeline claim");
      }
      const payload = await collect(claim.profile_handle);
      const checkedAt = new Date().toISOString();
      const body = { p_run_id: claim.run_id, p_payload: payload, p_error: null, p_checked_at: checkedAt };
      let db;
      try { db = await rpc(ingestRpc, body, 45_000); }
      catch (e) {
        if (!/timeout|aborted|fetch failed/i.test(e.message)) throw e;
        db = await rpc(ingestRpc, body, 45_000);
      }
      if (db?.status !== "success") throw new Error("External X profile timeline ingestion did not succeed");
      lastRun = { status: "success", mode: "external_ingest", provider: "fxtwitter", dataset: "x_profile_timeline",
        started_at: startedAt, finished_at: new Date().toISOString(), checked_at: checkedAt,
        writes_to_supabase: true, profile_handle: claim.profile_handle, asset_instance_id: claim.asset_instance_id,
        database_result: db };
    } catch (e) {
      const reason = /^HTTP \d{3}$/.test(e.message) ? e.message :
        e.message === "No own-account posts returned by profile timeline" ? e.message : "External X profile timeline collection failed";
      let db = null;
      if (Number.isSafeInteger(claim?.run_id) && claim.run_id > 0) {
        try { db = await rpc(ingestRpc, { p_run_id: claim.run_id, p_payload: null, p_error: reason }); } catch {}
      }
      lastRun = { status: db?.status === "failed" ? "failed" : "error", mode: "external_ingest",
        provider: "fxtwitter", dataset: "x_profile_timeline", started_at: startedAt,
        finished_at: new Date().toISOString(), writes_to_supabase: Boolean(claim?.run_id),
        ...(db ? { database_result: db } : {}), ...(db?.status === "failed" ? {} : { error: reason }) };
    } finally {
      running = false;
      if (lastRun) log(JSON.stringify({ event: "x_profile_timeline_run", ...lastRun }));
    }
    return lastRun;
  }
  return { run, status: () => ({ enabled, interval_ms: intervalMs, running, last_run: lastRun }) };
}
