// Strict parsing for third-party discovery links. Never fetch a URL supplied by discovery.
const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const X_EPOCH = 1288834974657n;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

export function validateXPostId(id, { now = Date.now() } = {}) {
  if (typeof id !== "string" || !/^[0-9]{1,20}$/.test(id)) return false;
  let numeric;
  try { numeric = BigInt(id); } catch { return false; }
  if (numeric <= 0n || numeric > ((1n << 64n) - 1n)) return false;
  const timestamp = Number((numeric >> 22n) + X_EPOCH);
  // Modern public-post IDs must decode to a real date; old short IDs are not
  // treated as proof of compromise, but are not authorized for automatic fetch.
  return Number.isSafeInteger(timestamp) && timestamp >= Date.UTC(2010, 10, 1) &&
    timestamp <= now + MAX_FUTURE_MS;
}

export function validateXPostLink(rawUrl, tweetId, options = {}) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048 || !validateXPostId(tweetId, options)) return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
      url.port || url.username || url.password) return false;
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,20})\/?$/.exec(url.pathname);
  return Boolean(match && match[2] === tweetId);
}
