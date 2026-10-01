import { scheduleInterval } from "./schedule.js";

// Discovery-linked public posts only. All normalization and social scoring remain DB-local.
export function createXPublicSocialCollector({ rpc, fetchJson, enabled, intervalMs = 600_000, log = console.log }) {
  intervalMs = scheduleInterval(intervalMs, 600_000, 600_000);
  let running = false, lastRun = null, probePassed = false;
  const ingestRpc = "arian_external_ingest_x_public_social_v1";
  async function collect(tweetId) {
    if (typeof tweetId !== "string" || !/^[0-9]{1,25}$/.test(tweetId)) throw new Error("Invalid X post ID");
    const { response, payload } = await fetchJson(`https://api.fxtwitter.com/status/${tweetId}`, {
      headers: { Accept: "application/json", "User-Agent": "ArianTerminal/1.0" }
    }, 10_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tweet = payload?.tweet;
    if (String(payload?.code) !== "200" || !tweet || Array.isArray(tweet) || typeof tweet !== "object" ||
        tweet.id !== tweetId || typeof tweet.text !== "string" || !tweet.text.trim()) {
      throw new Error("Invalid X post payload or identity");
    }
    return payload;
  }
  async function probe() {
    const started = Date.now();
    const sample = await rpc("arian_external_peek_x_public_social_v1", {});
    if (sample?.status === "idle") return { status: "idle", mode: "shadow_probe", writes_to_supabase: false };
    if (sample?.status !== "ready") throw new Error("Invalid X probe target");
    const payload = await collect(sample.tweet_id);
    return { status: "success", mode: "shadow_probe", provider: "fxtwitter", upstream_platform: "x",
      writes_to_supabase: false, tweet_id: payload.tweet.id, author_handle: payload.tweet.author?.screen_name ?? null,
      text_present: true, checked_at: new Date().toISOString(), latency_ms: Date.now() - started };
  }
  async function run() {
    if (running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    running = true;
    const startedAt = new Date().toISOString();
    let claim = null, writes = false;
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
      claim = await rpc("arian_external_claim_x_public_social_v1", {});
      if (claim?.status === "idle") {
        lastRun = { status: "idle", mode: "external_ingest", provider: "fxtwitter", started_at: startedAt,
          finished_at: new Date().toISOString(), writes_to_supabase: true, reason: claim.reason ?? "no_eligible_post" };
        return lastRun;
      }
      if (claim?.status !== "claimed" || !Number.isSafeInteger(claim.run_id) || claim.run_id < 1) {
        throw new Error("Invalid external X claim response");
      }
      const payload = await collect(claim.tweet_id);
      const body = { p_run_id: claim.run_id, p_payload: payload, p_error: null, p_checked_at: new Date().toISOString() };
      let db;
      try { db = await rpc(ingestRpc, body, 45_000); }
      catch (e) {
        if (!/timeout|aborted|fetch failed/i.test(e.message)) throw e;
        // A run ID is the idempotency key; retry only a lost delivery, never refetch the provider here.
        db = await rpc(ingestRpc, body, 45_000);
      }
      if (db?.status !== "success") throw new Error("External X ingestion did not succeed");
      lastRun = { status: "success", mode: "external_ingest", provider: "fxtwitter", upstream_platform: "x",
        started_at: startedAt, finished_at: new Date().toISOString(), checked_at: body.p_checked_at,
        latency_ms: Date.now() - Date.parse(startedAt), writes_to_supabase: true,
        tweet_id: claim.tweet_id, author_handle: payload.tweet.author?.screen_name ?? null, database_result: db };
    } catch (e) {
      const reason = /^HTTP \d{3}$/.test(e.message) ? e.message : "External X post collection failed";
      let db = null;
      if (Number.isSafeInteger(claim?.run_id) && claim.run_id > 0) {
        try { db = await rpc(ingestRpc, { p_run_id: claim.run_id, p_payload: null, p_error: reason }); } catch {}
      }
      lastRun = { status: db?.status === "success" ? "success" : "error", mode: "external_ingest", provider: "fxtwitter",
        started_at: startedAt, finished_at: new Date().toISOString(), writes_to_supabase: writes,
        ...(db ? { database_result: db } : {}), ...(db?.status === "success" ? {} : { error: reason }) };
    } finally {
      running = false;
      if (lastRun) log(JSON.stringify({ event: "x_public_social_run", ...lastRun }));
    }
    return lastRun;
  }
  return { run, probe, status: () => ({ enabled, interval_ms: intervalMs, running, last_run: lastRun }) };
}
