-- Stage D integration, STAGING ONLY. Do not apply without review and transaction-level tests.
-- This file creates a private evidence ledger and READ-ONLY guarded projection.
-- It does NOT redefine/trigger live scoring, Fusion, or existing feeds.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
CREATE TABLE arian_private.arian_d_verified_trade_proofs_v1 (
  wallet_trade_id bigint PRIMARY KEY REFERENCES public.wallet_trades(id) ON DELETE RESTRICT,
  entry_swap_id bigint NOT NULL REFERENCES public.swaps(id) ON DELETE RESTRICT,
  exit_swap_id bigint NOT NULL REFERENCES public.swaps(id) ON DELETE RESTRICT,
  cost_basis_usd numeric(30,12) NOT NULL CHECK (cost_basis_usd > 0),
  sale_proceeds_usd numeric(30,12) NOT NULL CHECK (sale_proceeds_usd >= 0),
  all_fees_usd numeric(30,12) NOT NULL CHECK (all_fees_usd >= 0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verification_source text NOT NULL DEFAULT 'finalized_solana_transaction'
    CHECK (verification_source = 'finalized_solana_transaction'),
  history_complete boolean NOT NULL CHECK (history_complete IS TRUE),
  execution_quotes_verified boolean NOT NULL CHECK (execution_quotes_verified IS TRUE),
  fees_verified boolean NOT NULL CHECK (fees_verified IS TRUE),
  verified_at timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_swap_id <> exit_swap_id),
  UNIQUE(entry_swap_id,exit_swap_id)
);
COMMENT ON TABLE arian_private.arian_d_verified_trade_proofs_v1 IS
 'Manual independent finalized entry/exit proof only; never auto-import from wallet_trades prices, candles or a token balance delta';
ALTER TABLE arian_private.arian_d_verified_trade_proofs_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arian_private.arian_d_verified_trade_proofs_v1 FROM PUBLIC,anon,authenticated;

CREATE VIEW arian_private.arian_d_guarded_trades_v1 WITH (security_barrier=true) AS
SELECT wt.id AS wallet_trade_id,wt.wallet_address_id,wt.asset_instance_id,
  check_evidence.is_verified,
  CASE WHEN check_evidence.is_verified THEN
    p.sale_proceeds_usd-p.cost_basis_usd-p.all_fees_usd ELSE NULL END AS verified_realized_pnl_usd,
  CASE WHEN check_evidence.is_verified THEN
    round(((p.sale_proceeds_usd-p.cost_basis_usd-p.all_fees_usd)/p.cost_basis_usd*100)::numeric,2)
    ELSE NULL END AS verified_pnl_percent,
  CASE WHEN check_evidence.is_verified THEN 'VERIFIED' ELSE 'UNKNOWN' END AS pnl_status
FROM public.wallet_trades wt
LEFT JOIN arian_private.arian_d_verified_trade_proofs_v1 p ON p.wallet_trade_id=wt.id
LEFT JOIN public.swaps b ON b.id=p.entry_swap_id
LEFT JOIN public.swaps s ON s.id=p.exit_swap_id
LEFT JOIN public.blockchain_transactions bt_b ON bt_b.id=b.transaction_id
LEFT JOIN public.blockchain_transactions bt_s ON bt_s.id=s.transaction_id
CROSS JOIN LATERAL (
  SELECT coalesce(
    p.wallet_trade_id IS NOT NULL
    AND wt.wallet_address_id IS NOT NULL AND wt.asset_instance_id IS NOT NULL
    AND wt.source_swap_id IN (p.entry_swap_id,p.exit_swap_id)
    AND b.wallet_address_id=wt.wallet_address_id AND s.wallet_address_id=wt.wallet_address_id
    AND b.output_instance_id=wt.asset_instance_id AND s.input_instance_id=wt.asset_instance_id
    AND b.executed_at<s.executed_at
    AND b.swap_status='finalized' AND s.swap_status='finalized'
    AND bt_b.transaction_status='finalized' AND bt_s.transaction_status='finalized'
    AND bt_b.tx_hash IS NOT NULL AND bt_s.tx_hash IS NOT NULL
    AND bt_b.tx_hash<>bt_s.tx_hash
    AND b.input_amount_usd IS NOT NULL AND s.output_amount_usd IS NOT NULL
    AND b.fee_usd IS NOT NULL AND s.fee_usd IS NOT NULL
    AND abs(b.input_amount_usd-p.cost_basis_usd)<=0.000001
    AND abs(s.output_amount_usd-p.sale_proceeds_usd)<=0.000001
    AND p.all_fees_usd >= (b.fee_usd+s.fee_usd)
    AND wt.pnl_percent IS NOT NULL
    AND abs(wt.pnl_percent -
      round(((p.sale_proceeds_usd-p.cost_basis_usd-p.all_fees_usd)/nullif(p.cost_basis_usd,0)*100)::numeric,2))<=0.01
  ,false) AS is_verified
) AS check_evidence;

