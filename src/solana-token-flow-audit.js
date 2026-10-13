/**
 * ARIAN TERMINAL Stage D: evidence-only audit for one finalized Solana
 * jsonParsed transaction. This module DOES NOT write trades/positions/PnL.
 * A pool-directed token movement alone never proves sale proceeds or profit.
 */
const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);

const key = x => typeof x === 'string' ? x : x?.pubkey ?? null;
const raw = x => typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : null;
const blocked = (reason, extra = {}) =>
  ({ ...extra, status: 'unsupported', reason, productionReplayAuthorized: false, pnlVerified: false });

/**
 * @param {object} transaction Direct RPC getTransaction result (or {result})
 * @param {{owner:string,mint:string,tokenAccount:string,poolOwners:string[]}} identity
 */
export function auditSolanaTokenAccountFlow(transaction, identity = {}) {
  const tx = transaction?.result ?? transaction;
  const { owner, mint, tokenAccount, poolOwners = [] } = identity;
  if (![owner, mint, tokenAccount].every(v => typeof v === 'string' && v.length))
    return blocked('missing_identity');
  if (!Array.isArray(poolOwners)) return blocked('invalid_pool_allowlist');
  if (!tx?.transaction?.message || !tx?.meta || tx.meta.err != null)
    return blocked('transaction_missing_or_failed');
  // Modern RPC version 1 is supported for reading evidence, not executing.
  if (tx.version !== undefined && tx.version !== 'legacy' &&
      (!Number.isInteger(tx.version) || tx.version < 0 || tx.version > 1))
    return blocked('unsupported_transaction_version');

  const keys = tx.transaction.message.accountKeys?.map(key);
  if (!Array.isArray(keys)) return blocked('missing_account_keys');
  const index = keys.indexOf(tokenAccount);
  if (index < 0) return blocked('token_account_not_in_transaction');

  const pre = (tx.meta.preTokenBalances ?? []).filter(b => b.accountIndex === index && b.mint === mint);
  const post = (tx.meta.postTokenBalances ?? []).filter(b => b.accountIndex === index && b.mint === mint);
  if (pre.length > 1 || post.length > 1) return blocked('ambiguous_token_balance');
  if ((pre[0]?.owner && pre[0].owner !== owner) ||
      (post[0]?.owner && post[0].owner !== owner))
    return blocked('token_account_owner_mismatch');

  const instructions = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta.innerInstructions ?? []).flatMap(x => x.instructions ?? [])
  ];
  const transferred = instructions.filter(x =>
    x?.parsed?.type === 'transferChecked' &&
    x.parsed.info?.mint === mint &&
    (x.parsed.info.source === tokenAccount || x.parsed.info.destination === tokenAccount)
  );
  const close = instructions.some(x =>
    x?.parsed?.type === 'closeAccount' && x.parsed.info?.account === tokenAccount
  );
  const created = instructions.some(x => {
    const p = x?.parsed;
    return (p?.type === 'create' &&
        (p.info?.account === tokenAccount || p.info?.associatedAccount === tokenAccount)) ||
      (['initializeAccount','initializeAccount2','initializeAccount3'].includes(p?.type) &&
        p.info?.account === tokenAccount);
  });

  if (!pre.length && !post.length) return blocked('missing_token_balances');
  if (!pre.length && !created) return blocked('missing_pre_balance_without_account_creation');
  if (!post.length && !close) return blocked('missing_post_balance_without_close');
  const before = pre.length ? raw(pre[0].uiTokenAmount?.amount) : 0n;
  const after = post.length ? raw(post[0].uiTokenAmount?.amount) : 0n;
  if (before === null || after === null) return blocked('invalid_raw_token_balance');
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
    return { ...common, kind:'empty_token_account_close', basis:'parsed_close_account_and_zero_balance' };
  if (delta === 0n) return blocked('no_net_token_change', common);

  const isDex = instructions.some(x => DEX_PROGRAMS.has(x.programId));
  const otherBalances = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])];
  const allowedPoolOwners = new Set(poolOwners);
  const eligible = transferred.filter(x => {
    const info = x.parsed.info;
    if ((delta > 0n && info.destination !== tokenAccount) ||
        (delta < 0n && info.source !== tokenAccount)) return false;
    const other = delta > 0n ? info.source : info.destination;
    return otherBalances.some(b =>
      b.mint === mint && keys[b.accountIndex] === other && allowedPoolOwners.has(b.owner)
    );
  });
  const total = eligible.reduce((sum,x) => {
    const amount = raw(x.parsed.info?.tokenAmount?.amount);
    return amount === null ? -1n : sum + amount;
  }, 0n);
  const magnitude = delta < 0n ? -delta : delta;
  if (isDex && eligible.length && total === magnitude)
    return { ...common, kind:delta > 0n ? 'dex_pool_buy' : 'dex_pool_sell',
      basis:'verified_pool_owner_and_exact_spl_transfer' };

  // An arbitrary transfer is not necessarily a wallet-to-wallet transfer:
  // it could be a different DEX/protocol. Fail closed.
  return blocked('unclassified_movement_not_safe_for_pnl', common);
}
