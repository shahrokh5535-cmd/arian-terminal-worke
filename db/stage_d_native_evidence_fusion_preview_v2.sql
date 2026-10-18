-- Stage D: read-only, private positive on-chain proof + Fusion fail-closed adapter.
-- NO transaction replay, score writes, cron activation, or PnL inference.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
CREATE FUNCTION arian_private.arian_d_preview_native_evidence_fusion_v2(p_asset_instance_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path='pg_catalog','public','arian_private'
AS $body$
DECLARE
  fusion jsonb;
  native record;
  audit_found boolean := false;
  sample_ready boolean := false;
BEGIN
  fusion:=arian_private.arian_d_preview_guarded_fusion_v1(p_asset_instance_id);
  SELECT a.observations,a.quote_swaps,a.closed_accounts,a.unsettled_sales,
    a.network_fee_lamports,a.buy_wsol_lamports,a.sell_wsol_lamports,
    a.quote_difference_lamports_not_pnl INTO native
  FROM arian_private.arian_d_native_quote_audit_v1 a
  WHERE a.asset_instance_id=p_asset_instance_id;
  audit_found:=FOUND;
  sample_ready:=audit_found AND native.quote_swaps>0
    AND native.unsettled_sales=0
    AND native.observations=native.quote_swaps+native.closed_accounts;
  RETURN jsonb_build_object(
    'asset_instance_id',p_asset_instance_id,
    'native_sample_status',CASE
       WHEN NOT audit_found THEN 'NO_NATIVE_SAMPLE'
       WHEN sample_ready THEN 'ONCHAIN_QUOTE_EVIDENCE_PRESENT'
       ELSE 'NATIVE_SETTLEMENT_INCOMPLETE' END,
    'native_swap_evidence_count',CASE WHEN audit_found THEN native.quote_swaps ELSE 0 END,
    'native_network_fees_lamports',CASE WHEN audit_found THEN native.network_fee_lamports ELSE NULL END,
    'unsettled_native_sales',CASE WHEN audit_found THEN native.unsettled_sales ELSE NULL END,
    'native_quote_difference_lamports_not_pnl',
      CASE WHEN sample_ready THEN native.quote_difference_lamports_not_pnl ELSE NULL END,
    'pnl_status',CASE WHEN fusion->>'allowed'='true' THEN 'PROOF_GATED' ELSE 'UNKNOWN' END,
    'smart_money_status',CASE WHEN fusion->>'allowed'='true' THEN 'PROOF_GATED' ELSE 'BLOCKED' END,
    'fusion_status',fusion->>'status',
    'fusion_allowed',coalesce((fusion->>'allowed')::boolean,false) AND sample_ready,
    'trusted_fusion_score',
       CASE WHEN coalesce((fusion->>'allowed')::boolean,false) AND sample_ready
         THEN fusion->'trusted_fusion_score' ELSE 'null'::jsonb END,
    'blockers',fusion->'blockers',
    'writes_to_production',false);
END;
$body$;
REVOKE ALL ON FUNCTION arian_private.arian_d_preview_native_evidence_fusion_v2(bigint)
FROM PUBLIC,anon,authenticated;
COMMIT;
