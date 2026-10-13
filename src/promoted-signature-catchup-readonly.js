/**
 * Stage D: bounded read-only Solana signature history scan.
 * Known signatures are deduplication hints, NOT proof older history is complete.
 * Never writes, claims a lease, or authorizes a production trade/position/PnL.
 */
export async function discoverMissingPoolSignatures({
  address, knownSignatures = [], fetchPage, pageSize = 25, maxPages = 4
}) {
  const valid = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(x);
  if (!valid(address) || address.length > 44) throw new Error('invalid_pool_address');
  if (!Array.isArray(knownSignatures) || knownSignatures.some(x => !valid(x)))
    throw new Error('invalid_known_signatures');
  if (typeof fetchPage !== 'function') throw new Error('missing_rpc_reader');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
    throw new Error('invalid_bounded_limits');

  const known = new Set(knownSignatures);
  const seen = new Set();
  const candidates = [];
  let before;
  let pagesRead = 0;
  let knownEncountered = 0;
  let historyExhausted = false;
  let reason = 'page_budget_exhausted';
  for (let page = 0; page < maxPages; page++) {
    let rows;
    try { rows = await fetchPage({ address, before, limit: pageSize }); }
    catch { reason = 'rpc_error'; break; }
    pagesRead++;
    if (!Array.isArray(rows) || rows.length > pageSize ||
        rows.some(r => !r || !valid(r.signature))) {
      reason = 'invalid_rpc_page'; break;
    }
    if (rows.length === 0) { historyExhausted = true; reason = 'history_exhausted'; break; }
    if (rows.some(r => seen.has(r.signature)) ||
        new Set(rows.map(r => r.signature)).size !== rows.length) {
      reason = 'nonprogressing_pagination'; break;
    }
    for (const row of rows) {
      seen.add(row.signature);
      if (known.has(row.signature)) { knownEncountered++; continue; }
      candidates.push({ signature: row.signature, slot: row.slot ?? null,
        blockTime: row.blockTime ?? null, finalized: row.confirmationStatus === 'finalized',
        succeeded: row.err === null });
    }
    if (rows.length < pageSize) { historyExhausted = true; reason = 'history_exhausted'; break; }
    const cursor = rows.at(-1).signature;
    if (cursor === before) { reason = 'nonprogressing_pagination'; break; }
    before = cursor;
  }
  return { address, pagesRead, pageSize, maxPages, knownEncountered,
    historyExhausted, coverageComplete: historyExhausted, reason, candidates,
    productionReplayAuthorized: false, pnlVerified: false };
}
