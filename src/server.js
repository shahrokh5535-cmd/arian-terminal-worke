import http from "node:http";

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const version = "0.4.0";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEXSCREENER_URL = `https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`;
const JUPITER_QUOTE_URL = `https://api.jup.ag/swap/v1/quote?inputMint=${WSOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ctikvqtvzoaqqgnxqbgu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ENABLE_DEXSCREENER_INGEST = String(process.env.ENABLE_DEXSCREENER_INGEST || "false").toLowerCase() === "true";
const ENABLE_JUPITER_INGEST = String(process.env.ENABLE_JUPITER_INGEST || "false").toLowerCase() === "true";

const DEXSCREENER_INTERVAL_MS = Math.max(60_000, Number(process.env.DEXSCREENER_INTERVAL_MS || 300_000));
const JUPITER_INTERVAL_MS = Math.max(60_000, Number(process.env.JUPITER_INTERVAL_MS || 300_000));

const state = {
  dexscreener: { running: false, lastRun: null, timer: null },
  jupiter: { running: false, lastRun: null, timer: null }
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function rpc(name, body) {
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
    signal: AbortSignal.timeout(15_000)
  });

  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Supabase RPC ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function fetchCanonicalDexScreenerPair() {
  const started = Date.now();
  const response = await fetch(DEXSCREENER_URL, {
    headers: { Accept: "application/json", "User-Agent": `arian-terminal-worker/${version}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("DexScreener payload is not an array");

  const canonical = payload
    .filter((pair) =>
      pair?.chainId === "solana" &&
      pair?.dexId === "raydium" &&
      pair?.baseToken?.address === WSOL_MINT &&
      pair?.quoteToken?.address === USDC_MINT
    )
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;

  if (!canonical) throw new Error("Canonical Raydium WSOL/USDC pair not found");
  return { fetchedPairs: payload.length, canonical, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function fetchJupiterQuote() {
  const started = Date.now();
  const response = await fetch(JUPITER_QUOTE_URL, {
    headers: { Accept: "application/json", "User-Agent": `arian-terminal-worker/${version}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Jupiter HTTP ${response.status}`);
  const quote = await response.json();

  if (quote?.inputMint !== WSOL_MINT || quote?.outputMint !== USDC_MINT) {
    throw new Error("Jupiter quote identity mismatch");
  }
  if (!quote?.inAmount || !quote?.outAmount) throw new Error("Jupiter quote is missing amounts");

  return { quote, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
}

async function runDexScreener({ write = false } = {}) {
  const s = state.dexscreener;
  if (s.running) return { status: "skipped", reason: "already_running", at: new Date().toISOString() };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchCanonicalDexScreenerPair();
    const pair = result.canonical;
    const db = write ? await rpc("arian_external_ingest_dexscreener_v1", { p_pair: pair, p_checked_at: result.checkedAt }) : null;
    s.lastRun = {
      status: "success", mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "dexscreener",
      fetched_pairs: result.fetchedPairs, canonical_pair_found: true,
      canonical_pair: {
        pair_address: pair.pairAddress || null,
        dex_id: pair.dexId || null,
        price_usd: pair.priceUsd || null,
        liquidity_usd: pair?.liquidity?.usd ?? null,
        volume_24h_usd: pair?.volume?.h24 ?? null
      },
      latency_ms: result.latencyMs, checked_at: result.checkedAt,
      writes_to_supabase: Boolean(write), database_result: db
    };
    console.log(JSON.stringify({ event: "dexscreener_run", ...s.lastRun }));
    return s.lastRun;
  } catch (error) {
    s.lastRun = {
      status: "error", mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt, finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write)
    };
    console.error(JSON.stringify({ event: "dexscreener_run", ...s.lastRun }));
    throw error;
  } finally { s.running = false; }
}

async function runJupiter({ write = false } = {}) {
  const s = state.jupiter;
  if (s.running) return { status: "skipped", reason: "already_running", at: new Date().toISOString() };
  s.running = true;
  const runStartedAt = new Date().toISOString();
  try {
    const result = await fetchJupiterQuote();
    const q = result.quote;
    const db = write ? await rpc("arian_external_ingest_jupiter_v1", { p_quote: q, p_checked_at: result.checkedAt }) : null;
    s.lastRun = {
      status: "success", mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt, finished_at: new Date().toISOString(), provider: "jupiter",
      input_mint: q.inputMint, output_mint: q.outputMint,
      in_amount: q.inAmount, out_amount: q.outAmount,
      other_amount_threshold: q.otherAmountThreshold ?? null,
      slippage_bps: q.slippageBps ?? null,
      price_impact_pct: q.priceImpactPct ?? null,
      route_legs: Array.isArray(q.routePlan) ? q.routePlan.length : 0,
      latency_ms: result.latencyMs, checked_at: result.checkedAt,
      writes_to_supabase: Boolean(write), database_result: db
    };
    console.log(JSON.stringify({ event: "jupiter_run", ...s.lastRun }));
    return s.lastRun;
  } catch (error) {
    s.lastRun = {
      status: "error", mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt, finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown_error", writes_to_supabase: Boolean(write)
    };
    console.error(JSON.stringify({ event: "jupiter_run", ...s.lastRun }));
    throw error;
  } finally { s.running = false; }
}

function schedulerStatus() {
  return {
    service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    dexscreener: {
      enabled: ENABLE_DEXSCREENER_INGEST,
      interval_ms: DEXSCREENER_INTERVAL_MS,
      running: state.dexscreener.running,
      last_run: state.dexscreener.lastRun
    },
    jupiter: {
      enabled: ENABLE_JUPITER_INGEST,
      interval_ms: JUPITER_INTERVAL_MS,
      running: state.jupiter.running,
      last_run: state.jupiter.lastRun
    }
  };
}

function startSchedulers() {
  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_DEXSCREENER_INGEST) {
    const tick = () => runDexScreener({ write: true }).catch(() => {});
    setTimeout(tick, 5_000);
    state.dexscreener.timer = setInterval(tick, DEXSCREENER_INTERVAL_MS);
    state.dexscreener.timer.unref?.();
  }

  if (SUPABASE_SERVICE_ROLE_KEY && ENABLE_JUPITER_INGEST) {
    const tick = () => runJupiter({ write: true }).catch(() => {});
    setTimeout(tick, 20_000);
    state.jupiter.timer = setInterval(tick, JUPITER_INTERVAL_MS);
    state.jupiter.timer.unref?.();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, {
        service: "arian-terminal-worker", status: "ok", version,
        started_at: startedAt, now: new Date().toISOString(),
        scheduler: {
          dexscreener_enabled: ENABLE_DEXSCREENER_INGEST,
          jupiter_enabled: ENABLE_JUPITER_INGEST,
          service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, { service: "arian-terminal-worker", status: "ok", version, scheduler: schedulerStatus(), now: new Date().toISOString() });
    }

    if (req.method === "GET" && url.pathname === "/probe/dexscreener") {
      const result = await runDexScreener({ write: false });
      return sendJson(res, 200, { service: "arian-terminal-worker", version, ...result });
    }

    if (req.method === "GET" && url.pathname === "/probe/jupiter") {
      const result = await runJupiter({ write: false });
      return sendJson(res, 200, { service: "arian-terminal-worker", version, ...result });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 502, {
      service: "arian-terminal-worker", status: "error", version,
      error: error instanceof Error ? error.message : "unknown_error", now: new Date().toISOString()
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ARIAN TERMINAL worker ${version} listening on :${port}`);
  startSchedulers();
});
