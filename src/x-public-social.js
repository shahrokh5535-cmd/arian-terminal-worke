import { scheduleInterval } from "./schedule.js";

// Discovery-linked public posts only. All normalization and social scoring remain DB-local.
export function createXPublicSocialCollector({ rpc, fetchJson, enabled, intervalMs = 600_000, batchSize = 5, log = console.log }) {
  intervalMs = scheduleInterval(intervalMs, 600_000, 600_000);
  const maxBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, 5));
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

  async function ingestClaim(claim) {
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
    return { status: "success", run_id: claim.run_id, tweet_id: claim.tweet_id,
      author_handle: payload.tweet.author?.screen_name ?? null, checked_at: body.p_checked_at, database_result: db };
  }

  async function releaseClaim(claim, error) {
    const reason = /^HTTP \d{3}$/.test(error.message) ? error.message : "External X post collection failed";
    let db = null;
    if (Number.isSafeInteger(claim?.run_id) && claim.run_id > 0) {
      try { db = await rpc(ingestRpc, { p_run_id: claim.run_id, p_payload: null, p_error: reason }); } catch {}
    }
    if (db?.status === "success") {
      return { status: "success", run_id: claim.run_id, tweet_id: claim.tweet_id, recovered_terminal: true, database_result: db };
    }
    return { status: "error", run_id: claim?.run_id ?? null, tweet_id: claim?.tweet_id ?? null, error: reason,
      ...(db ? { database_result: db } : {}) };
  }

  async function run() {
    if (running) return { status: "skipped", reason: "already_running", writes_to_supabase: false };
    running = true;
    const startedAt = new Date().toISOString();
    let claim = null, writes = false;
    const items = [];
    try {
      if (!probePassed) {
        const shadow = await probe();
        if (shadow.status !== "success") {
          lastRun = { ...shadow, mode: "external_ingest", started_at: startedAt, finished_at: new Date().toISOString(),
            batch_size: maxBatchSize, targets_processed: 0 };
          return lastRun;
        }
        probePassed = true;
      }

      writes = true;
      for (let i = 0; i < maxBatchSize; i++) {
        claim = await rpc("arian_external_claim_x_public_social_v1", {});
        if (claim?.status === "idle") break;
        if (claim?.status !== "claimed" || !Number.isSafeInteger(claim.run_id) || claim.run_id < 1) {
          throw new Error("Invalid external X claim response");
        }
        try { items.push(await ingestClaim(claim)); }
        catch (e) { items.push(await releaseClaim(claim, e)); }
        claim = null;
      }

      if (items.length === 0) {
        lastRun = { status: "idle", mode: "external_ingest", provider: "fxtwitter", upstream_platform: "x",
          started_at: startedAt, finished_at: new Date().toISOString(), writes_to_supabase: true,
          batch_size: maxBatchSize, targets_processed: 0, reason: "no_eligible_post" };
        return lastRun;
      }

      const succeeded = items.filter(x => x.status === "success").length;
      const failed = items.length - succeeded;
      lastRun = { status: succeeded > 0 ? "success" : "error", mode: "external_ingest", provider: "fxtwitter",
        upstream_platform: "x", started_at: startedAt, finished_at: new Date().toISOString(),
        latency_ms: Date.now() - Date.parse(startedAt), writes_to_supabase: true,
        batch_size: maxBatchSize, targets_processed: items.length, succeeded, failed, items,
        ...(succeeded === 0 ? { error: "X social batch failed" } : {}) };
    } catch (e) {
      if (claim?.run_id) items.push(await releaseClaim(claim, e));
      lastRun = { status: "error", mode: "external_ingest", provider: "fxtwitter", upstream_platform: "x",
        started_at: startedAt, finished_at: new Date().toISOString(), writes_to_supabase: writes,
        batch_size: maxBatchSize, targets_processed: items.length, items,
        error: e instanceof Error ? e.message : "External X post collection failed" };
    } finally {
      running = false;
      if (lastRun) log(JSON.stringify({ event: "x_public_social_run", ...lastRun }));
    }
    return lastRun;
  }

  return { run, probe, status: () => ({ enabled, interval_ms: intervalMs, batch_size: maxBatchSize, running, last_run: lastRun }) };
}
