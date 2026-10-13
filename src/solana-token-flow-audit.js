/**
 * Stage D read-only inspection of one finalized Solana jsonParsed transaction.
 * NEVER writes swaps, positions, trades, or PnL. Does not infer USD proceeds.
 */
const SOLANA_DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);
function accountKey(entry) {
  return typeof entry === 'string' ? entry : entry?.pubkey ?? null;
}
function asUnsignedRaw(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}
function unsupported(reason, extra = {}) {
  return { ...extra, status: 'unsupported', reason, productionReplayAuthorized: false, pnlVerified: false };
}
/**
 * @param {object} transaction Direct getTransaction result or {result:...} RPC envelope
 * @param {{owner:string,mint:string,tokenAccount:string,poolOwners:string[]}} options
 */
export function auditSolanaTokenAccountFlow(transaction, options = {}) {
  const tx = transaction?.result ?? transaction;
  const { owner, mint, tokenAccount, poolOwners = [] } = options;
  if (![owner, mint, tokenAccount].every(x => typeof x === 'string' && x.length > 0))
    return unsupported('missing_identity');
  if (!Array.isArray(poolOwners)) return unsupported('invalid_pool_allowlist');
  if (!tx?.transaction?.message || !tx?.meta || tx.meta.err != null)
    return unsupported('transaction_missing_or_failed');

  const keys = tx.transaction.message.accountKeys?.map(accountKey);
  if (!Array.isArray(keys)) return unsupported('missing_account_keys');
  const index = keys.indexOf(tokenAccount);
  if (index < 0) return unsupported('token_account_not_in_transaction');
  const pre = (tx.meta.preTokenBalances ?? []).filter(x => x.accountIndex === index && x.mint === mint);
  const post = (tx.meta.postTokenBalances ?? []).filter(x => x.accountIndex === index && x.mint === mint);
  if (pre.length > 1 || post.length > 1) return unsupported('ambiguous_token_balance');
  if ((pre[0]?.owner && pre[0].owner !== owner) || (post[0]?.owner && post[0].owner !== owner))
    return unsupported('token_account_owner_mismatch');

  const instructions = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta.innerInstructions ?? []).flatMap(x => x.instructions ?? [])
  ];
  const transfer = instructions.filter(x => {
    const p = x?.parsed;
    return p?.type === 'transferChecked' && p.info?.mint === mint &&
      (p.info.source === tokenAccount || p.info.destination === tokenAccount);
  });
  const close = instructions.some(x => x?.parsed?.type === 'closeAccount' && x.parsed.info?.account === tokenAccount);
  const created = instructions.some(x => {
    const p = x?.parsed;
    return (['create', 'createIdempotent'].includes(p?.type) &&
        (p.info?.account === tokenAccount || p.info?.associatedAccount === tokenAccount)) ||
      (['initializeAccount', 'initializeAccount2', 'initializeAccount3'].includes(p?.type) &&
        p.info?.account === tokenAccount);
  });
  if (!pre.length && !post.length) return unsupported('missing_token_balances');
  if (!pre.length && !created) return unsupported('missing_pre_balance_without_account_creation');
  if (!post.length && !close) return unsupported('missing_post_balance_without_close');
  const before = pre.length ? asUnsignedRaw(pre[0]?.uiTokenAmount?.amount) : 0n;
  const after = post.length ? asUnsignedRaw(post[0]?.uiTokenAmount?.amount) : 0n;
  if (before === null || after === null) return unsupported('invalid_raw_token_balance');
  const delta = after - before;
  const common = {
    status: 'verified_token_delta',
    slot: tx.slot ?? null,
    txVersion: tx.version ?? 'legacy',
    account: tokenAccount,
    mint,
    beforeRaw: before.toString(),
    afterRaw: after.toString(),
    deltaRaw: delta.toString(),
    productionReplayAuthorized: false,
    pnlVerified: false
  };
  if (delta === 0n && close && before === 0n)
    return { ...common, kind: 'empty_token_account_close', basis: 'parsed_close_account_and_zero_balance' };
  if (delta === 0n) return unsupported('no_net_token_change', common);

  const isDex = instructions.some(x => SOLANA_DEX_PROGRAMS.has(x.programId));
  // An arbitrary token withdrawal is not evidence of a sale. Require a verified pool owner.
  const otherAccounts = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])];
  const approvedPools = new Set(poolOwners);
  const eligible = transfer.filter(x => {
    const i = x.parsed.info;
    const other = delta > 0n ? i.source : i.destination;
    if ((delta > 0n && i.destination !== tokenAccount) || (delta < 0n && i.source !== tokenAccount)) return false;
    return otherAccounts.some(balance => balance.mint === mint &&
      keys[balance.accountIndex] === other && approvedPools.has(balance.owner));
  });
  const transferred = eligible.reduce((sum, x) => {
    const raw = asUnsignedRaw(x.parsed.info?.tokenAmount?.amount);
    return raw === null ? -1n : sum + raw;
  }, 0n);
  const magnitude = delta < 0n ? -delta : delta;
  if (isDex && transferred === magnitude && eligible.length > 0)
    return { ...common, kind: delta > 0n ? 'dex_pool_buy' : 'dex_pool_sell',
      basis: 'verified_pool_owner_and_exact_spl_transfer' };
  return unsupported('unclassified_movement_not_safe_for_pnl', common);
}
