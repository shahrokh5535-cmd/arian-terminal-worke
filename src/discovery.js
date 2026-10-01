const version = "0.8.1";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ctikvqtvzoaqqgnxqbgu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const enabled = String(process.env.ENABLE_TOKEN_DISCOVERY || "true").toLowerCase() === "true";
const intervalMs = Math.max(600_000, Number(process.env.TOKEN_DISCOVERY_INTERVAL_MS) || 600_000);
let running = false;
let lastRun = null;
export const tokenDiscoveryStatus = () => ({ enabled, interval_ms: intervalMs, running, last_run: lastRun });

async function rpc(name, body = {}) {
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
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`Supabase RPC ${name} HTTP ${response.status}`);
  return parsed;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `arian-terminal-worker/${version}` },
    signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return payload;
}

export async function runTokenDiscovery({ write = false } = {}) {
  if (running) return { status: "skipped", reason: "already_running" };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const profiles = await fetchJson("https://api.dexscreener.com/token-profiles/latest/v1");
    if (!Array.isArray(profiles)) throw new Error("DexScreener profiles payload is not an array");
    const addresses = profiles
      .filter((x) => x?.chainId === "solana" && typeof x?.tokenAddress === "string" && x.tokenAddress.length > 0)
      .slice(0, 5)
      .map((x) => x.tokenAddress);

    let pairs = [];
    if (addresses.length > 0) {
      const payload = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`);
      if (!Array.isArray(payload)) throw new Error("DexScreener pairs payload is not an array");
      pairs = payload;
    }

    const checkedAt = new Date().toISOString();
    const db = write ? await rpc("arian_external_ingest_token_discovery_v1", {
      p_profiles: profiles,
      p_pairs: pairs,
      p_checked_at: checkedAt
    }) : null;
    if (write && db?.status !== "success") throw new Error("Discovery ingestion did not succeed");
    const result = {
      event: "token_discovery_run",
      status: "success",
      mode: write ? "external_ingest" : "shadow_probe",
      provider: "dexscreener",
      writes_to_supabase: Boolean(write),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      profiles_fetched: profiles.length,
      addresses_checked: addresses.length,
      pairs_fetched: pairs.length,
      checked_at: checkedAt,
      database_result: db
    };
    if (write) lastRun = result;
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      event: "token_discovery_run",
      status: "error",
      mode: write ? "external_ingest" : "shadow_probe",
      provider: "dexscreener",
      writes_to_supabase: Boolean(write),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown_error"
    };
    if (write) lastRun = result;
    console.error(JSON.stringify(result));
    throw error;
  } finally {
    running = false;
  }
}

export function startTokenDiscoveryScheduler() {
 if (enabled && SUPABASE_SERVICE_ROLE_KEY) {
  const tick = () => runTokenDiscovery({ write: true }).catch(() => {});
  setTimeout(tick, 80_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

}
