-- Execute read-only against staged private functions.
-- Every violation count MUST equal zero. Never fabricate production proofs.
WITH cases AS (
SELECT 'unknown_trade_leaks_pnl' AS test,count(*) AS violations
FROM arian_private.arian_d_guarded_trades_v1
WHERE pnl_status='UNKNOWN' AND (verified_realized_pnl_usd IS NOT NULL OR verified_pnl_percent IS NOT NULL)
UNION ALL
SELECT 'verified_trade_without_proof',count(*)
FROM arian_private.arian_d_guarded_trades_v1
WHERE pnl_status='VERIFIED' AND is_verified IS DISTINCT FROM TRUE
UNION ALL
SELECT 'unknown_wallet_leaks_score',count(*)
FROM arian_private.arian_d_guarded_wallet_smart_v1
WHERE performance_status='UNKNOWN' AND
(trusted_smart_score IS NOT NULL OR trusted_realized_pnl_usd IS NOT NULL)
UNION ALL
SELECT 'verified_wallet_incomplete',count(*)
FROM arian_private.arian_d_guarded_wallet_smart_v1
WHERE performance_status='VERIFIED' AND
(total_trades=0 OR verified_trades<>total_trades OR unknown_trades<>0)
),
fusion AS (
 SELECT id,arian_private.arian_d_preview_guarded_fusion_v1(id) x
 FROM (VALUES (100::bigint),(137::bigint)) v(id)
)
SELECT test,violations FROM cases
UNION ALL
SELECT 'blocked_fusion_leaks_score',count(*) FROM fusion
WHERE x->>'status'='BLOCKED'
AND (x->>'trusted_fusion_score' IS NOT NULL OR x->>'trusted_smart_money_score' IS NOT NULL)
ORDER BY test;