CREATE VIEW arian_private.arian_d_guarded_wallet_smart_v1 WITH (security_barrier=true) AS
SELECT wa.id AS wallet_address_id, count(gt.wallet_trade_id)::bigint AS total_trades,
  count(gt.wallet_trade_id) FILTER (WHERE gt.is_verified)::bigint AS verified_trades,
  count(gt.wallet_trade_id) FILTER (WHERE NOT gt.is_verified)::bigint AS unknown_trades,
  CASE WHEN count(gt.wallet_trade_id)>0
           AND count(gt.wallet_trade_id)=count(gt.wallet_trade_id) FILTER (WHERE gt.is_verified)
           AND ws.calculated_at>=max(wt.created_at)
       THEN ws.smart_score ELSE NULL END AS trusted_smart_score,
  CASE WHEN count(gt.wallet_trade_id)>0
           AND count(gt.wallet_trade_id)=count(gt.wallet_trade_id) FILTER (WHERE gt.is_verified)
           AND ws.calculated_at>=max(wt.created_at)
       THEN sum(gt.verified_realized_pnl_usd) ELSE NULL END AS trusted_realized_pnl_usd,
  ws.smart_score AS calculated_unverified_score,
  CASE WHEN count(gt.wallet_trade_id)>0
           AND count(gt.wallet_trade_id)=count(gt.wallet_trade_id) FILTER (WHERE gt.is_verified)
           AND ws.calculated_at>=max(wt.created_at)
       THEN 'VERIFIED' ELSE 'UNKNOWN' END AS performance_status
FROM public.wallet_addresses wa
JOIN public.chains c ON c.id=wa.chain_id AND c.chain_key='solana'
LEFT JOIN arian_private.arian_d_guarded_trades_v1 gt ON gt.wallet_address_id=wa.id
LEFT JOIN public.wallet_trades wt ON wt.id=gt.wallet_trade_id
LEFT JOIN public.wallet_smart_money_scores ws ON ws.wallet_address_id=wa.id
GROUP BY wa.id,ws.smart_score,ws.calculated_at;

CREATE FUNCTION arian_private.arian_d_preview_guarded_fusion_v1(p_asset_instance_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path='pg_catalog','public','arian_private'
AS $func$
DECLARE
  base jsonb;
  total_wallets bigint;
  verified_wallets bigint;
  verified_wallet_score_latest timestamptz;
  asset_score_time timestamptz;
  asset_score numeric;
  eligible boolean;
  blockers jsonb;
BEGIN
  base:=public.arian_check_production_fusion_readiness(p_asset_instance_id);
  SELECT count(*),count(*) FILTER (WHERE gw.performance_status='VERIFIED'),
         max(ws.calculated_at) FILTER (WHERE gw.performance_status='VERIFIED')
  INTO total_wallets,verified_wallets,verified_wallet_score_latest
  FROM (
     SELECT DISTINCT wallet_address_id FROM public.wallet_trade_identity_v2
     WHERE asset_instance_id=p_asset_instance_id AND wallet_address_id IS NOT NULL
  ) x
  LEFT JOIN arian_private.arian_d_guarded_wallet_smart_v1 gw ON gw.wallet_address_id=x.wallet_address_id
  LEFT JOIN public.wallet_smart_money_scores ws ON ws.wallet_address_id=x.wallet_address_id;
  SELECT smart_money_score,calculated_at INTO asset_score,asset_score_time
  FROM public.asset_smart_money_scores
  WHERE asset_instance_id=p_asset_instance_id ORDER BY calculated_at DESC LIMIT 1;
  eligible:=coalesce((base->>'allowed')::boolean,false) AND total_wallets>0
        AND total_wallets=verified_wallets AND asset_score IS NOT NULL
        AND asset_score_time IS NOT NULL
        AND asset_score_time>=verified_wallet_score_latest;
  blockers:=coalesce(base->'blockers','[]'::jsonb);
  IF total_wallets=0 OR verified_wallets<total_wallets THEN
    blockers:=blockers||'["smart_money_trade_proof_missing"]'::jsonb;
  END IF;
  IF asset_score_time IS NULL OR verified_wallet_score_latest IS NULL
      OR asset_score_time<verified_wallet_score_latest THEN
    blockers:=blockers||'["smart_money_score_refresh_required"]'::jsonb;
  END IF;
  RETURN jsonb_build_object('asset_instance_id',p_asset_instance_id,
    'status',CASE WHEN eligible THEN 'READY_FOR_CONTROLLED_TEST' ELSE 'BLOCKED' END,
    'allowed',eligible,'blockers',blockers,
    'wallets_total',total_wallets,'wallets_verified',verified_wallets,
    'trusted_smart_money_score',CASE WHEN eligible THEN asset_score ELSE NULL END,
    'trusted_fusion_score',NULL,'writes_to_production',false);
END;
$func$;
REVOKE ALL ON FUNCTION arian_private.arian_d_preview_guarded_fusion_v1(bigint)
FROM PUBLIC,anon,authenticated;
COMMIT;
