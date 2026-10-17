// Stage D release gate: pure, read-only PnL presentation policy.
// Never infer monetary profit from token deltas or historical reference candles.
export function presentVerifiedTrade(trade = {}) {
  const required = ["signature", "inputAmountRaw", "outputAmountRaw", "inputUsd", "outputUsd", "feeUsd"];
  const validText = x => typeof x === "string" && x.trim().length > 0;
  const validRaw = x => typeof x === "string" && /^[0-9]+$/.test(x) && BigInt(x) > 0n;
  const validUsd = x => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const evidence = trade.evidence ?? {};
  const verified =
    validText(trade.signature) &&
    validRaw(trade.inputAmountRaw) && validRaw(trade.outputAmountRaw) &&
    validUsd(trade.inputUsd) && validUsd(trade.outputUsd) && validUsd(trade.feeUsd) &&
    evidence.finalized === true && evidence.signatureMatches === true &&
    evidence.inputOutputVerified === true && evidence.executionQuoteVerified === true &&
    evidence.feeVerified === true && evidence.historyComplete === true &&
    evidence.source === "solana_transaction";
  if (!verified) return {
    signature: validText(trade.signature) ? trade.signature : null,
    pnlStatus: "UNKNOWN", realizedPnlUsd: null, win: null,
    eligibleForSmartMoneyWinRate: false, source: "unverified_or_incomplete"
  };
  const pnl = trade.outputUsd - trade.inputUsd - trade.feeUsd;
  if (!Number.isFinite(pnl)) return {
    signature: trade.signature, pnlStatus: "UNKNOWN", realizedPnlUsd: null, win: null,
    eligibleForSmartMoneyWinRate: false, source: "unsafe_numeric_result"
  };
  return {signature: trade.signature,pnlStatus:"VERIFIED",realizedPnlUsd:pnl,
    win:pnl>0,eligibleForSmartMoneyWinRate:true,source:"solana_transaction"};
}
