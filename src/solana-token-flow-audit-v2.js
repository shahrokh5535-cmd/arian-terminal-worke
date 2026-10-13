// Stage D / v2: evidence-only, no writes and no PnL calculation.
// This classifier requires exact SPL token deltas on BOTH sides of a DEX transfer.
const DEX = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
]);
const str = v => typeof v === 'string' ? v : v?.pubkey;
const raw = v => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
const reject = reason => ({ status:'UNKNOWN', reason, pnlVerified:false, productionReplayAuthorized:false });
export function auditTokenFlowV2(input, { owner, mint, tokenAccount, poolOwners = [] } = {}) {
  const tx = input?.result ?? input;
  if (![owner,mint,tokenAccount].every(x => typeof x === 'string' && x.length) ||
      !Array.isArray(poolOwners)) return reject('invalid_identity');
  if (!tx?.transaction?.message || !tx?.meta || tx.meta.err != null)
    return reject('failed_or_missing_transaction');
  if (tx.version !== undefined && tx.version !== 'legacy' &&
      (!Number.isInteger(tx.version) || tx.version < 0 || tx.version > 1))
    return reject('unsupported_version');
  const keys = tx.transaction.message.accountKeys?.map(str);
  if (!keys?.includes(tokenAccount)) return reject('missing_token_account');
  const index = keys.indexOf(tokenAccount);
  const find = (rows, i, expectedOwner) => {
    const hits = (rows ?? []).filter(x => x.accountIndex === i && x.mint === mint);
    if (hits.length !== 1 || hits[0].owner !== expectedOwner) return null;
    return raw(hits[0].uiTokenAmount?.amount);
  };
  const observedBefore = find(tx.meta.preTokenBalances,index,owner);
  const after = find(tx.meta.postTokenBalances,index,owner);
  const instructions = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta.innerInstructions ?? []).flatMap(x => x.instructions ?? [])
  ];
  // Never infer an opening zero balance from a missing preTokenBalances row
  // unless the transaction explicitly creates/initializes this token account.
  // Any pre-existing token balance at the same account index blocks inference.
  const created = instructions.some(x => {
    const p = x?.parsed;
    return (['create'].includes(p?.type) &&
        (p.info?.account === tokenAccount || p.info?.associatedAccount === tokenAccount)) ||
      (['initializeAccount','initializeAccount2','initializeAccount3'].includes(p?.type) &&
        p.info?.account === tokenAccount);
  });
  const noPreAccount = !(tx.meta.preTokenBalances ?? []).some(b => b.accountIndex === index);
  const before = observedBefore === null && created && noPreAccount ? 0n : observedBefore;
  const close = instructions.some(x =>
    x.parsed?.type === 'closeAccount' && x.parsed.info?.account === tokenAccount);
  if (before === 0n && after === null && close)
    return { status:'VERIFIED',kind:'empty_token_account_close',
      deltaRaw:'0',pnlVerified:false,productionReplayAuthorized:false };
  if (before === null || after === null) return reject('incomplete_token_balances');
  const delta = after - before;
  if (delta === 0n) return reject('no_token_delta');
  const isDex = instructions.some(x => DEX.has(x.programId));
  if (!isDex) return reject('not_known_dex_program');
  const pools = new Set(poolOwners);
  const movements = instructions.filter(x => {
    const info=x.parsed?.info;
    return x.parsed?.type === 'transferChecked' && info?.mint === mint &&
      (delta < 0n ? info.source === tokenAccount : info.destination === tokenAccount);
  });
  if (!movements.length) return reject('missing_parsed_token_transfer');
  let transferTotal=0n;
  const counterpartAccounts = new Set();
  for (const x of movements) {
    const info=x.parsed.info;
    const amount=raw(info.tokenAmount?.amount);
    const counterpart=delta < 0n ? info.destination : info.source;
    if (amount === null || amount <= 0n || counterpart === tokenAccount ||
        !keys.includes(counterpart)) return reject('invalid_transfer');
    const ci=keys.indexOf(counterpart);
    const pre=(tx.meta.preTokenBalances ?? []).filter(b => b.accountIndex === ci && b.mint === mint);
    const post=(tx.meta.postTokenBalances ?? []).filter(b => b.accountIndex === ci && b.mint === mint);
    if (pre.length !== 1 || post.length !== 1 ||
        !pools.has(pre[0].owner) || pre[0].owner !== post[0].owner)
      return reject('counterparty_not_verified_pool');
    counterpartAccounts.add(counterpart);
    transferTotal += amount;
  }
  const magnitude=delta < 0n ? -delta : delta;
  if (transferTotal !== magnitude) return reject('token_transfer_mismatch');
  let poolNet=0n;
  for (const account of counterpartAccounts) {
    const i=keys.indexOf(account);
    const pre=(tx.meta.preTokenBalances ?? []).find(b => b.accountIndex === i && b.mint === mint);
    const post=(tx.meta.postTokenBalances ?? []).find(b => b.accountIndex === i && b.mint === mint);
    const a=raw(pre?.uiTokenAmount?.amount),b=raw(post?.uiTokenAmount?.amount);
    if (a === null || b === null) return reject('invalid_pool_balance');
    poolNet += b-a;
  }
  if (poolNet !== -delta) return reject('pool_net_delta_mismatch');
  return {status:'VERIFIED',kind:delta < 0n?'dex_pool_sell':'dex_pool_buy',
    tokenDeltaRaw:delta.toString(),poolDeltaRaw:poolNet.toString(),
    evidenceBasis:'finalized_transaction_parsed_spl_transfer_and_opposite_pool_balance_delta',
    pnlVerified:false,productionReplayAuthorized:false};
}
