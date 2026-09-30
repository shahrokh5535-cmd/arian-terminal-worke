import http from "node:http";

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const version = "0.3.0";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEXSCREENER_URL = `https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ctikvqtvzoaqqgnxqbgu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ENABLE_DEXSCREENER_INGEST = String(process.env.ENABLE_DEXSCREENER_INGEST || "false").toLowerCase() === "true";
const DEXSCREENER_INTERVAL_MS = Math.max(60_000, Number(process.env.DEXSCREENER_INTERVAL_MS || 300_000));

let lastRun = null;
let running = false;
let timer = null;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function fetchCanonicalDexScreenerPair() {
  const started = Date.now();
  const response = await fetch(DEXSCREENER_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": `arian-terminal-worker/${version}`
    },
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

  return {
    fetchedPairs: payload.length,
    canonical,
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString()
  };
}

function summarizePair(result) {
  const pair = result.canonical;
  return {
    provider: "dexscreener",
    fetched_pairs: result.fetchedPairs,
    canonical_pair_found: true,
    canonical_pair: {
      pair_address: pair.pairAddress || null,
      dex_id: pair.dexId || null,
      price_usd: pair.priceUsd || null,
      liquidity_usd: pair?.liquidity?.usd ?? null,
      volume_24h_usd: pair?.volume?.h24 ?? null
    },
    latency_ms: result.latencyMs,
    checked_at: result.checkedAt
  };
}

async function writeCanonicalPairToSupabase(result) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");

  const endpoint = `${SUPABASE_URL}/rest/v1/rpc/arian_external_ingest_dexscreener_v1`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "User-Agent": `arian-terminal-worker/${version}`
    },
    body: JSON.stringify({
      p_pair: result.canonical,
      p_checked_at: result.checkedAt
    }),
    signal: AbortSignal.timeout(15_000)
  });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }

  if (!response.ok) {
    throw new Error(`Supabase RPC ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function runDexScreener({ write = false } = {}) {
  if (running) return { status: "skipped", reason: "already_running", at: new Date().toISOString() };
  running = true;
  const runStartedAt = new Date().toISOString();

  try {
    const result = await fetchCanonicalDexScreenerPair();
    const summary = summarizePair(result);
    const db = write ? await writeCanonicalPairToSupabase(result) : null;

    lastRun = {
      status: "success",
      mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt,
      finished_at: new Date().toISOString(),
      ...summary,
      writes_to_supabase: Boolean(write),
      database_result: db
    };
    console.log(JSON.stringify({ event: "dexscreener_run", ...lastRun }));
    return lastRun;
  } catch (error) {
    lastRun = {
      status: "error",
      mode: write ? "external_ingest" : "shadow_probe",
      started_at: runStartedAt,
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown_error",
      writes_to_supabase: Boolean(write)
    };
    console.error(JSON.stringify({ event: "dexscreener_run", ...lastRun }));
    throw error;
  } finally {
    running = false;
  }
}

function schedulerStatus() {
  return {
    enabled: ENABLE_DEXSCREENER_INGEST,
    service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    interval_ms: DEXSCREENER_INTERVAL_MS,
    running,
    last_run: lastRun
  };
}

function startScheduler() {
  if (!ENABLE_DEXSCREENER_INGEST || !SUPABASE_SERVICE_ROLE_KEY) return;
  if (timer) clearInterval(timer);

  const tick = () => runDexScreener({ write: true }).catch(() => {});
  setTimeout(tick, 5_000);
  timer = setInterval(tick, DEXSCREENER_INTERVAL_MS);
  timer.unref?.();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return sendJson(res, 200, {
        service: "arian-terminal-worker",
        status: "ok",
        version,
        started_at: startedAt,
        now: new Date().toISOString(),
        scheduler: {
          enabled: ENABLE_DEXSCREENER_INGEST,
          service_role_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, {
        service: "arian-terminal-worker",
        status: "ok",
        version,
        scheduler: schedulerStatus(),
        now: new Date().toISOString()
      });
    }

    if (req.method === "GET" && url.pathname === "/probe/dexscreener") {
      const result = await runDexScreener({ write: false });
      return sendJson(res, 200, { service: "arian-terminal-worker", version, ...result });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 502, {
      service: "arian-terminal-worker",
      status: "error",
      version,
      error: error instanceof Error ? error.message : "unknown_error",
      now: new Date().toISOString()
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ARIAN TERMINAL worker ${version} listening on :${port}`);
  startScheduler();
});
