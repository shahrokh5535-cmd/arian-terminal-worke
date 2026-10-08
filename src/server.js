import http from "node:http";
import { createXPublicSocialCollector } from "./x-public-social.js";
import { createXProfileTimelineCollector } from "./x-profile-timeline.js";
import { createDiscoveredRiskCollector } from "./discovered-risk.js";
import { createPromotedCollector } from "./promoted.js";
import { scheduleInterval } from "./schedule.js";
import { createSolanaDetails } from "./solana-details.js";
import { runTokenDiscovery, tokenDiscoveryStatus, startTokenDiscoveryScheduler } from "./discovery.js";

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const version = "0.11.0";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEXSCREENER_URL = `https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`;
const JUPITER_QUOTE_URL = `https://api.jup.ag/swap/v1/quote?inputMint=${WSOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const RAYDIUM_SOL_USDC_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const RUGCHECK_ASSET_INSTANCE_ID = Number(process.env.RUGCHECK_ASSET_INSTANCE_ID || 32);
const RUGCHECK_MINT = process.env.RUGCHECK_MINT || WSOL_MINT;

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ctikvqtvzoaqqgnxqbgu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ENABLE_DEXSCREENER_INGEST = String(process.env.ENABLE_DEXSCREENER_INGEST || "false").toLowerCase() === "true";
const ENABLE_JUPITER_INGEST = String(process.env.ENABLE_JUPITER_INGEST || "false").toLowerCase() === "true";
const ENABLE_SOLANA_RPC_INGEST = String(process.env.ENABLE_SOLANA_RPC_INGEST || "false").toLowerCase() === "true";
const ENABLE_RUGCHECK_INGEST = String(process.env.ENABLE_RUGCHECK_INGEST || "true").toLowerCase() === "true";
const ENABLE_JUPITER_TOKEN_ENRICHMENT = String(process.env.ENABLE_JUPITER_TOKEN_ENRICHMENT || "true").toLowerCase() === "true";

const DEXSCREENER_INTERVAL_MS = scheduleInterval(process.env.DEXSCREENER_INTERVAL_MS, 300000, 300000);
const JUPITER_INTERVAL_MS = scheduleInterval(process.env.JUPITER_INTERVAL_MS, 300000, 300000);
const SOLANA_RPC_INTERVAL_MS = scheduleInterval(process.env.SOLANA_RPC_INTERVAL_MS, 300000, 300000);
const RUGCHECK_INTERVAL_MS = scheduleInterval(process.env.RUGCHECK_INTERVAL_MS, 3600000, 3600000);
const JUPITER_TOKEN_ENRICHMENT_INTERVAL_MS = scheduleInterval(process.env.JUPITER_TOKEN_ENRICHMENT_INTERVAL_MS, 300000, 300000);

const state = {
  dexscreener: { running: false, lastRun: null, timer: null },
  jupiter: { running: false, lastRun: null, timer: null },
  solana_rpc: { running: false, lastRun: null, timer: null },
  rugcheck: { running: false, lastRun: null, timer: null },
  jupiter_token_enrichment: { running: false, lastRun: null, timer: null }
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function rpc(name, body = {}, timeoutMs = 15_000) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "User-Agent": `arian-terminal-worker/${version}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Supabase RPC ${name} HTTP ${response.status}`);
  return parsed;
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", "User-Agent": `arian-terminal-worker/${version}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 1000) }; }
  return { response, payload };
}

