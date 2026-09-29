import http from "node:http";

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const version = "0.2.0";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEXSCREENER_URL = `https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function runDexScreenerProbe() {
  const started = Date.now();
  const response = await fetch(DEXSCREENER_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "arian-terminal-worker/0.2.0"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`DexScreener HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("DexScreener payload is not an array");
  }

  const canonical = payload
    .filter((pair) =>
      pair?.chainId === "solana" &&
      pair?.dexId === "raydium" &&
      pair?.baseToken?.address === WSOL_MINT &&
      pair?.quoteToken?.address === USDC_MINT
    )
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;

  return {
    mode: "shadow_probe",
    provider: "dexscreener",
    fetched_pairs: payload.length,
    canonical_pair_found: Boolean(canonical),
    canonical_pair: canonical ? {
      pair_address: canonical.pairAddress || null,
      dex_id: canonical.dexId || null,
      price_usd: canonical.priceUsd || null,
      liquidity_usd: canonical?.liquidity?.usd ?? null,
      volume_24h_usd: canonical?.volume?.h24 ?? null
    } : null,
    latency_ms: Date.now() - started,
    writes_to_supabase: false,
    checked_at: new Date().toISOString()
  };
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
        now: new Date().toISOString()
      });
    }

    if (req.method === "GET" && url.pathname === "/probe/dexscreener") {
      const result = await runDexScreenerProbe();
      return sendJson(res, 200, {
        service: "arian-terminal-worker",
        status: "ok",
        version,
        ...result
      });
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
});