async function fetchCanonicalDexScreenerPair() {
  const started = Date.now();
  const { response, payload } = await fetchJson(DEXSCREENER_URL);
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  if (!Array.isArray(payload)) throw new Error("DexScreener payload is not an array");
  const canonical = payload
    .filter((pair) => pair?.chainId === "solana" && pair?.dexId === "raydium" && pair?.baseToken?.address === WSOL_MINT && pair?.quoteToken?.address === USDC_MINT)
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
  if (!canonical) throw new Error("Canonical Raydium WSOL/USDC pair not found");
  return { fetchedPairs: payload.length, canonical, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function fetchJupiterQuote() {
  const started = Date.now();
  const { response, payload: quote } = await fetchJson(JUPITER_QUOTE_URL);
  if (!response.ok) throw new Error(`Jupiter HTTP ${response.status}`);
  if (quote?.inputMint !== WSOL_MINT || quote?.outputMint !== USDC_MINT) throw new Error("Jupiter quote identity mismatch");
  if (!quote?.inAmount || !quote?.outAmount) throw new Error("Jupiter quote is missing amounts");
  return { quote, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function fetchRugCheckSummary() {
  const started = Date.now();
  const { response, payload } = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(RUGCHECK_MINT)}/report/summary`, {}, 12_000);
  if (!response.ok) throw new Error(`RugCheck HTTP ${response.status}`);
  const score = Number(payload?.score_normalised);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("RugCheck payload has invalid score_normalised");
  return { payload, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function fetchSolanaPoolSignatures() {
  const started = Date.now();
  const { response, payload } = await fetchJson(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [RAYDIUM_SOL_USDC_POOL, { limit: 3, commitment: "finalized" }] })
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  if (payload?.error) throw new Error(`Solana RPC error: ${JSON.stringify(payload.error)}`);
  if (!Array.isArray(payload?.result)) throw new Error("Solana RPC result is not an array");
  return { result: payload.result, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function runDexScreener({ write = false } = {}) {
  const s = state.dexscreener;
  if (s.running) return { status: "skipped", reason: "already_running" };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchCanonicalDexScreenerPair();
    const pair = result.canonical;
    const db = write ? await rpc("arian_external_ingest_dexscreener_v1", { p_pair: pair, p_checked_at: result.checkedAt }) : null;
    s.lastRun = { status: "success", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "dexscreener", fetched_pairs: result.fetchedPairs, canonical_pair_found: true, canonical_pair: { pair_address: pair.pairAddress || null, dex_id: pair.dexId || null, price_usd: pair.priceUsd || null, liquidity_usd: pair?.liquidity?.usd ?? null, volume_24h_usd: pair?.volume?.h24 ?? null }, latency_ms: result.latencyMs, checked_at: result.checkedAt, writes_to_supabase: Boolean(write), database_result: db };
    console.log(JSON.stringify({ event: "dexscreener_run", ...s.lastRun }));
    return s.lastRun;
  } catch (error) {
    s.lastRun = { status: "error", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write) };
    console.error(JSON.stringify({ event: "dexscreener_run", ...s.lastRun })); throw error;
  } finally { s.running = false; }
}

async function runJupiter({ write = false } = {}) {
  const s = state.jupiter;
  if (s.running) return { status: "skipped", reason: "already_running" };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchJupiterQuote(); const q = result.quote;
    const db = write ? await rpc("arian_external_ingest_jupiter_v1", { p_quote: q, p_checked_at: result.checkedAt }) : null;
    s.lastRun = { status: "success", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "jupiter", input_mint: q.inputMint, output_mint: q.outputMint, in_amount: q.inAmount, out_amount: q.outAmount, other_amount_threshold: q.otherAmountThreshold ?? null, slippage_bps: q.slippageBps ?? null, price_impact_pct: q.priceImpactPct ?? null, route_legs: Array.isArray(q.routePlan) ? q.routePlan.length : 0, latency_ms: result.latencyMs, checked_at: result.checkedAt, writes_to_supabase: Boolean(write), database_result: db };
    console.log(JSON.stringify({ event: "jupiter_run", ...s.lastRun })); return s.lastRun;
  } catch (error) {
    s.lastRun = { status: "error", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write) };
    console.error(JSON.stringify({ event: "jupiter_run", ...s.lastRun })); throw error;
  } finally { s.running = false; }
}

async function runSolanaRpc({ write = false } = {}) {
  const s = state.solana_rpc;
  if (s.running) return { status: "skipped", reason: "already_running" };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchSolanaPoolSignatures();
    const db = write ? await rpc("arian_external_ingest_solana_signatures_v1", { p_result: result.result, p_checked_at: result.checkedAt }) : null;
    s.lastRun = { status: "success", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "solana_rpc", monitored_address: RAYDIUM_SOL_USDC_POOL, signatures_fetched: result.result.length, latency_ms: result.latencyMs, checked_at: result.checkedAt, writes_to_supabase: Boolean(write), database_result: db };
    console.log(JSON.stringify({ event: "solana_rpc_run", ...s.lastRun })); return s.lastRun;
  } catch (error) {
    s.lastRun = { status: "error", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write) };
    console.error(JSON.stringify({ event: "solana_rpc_run", ...s.lastRun })); throw error;
  } finally { s.running = false; }
}

async function runRugCheck({ write = false } = {}) {
  const s = state.rugcheck;
  if (s.running) return { status: "skipped", reason: "already_running" };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchRugCheckSummary();
    const db = write ? await rpc("arian_external_ingest_rugcheck_v1", { p_asset_instance_id: RUGCHECK_ASSET_INSTANCE_ID, p_payload: result.payload, p_checked_at: result.checkedAt }) : null;
    s.lastRun = { status: "success", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "rugcheck", asset_instance_id: RUGCHECK_ASSET_INSTANCE_ID, mint: RUGCHECK_MINT, risk_score: result.payload.score_normalised, latency_ms: result.latencyMs, checked_at: result.checkedAt, writes_to_supabase: Boolean(write), database_result: db };
    console.log(JSON.stringify({ event: "rugcheck_run", ...s.lastRun })); return s.lastRun;
  } catch (error) {
    s.lastRun = { status: "error", mode: write ? "external_ingest" : "shadow_probe", started_at: runStartedAt, finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write) };
    console.error(JSON.stringify({ event: "rugcheck_run", ...s.lastRun })); throw error;
  } finally { s.running = false; }
}

async function probeJupiterTokenEnrichment(mint = WSOL_MINT) {
  const started = Date.now();
  const tokens = await fetchJson(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  if (!tokens.response.ok || !Array.isArray(tokens.payload)) throw new Error(`Jupiter token search HTTP ${tokens.response.status}`);
  const token = tokens.payload.find(x => x?.id === mint);
  if (!token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 18) throw new Error("Invalid Jupiter token response");
  const quote = await fetchJupiterQuote();
  return { status: "success", mode: "shadow_probe", provider: "jupiter", writes_to_supabase: false, mint, decimals: token.decimals,
    route_available: Boolean(quote.quote.routePlan?.length), latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
}

async function runJupiterTokenEnrichment() {
  const s = state.jupiter_token_enrichment;
  if (s.running) return { status: "skipped", reason: "already_running" };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  let claim;
  try {
    claim = await rpc("arian_external_claim_jupiter_token_enrichment_v1", {});
    if (!claim || claim.status === "idle") {
      s.lastRun = { status: "idle", mode: "external_ingest", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "jupiter", dataset: "tokens_v2_search", writes_to_supabase: false };
      return s.lastRun;
    }
    if (claim.status !== "claimed" || !claim.run_id || !claim.mint) throw new Error(`Unexpected claim response: ${JSON.stringify(claim)}`);

    const tokenUrl = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(claim.mint)}`;
    const tokenFetch = await fetchJson(tokenUrl);
    if (!tokenFetch.response.ok || !Array.isArray(tokenFetch.payload)) throw new Error(`Jupiter token search HTTP ${tokenFetch.response.status}`);
    const token = tokenFetch.payload.find((x) => x?.id === claim.mint);
    if (!token) throw new Error("Jupiter token not found in search response");
    const decimals = Number(token.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid Jupiter token decimals");

    const amount = (10n ** BigInt(decimals)).toString();
    const routeUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(claim.mint)}&outputMint=${WSOL_MINT}&amount=${amount}&slippageBps=100`;
    const routeFetch = await fetchJson(routeUrl);
    const noRoute = ["COULD_NOT_FIND_ANY_ROUTE", "TOKEN_NOT_TRADABLE", "NO_ROUTES_FOUND"].includes(routeFetch.payload?.errorCode);
    if (!routeFetch.response.ok && !noRoute) throw new Error(`Jupiter route HTTP ${routeFetch.response.status}`);
    const routeAvailable = routeFetch.response.ok && Array.isArray(routeFetch.payload?.routePlan) && routeFetch.payload.routePlan.length > 0 && routeFetch.payload.inputMint === claim.mint;
    if (routeFetch.response.ok && !routeAvailable) throw new Error("Invalid Jupiter route payload");
    const checkedAt = new Date().toISOString();
    const db = await rpc("arian_external_ingest_jupiter_token_enrichment_v1", {
      p_run_id: claim.run_id,
      p_token_payload: tokenFetch.payload,
      p_route_payload: routeFetch.payload || {},
      p_route_available: Boolean(routeAvailable),
      p_checked_at: checkedAt
    });
    if (db?.status !== "success") throw new Error("Jupiter enrichment ingestion did not succeed");
    s.lastRun = { status: "success", mode: "external_ingest", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "jupiter", dataset: "tokens_v2_search", run_id: claim.run_id, asset_instance_id: claim.asset_instance_id, mint: claim.mint, route_available: Boolean(routeAvailable), checked_at: checkedAt, writes_to_supabase: true, database_result: db };
    console.log(JSON.stringify({ event: "jupiter_token_enrichment_run", ...s.lastRun }));
    return s.lastRun;
  } catch (error) {
    if (claim?.run_id) await rpc("arian_external_fail_jupiter_token_enrichment_v1", { p_run_id: claim.run_id, p_error: "External Jupiter collection failed" }).catch(() => {});
    s.lastRun = { status: "error", mode: "external_ingest", started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "jupiter", dataset: "tokens_v2_search", error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: true };
    console.error(JSON.stringify({ event: "jupiter_token_enrichment_run", ...s.lastRun }));
    throw error;
  } finally { s.running = false; }
}

const solanaDetails = createSolanaDetails({ rpc, fetchJson, fetchSignatures: fetchSolanaPoolSignatures,
  enabled: ENABLE_SOLANA_RPC_INGEST && String(process.env.ENABLE_SOLANA_DETAILS_INGEST || "true").toLowerCase() === "true" });

const promotedMarket = createPromotedCollector({ kind: "market", rpc, fetchJson,
  enabled: String(process.env.ENABLE_PROMOTED_MARKET_INGEST || "true").toLowerCase() === "true",
  intervalMs: scheduleInterval(process.env.PROMOTED_MARKET_INTERVAL_MS, 300_000, 300_000),
  // Optional rollout/rollback control: set 10 for canary, 20 after verification.
  batchSize: process.env.PROMOTED_MARKET_BATCH_SIZE === undefined
    ? undefined : Number(process.env.PROMOTED_MARKET_BATCH_SIZE) });
const promotedSignatures = createPromotedCollector({ kind: "signatures", rpc, fetchJson,
  enabled: String(process.env.ENABLE_PROMOTED_SIGNATURES_INGEST || "true").toLowerCase() === "true",
  intervalMs: scheduleInterval(process.env.PROMOTED_SIGNATURES_INTERVAL_MS, 300_000, 300_000) });

const discoveredRisk = createDiscoveredRiskCollector({ rpc, fetchJson,
  enabled: String(process.env.ENABLE_DISCOVERED_RISK_INGEST || "true").toLowerCase() === "true",
  intervalMs: process.env.DISCOVERED_RISK_INTERVAL_MS });

const xPublicSocial = createXPublicSocialCollector({ rpc, fetchJson,
  enabled: String(process.env.ENABLE_X_PUBLIC_SOCIAL_INGEST || "true").toLowerCase() === "true",
  intervalMs: process.env.X_PUBLIC_SOCIAL_INTERVAL_MS });

const xProfileTimeline = createXProfileTimelineCollector({ rpc, fetchJson,
  enabled: String(process.env.ENABLE_X_PROFILE_TIMELINE_INGEST || "true").toLowerCase() === "true",
  intervalMs: process.env.X_PROFILE_TIMELINE_INTERVAL_MS });

function schedulerStatus() {
  return {
    service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    x_public_social: xPublicSocial.status(),
    x_profile_timeline: xProfileTimeline.status(),
    discovered_risk: discoveredRisk.status(),
    token_discovery: tokenDiscoveryStatus(),
    promoted_market: promotedMarket.status(),
    promoted_signatures: promotedSignatures.status(),
    solana_details: solanaDetails.status(),
    dexscreener: { enabled: ENABLE_DEXSCREENER_INGEST, interval_ms: DEXSCREENER_INTERVAL_MS, running: state.dexscreener.running, last_run: state.dexscreener.lastRun },
    jupiter: { enabled: ENABLE_JUPITER_INGEST, interval_ms: JUPITER_INTERVAL_MS, running: state.jupiter.running, last_run: state.jupiter.lastRun },
    solana_rpc: { enabled: ENABLE_SOLANA_RPC_INGEST, interval_ms: SOLANA_RPC_INTERVAL_MS, running: state.solana_rpc.running, last_run: state.solana_rpc.lastRun },
    rugcheck: { enabled: ENABLE_RUGCHECK_INGEST, interval_ms: RUGCHECK_INTERVAL_MS, running: state.rugcheck.running, last_run: state.rugcheck.lastRun },
    jupiter_token_enrichment: { enabled: ENABLE_JUPITER_TOKEN_ENRICHMENT, interval_ms: JUPITER_TOKEN_ENRICHMENT_INTERVAL_MS, running: state.jupiter_token_enrichment.running, last_run: state.jupiter_token_enrichment.lastRun }
  };
}

function startSchedulers() {
  for (const [collector, delay] of [[promotedMarket, 110_000], [promotedSignatures, 125_000], [discoveredRisk, 140_000], [xPublicSocial, 155_000], [xProfileTimeline, 170_000]]) {
    if (SUPABASE_SERVICE_ROLE_KEY && collector.status().enabled) {
      const tick = () => collector.run().catch(() => {});
      setTimeout(tick, delay);
      setInterval(tick, collector.status().interval_ms).unref?.();
    }
  }
  startTokenDiscoveryScheduler();
  if (SUPABASE_SERVICE_ROLE_KEY && solanaDetails.status().enabled) {
    const tick = () => solanaDetails.run().catch(() => {});
    setTimeout(tick, 95_000);
    setInterval(tick, solanaDetails.status().interval_ms).unref?.();
  }
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_DEXSCREENER_INGEST) {
    const tick = () => runDexScreener({ write: true }).catch(() => {}); setTimeout(tick, 5_000); state.dexscreener.timer = setInterval(tick, DEXSCREENER_INTERVAL_MS); state.dexscreener.timer.unref?.();
  }
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_JUPITER_INGEST) {
    const tick = () => runJupiter({ write: true }).catch(() => {}); setTimeout(tick, 20_000); state.jupiter.timer = setInterval(tick, JUPITER_INTERVAL_MS); state.jupiter.timer.unref?.();
  }
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_SOLANA_RPC_INGEST) {
    const tick = () => runSolanaRpc({ write: true }).catch(() => {}); setTimeout(tick, 35_000); state.solana_rpc.timer = setInterval(tick, SOLANA_RPC_INTERVAL_MS); state.solana_rpc.timer.unref?.();
  }
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_RUGCHECK_INGEST) {
    const tick = () => runRugCheck({ write: true }).catch(() => {}); setTimeout(tick, 50_000); state.rugcheck.timer = setInterval(tick, RUGCHECK_INTERVAL_MS); state.rugcheck.timer.unref?.();
  }
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_JUPITER_TOKEN_ENRICHMENT) {
    const tick = () => runJupiterTokenEnrichment().catch(() => {}); setTimeout(tick, 65_000); state.jupiter_token_enrichment.timer = setInterval(tick, JUPITER_TOKEN_ENRICHMENT_INTERVAL_MS); state.jupiter_token_enrichment.timer.unref?.();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, { service: "arian-terminal-worker", status: "ok", version, started_at: startedAt, now: new Date().toISOString(), scheduler: { x_public_social_enabled: xPublicSocial.status().enabled, x_profile_timeline_enabled: xProfileTimeline.status().enabled, discovered_risk_enabled: discoveredRisk.status().enabled, dexscreener_enabled: ENABLE_DEXSCREENER_INGEST, jupiter_enabled: ENABLE_JUPITER_INGEST, solana_rpc_enabled: ENABLE_SOLANA_RPC_INGEST, rugcheck_enabled: ENABLE_RUGCHECK_INGEST, token_discovery_enabled: tokenDiscoveryStatus().enabled, solana_details_enabled: solanaDetails.status().enabled, promoted_market_enabled: promotedMarket.status().enabled, promoted_signatures_enabled: promotedSignatures.status().enabled, jupiter_token_enrichment_enabled: ENABLE_JUPITER_TOKEN_ENRICHMENT, service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY) } });
    }
    if (req.method === "GET" && url.pathname === "/status") return sendJson(res, 200, { service: "arian-terminal-worker", status: "ok", version, scheduler: schedulerStatus(), now: new Date().toISOString() });
    if (req.method === "GET" && url.pathname === "/probe/x-social") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await xPublicSocial.probe()) });
    if (req.method === "GET" && url.pathname === "/probe/discovered-risk") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await discoveredRisk.probe()) });
    if (req.method === "GET" && url.pathname === "/probe/promoted-market") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await promotedMarket.probe()) });
    if (req.method === "GET" && url.pathname === "/probe/promoted-signatures") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await promotedSignatures.probe()) });
    if (req.method === "GET" && url.pathname === "/probe/jupiter-token-enrichment") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await probeJupiterTokenEnrichment()) });
    if (req.method === "GET" && url.pathname === "/probe/token-discovery") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await runTokenDiscovery({ write: false })) });
    if (req.method === "GET" && url.pathname === "/probe/solana-details") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await solanaDetails.probe()) });
    if (req.method === "GET" && url.pathname === "/probe/dexscreener") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await runDexScreener({ write: false })) });
    if (req.method === "GET" && url.pathname === "/probe/jupiter") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await runJupiter({ write: false })) });
    if (req.method === "GET" && url.pathname === "/probe/solana-rpc") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await runSolanaRpc({ write: false })) });
    if (req.method === "GET" && url.pathname === "/probe/rugcheck") return sendJson(res, 200, { service: "arian-terminal-worker", version, ...(await runRugCheck({ write: false })) });
    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 502, { service: "arian-terminal-worker", status: "error", version, error: error instanceof Error ? error.message : "unknown_error", now: new Date().toISOString() });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ARIAN TERMINAL worker ${version} listening on :${port}`);
  startSchedulers();
});
