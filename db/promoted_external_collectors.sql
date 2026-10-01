-- External HTTP collection only; legacy functions/jobs remain available for rollback.
CREATE OR REPLACE FUNCTION public.arian_external_claim_promoted_market_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE v_connector_id bigint; v_market_id bigint; v_pool_id bigint; v_pair text; v_instance_id bigint; v_run_id bigint; v_request_id bigint; v_existing bigint;
BEGIN
  SELECT id INTO v_connector_id FROM public.connectors WHERE connector_key='dexscreener_promoted_market_rest' AND is_enabled=true LIMIT 1 FOR UPDATE;
  SELECT id INTO v_existing FROM public.ingestion_runs WHERE connector_id=v_connector_id AND status='running' AND started_at>=now()-interval '10 minutes' ORDER BY started_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('status','idle','reason','existing_run'); END IF;
  UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=COALESCE(error_message,'stale promoted market run expired')
  WHERE connector_id=v_connector_id AND status='running' AND started_at<now()-interval '10 minutes';

  SELECT m.id,lp.id,lp.pool_address_normalized,lp.token0_instance_id
    INTO v_market_id,v_pool_id,v_pair,v_instance_id
  FROM public.markets m
  JOIN public.liquidity_pools lp ON lp.market_id=m.id
  JOIN public.venues v ON v.id=m.venue_id
  WHERE m.status='active' AND lp.status='active' AND v.venue_key='pumpswap'
    AND COALESCE((m.metadata_json->>'promoted_from_discovery')::boolean,false)=true
  ORDER BY COALESCE((SELECT max(ms.snapshot_at) FROM public.market_snapshots ms WHERE ms.market_id=m.id),'epoch'::timestamptz),m.id
  LIMIT 1;
  IF v_market_id IS NULL THEN RETURN jsonb_build_object('status','idle'); END IF;

  INSERT INTO public.ingestion_runs(connector_id,run_type,status,metadata_json)
  VALUES(v_connector_id,'scheduled','running',jsonb_build_object('provider','dexscreener','dataset','promoted_pair_snapshot',
    'market_id',v_market_id,'pool_id',v_pool_id,'pair_address',v_pair,'asset_instance_id',v_instance_id)) RETURNING id INTO v_run_id;

  UPDATE public.ingestion_runs SET metadata_json=metadata_json||jsonb_build_object('transport','blitz_worker','stage','external_claimed') WHERE id=v_run_id;
  RETURN (SELECT metadata_json||jsonb_build_object('status','claimed','run_id',id) FROM public.ingestion_runs WHERE id=v_run_id);
END; $function$;
CREATE OR REPLACE FUNCTION public.arian_external_peek_promoted_market_v1() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_market_id bigint;v_pool_id bigint;v_pair text;v_instance_id bigint;
BEGIN

  SELECT m.id,lp.id,lp.pool_address_normalized,lp.token0_instance_id
    INTO v_market_id,v_pool_id,v_pair,v_instance_id
  FROM public.markets m
  JOIN public.liquidity_pools lp ON lp.market_id=m.id
  JOIN public.venues v ON v.id=m.venue_id
  WHERE m.status='active' AND lp.status='active' AND v.venue_key='pumpswap'
    AND COALESCE((m.metadata_json->>'promoted_from_discovery')::boolean,false)=true
  ORDER BY COALESCE((SELECT max(ms.snapshot_at) FROM public.market_snapshots ms WHERE ms.market_id=m.id),'epoch'::timestamptz),m.id
  LIMIT 1;
RETURN jsonb_build_object('status',case when v_pool_id is null then 'idle' else 'ready' end,
 'pair_address',v_pair,'pool_id',v_pool_id,'market_id',v_market_id);
END; $function$;
CREATE OR REPLACE FUNCTION public.arian_external_ingest_promoted_market_v1(p_run_id bigint,p_payload jsonb,p_error text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE v_run public.ingestion_runs%ROWTYPE; v_resp record; v_pair jsonb; v_source_id bigint; v_raw_id bigint; v_snapshot_id bigint; v_market_score jsonb;
BEGIN
  SELECT * INTO v_run FROM public.ingestion_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run % not found',p_run_id; END IF;
  IF v_run.status<>'running' THEN RETURN jsonb_build_object('run_id',p_run_id,'status',v_run.status); END IF;

  IF v_run.metadata_json->>'transport' IS DISTINCT FROM 'blitz_worker'
   OR v_run.metadata_json->>'dataset' IS DISTINCT FROM 'promoted_pair_snapshot'
   OR v_run.connector_id IS DISTINCT FROM (SELECT id FROM public.connectors WHERE connector_key='dexscreener_promoted_market_rest' LIMIT 1)
  THEN RAISE EXCEPTION 'invalid external promoted claim'; END IF;
  IF p_error IS NOT NULL THEN
   UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=left(p_error,500) WHERE id=p_run_id;
   RETURN jsonb_build_object('status','failed','run_id',p_run_id);
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payload must be an object'; END IF;
  v_pair:=p_payload->'pair';
  IF v_pair IS NULL OR v_pair->>'pairAddress' IS DISTINCT FROM v_run.metadata_json->>'pair_address' THEN
    UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message='DexScreener pair identity mismatch' WHERE id=p_run_id;
    RETURN jsonb_build_object('run_id',p_run_id,'status','failed','reason','identity_mismatch');
  END IF;
  IF v_pair->>'chainId' IS DISTINCT FROM 'solana' OR v_pair->>'dexId' IS DISTINCT FROM 'pumpswap' THEN RAISE EXCEPTION 'invalid promoted market identity'; END IF;
  SELECT c.source_id INTO v_source_id FROM public.connectors c WHERE c.id=v_run.connector_id;
  INSERT INTO public.raw_events(source_id,connector_id,ingestion_run_id,event_type,chain_id,event_timestamp,processing_status,payload_json,schema_version,metadata_json)
  VALUES(v_source_id,v_run.connector_id,p_run_id,'dexscreener_promoted_pair_snapshot',
    (SELECT chain_id FROM public.markets WHERE id=(v_run.metadata_json->>'market_id')::bigint),now(),'processed',v_pair,'1',
    jsonb_build_object('transport','blitz_worker','market_id',(v_run.metadata_json->>'market_id')::bigint,'pool_id',(v_run.metadata_json->>'pool_id')::bigint)) RETURNING id INTO v_raw_id;

  INSERT INTO public.market_snapshots(
    market_id,source_id,pool_id,snapshot_at,price_usd,price_quote,liquidity_usd,
    volume_5m_usd,volume_1h_usd,volume_6h_usd,volume_24h_usd,buys_5m,sells_5m,buys_1h,sells_1h,
    price_change_5m,price_change_1h,price_change_6h,price_change_24h,market_cap_usd,fdv_usd,metadata_json
  ) VALUES(
    (v_run.metadata_json->>'market_id')::bigint,v_source_id,(v_run.metadata_json->>'pool_id')::bigint,now(),
    NULLIF(v_pair->>'priceUsd','')::numeric,NULLIF(v_pair->>'priceNative','')::numeric,NULLIF(v_pair->'liquidity'->>'usd','')::numeric,
    NULLIF(v_pair->'volume'->>'m5','')::numeric,NULLIF(v_pair->'volume'->>'h1','')::numeric,NULLIF(v_pair->'volume'->>'h6','')::numeric,NULLIF(v_pair->'volume'->>'h24','')::numeric,
    NULLIF(v_pair->'txns'->'m5'->>'buys','')::int,NULLIF(v_pair->'txns'->'m5'->>'sells','')::int,
    NULLIF(v_pair->'txns'->'h1'->>'buys','')::int,NULLIF(v_pair->'txns'->'h1'->>'sells','')::int,
    NULLIF(v_pair->'priceChange'->>'m5','')::numeric,NULLIF(v_pair->'priceChange'->>'h1','')::numeric,NULLIF(v_pair->'priceChange'->>'h6','')::numeric,NULLIF(v_pair->'priceChange'->>'h24','')::numeric,
    NULLIF(v_pair->>'marketCap','')::numeric,NULLIF(v_pair->>'fdv','')::numeric,jsonb_build_object('raw_event_id',v_raw_id,'source','promoted_market_monitor')
  ) RETURNING id INTO v_snapshot_id;

  UPDATE public.markets SET last_seen_at=now(),updated_at=now() WHERE id=(v_run.metadata_json->>'market_id')::bigint;
  UPDATE public.liquidity_pools SET last_seen_at=now(),updated_at=now() WHERE id=(v_run.metadata_json->>'pool_id')::bigint;
  BEGIN v_market_score:=public.arian_refresh_production_market_score((v_run.metadata_json->>'asset_instance_id')::bigint); EXCEPTION WHEN OTHERS THEN v_market_score:=jsonb_build_object('status','score_error','error',SQLERRM); END;
  BEGIN PERFORM public.arian_detect_market_events_v1(); EXCEPTION WHEN OTHERS THEN NULL; END;
  UPDATE public.ingestion_runs SET status='success',finished_at=now(),records_fetched=1,records_inserted=1,
    metadata_json=metadata_json||jsonb_build_object('raw_event_id',v_raw_id,'snapshot_id',v_snapshot_id,'market_score_result',v_market_score,'finalized_at',now()) WHERE id=p_run_id;
  RETURN jsonb_build_object('run_id',p_run_id,'status','success','snapshot_id',v_snapshot_id,'market_score',v_market_score);
END;
$function$;

REVOKE ALL ON FUNCTION public.arian_external_claim_promoted_market_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_claim_promoted_market_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_peek_promoted_market_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_peek_promoted_market_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_ingest_promoted_market_v1(bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_ingest_promoted_market_v1(bigint,jsonb,text) TO service_role,postgres;
CREATE OR REPLACE FUNCTION public.arian_external_claim_promoted_signatures_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_connector_id bigint; v_chain_id bigint; v_run_id bigint; v_existing bigint; v_request_id bigint;
  v_pool_id bigint; v_pool_address text; v_market_id bigint; v_venue_id bigint; v_asset_instance_id bigint;
BEGIN
  SELECT id INTO v_connector_id FROM public.connectors
  WHERE connector_key='solana_rpc_promoted_pools' AND is_enabled=true LIMIT 1 FOR UPDATE;
  SELECT id INTO v_chain_id FROM public.chains WHERE chain_key='solana' AND is_active=true LIMIT 1;
  IF v_connector_id IS NULL OR v_chain_id IS NULL THEN RAISE EXCEPTION 'Promoted pool RPC prerequisites missing'; END IF;

  SELECT ir.id INTO v_existing
  FROM public.ingestion_runs ir
  WHERE ir.connector_id=v_connector_id AND ir.status='running' AND ir.started_at>=now()-interval '10 minutes'
  ORDER BY ir.started_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('status','idle','reason','existing_run'); END IF;

  UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,
    error_message=COALESCE(error_message,'stale promoted pool signature run expired')
  WHERE connector_id=v_connector_id AND status='running' AND started_at<now()-interval '10 minutes';

  SELECT lp.id,lp.pool_address_normalized,lp.market_id,lp.venue_id,lp.token0_instance_id
    INTO v_pool_id,v_pool_address,v_market_id,v_venue_id,v_asset_instance_id
  FROM public.liquidity_pools lp
  JOIN public.markets m ON m.id=lp.market_id
  JOIN public.venues v ON v.id=lp.venue_id
  WHERE lp.chain_id=v_chain_id AND lp.status='active' AND m.status='active'
    AND COALESCE((m.metadata_json->>'promoted_from_discovery')::boolean,false)=true
    AND v.venue_key='pumpswap'
  ORDER BY COALESCE((
      SELECT max(re.received_at)
      FROM public.raw_events re
      WHERE re.event_type='solana_promoted_pool_signature_batch'
        AND re.metadata_json->>'pool_id'=lp.id::text
    ),'epoch'::timestamptz),lp.id
  LIMIT 1;

  IF v_pool_id IS NULL THEN RETURN jsonb_build_object('status','idle'); END IF;

  INSERT INTO public.ingestion_runs(connector_id,run_type,status,metadata_json)
  VALUES(v_connector_id,'scheduled','running',jsonb_build_object(
    'provider','solana_rpc','dataset','promoted_pool_signatures','chain_id',v_chain_id,
    'pool_id',v_pool_id,'pool_address',v_pool_address,'market_id',v_market_id,'venue_id',v_venue_id,
    'asset_instance_id',v_asset_instance_id,'limit',3,'commitment','finalized'
  )) RETURNING id INTO v_run_id;


  UPDATE public.ingestion_runs SET metadata_json=metadata_json||jsonb_build_object('transport','blitz_worker','stage','external_claimed') WHERE id=v_run_id;
  RETURN (SELECT metadata_json||jsonb_build_object('status','claimed','run_id',id) FROM public.ingestion_runs WHERE id=v_run_id);
END; $function$;
CREATE OR REPLACE FUNCTION public.arian_external_peek_promoted_signatures_v1() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_pool_id bigint;v_pool_address text;v_market_id bigint;v_venue_id bigint;v_asset_instance_id bigint;v_chain_id bigint;
BEGIN
SELECT id INTO v_chain_id FROM public.chains WHERE chain_key='solana' AND is_active LIMIT 1;
  SELECT lp.id,lp.pool_address_normalized,lp.market_id,lp.venue_id,lp.token0_instance_id
    INTO v_pool_id,v_pool_address,v_market_id,v_venue_id,v_asset_instance_id
  FROM public.liquidity_pools lp
  JOIN public.markets m ON m.id=lp.market_id
  JOIN public.venues v ON v.id=lp.venue_id
  WHERE lp.chain_id=v_chain_id AND lp.status='active' AND m.status='active'
    AND COALESCE((m.metadata_json->>'promoted_from_discovery')::boolean,false)=true
    AND v.venue_key='pumpswap'
  ORDER BY COALESCE((
      SELECT max(re.received_at)
      FROM public.raw_events re
      WHERE re.event_type='solana_promoted_pool_signature_batch'
        AND re.metadata_json->>'pool_id'=lp.id::text
    ),'epoch'::timestamptz),lp.id
  LIMIT 1;
RETURN jsonb_build_object('status',case when v_pool_id is null then 'idle' else 'ready' end,
 'pool_address',v_pool_address,'pool_id',v_pool_id,'market_id',v_market_id);
END; $function$;
CREATE OR REPLACE FUNCTION public.arian_external_ingest_promoted_signatures_v1(p_run_id bigint,p_payload jsonb,p_error text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_run public.ingestion_runs%ROWTYPE; v_resp record; v_payload jsonb; v_source_id bigint; v_chain_id bigint;
  v_raw_id bigint; v_fetched int:=0; v_inserted int:=0;
BEGIN
  SELECT * INTO v_run FROM public.ingestion_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run % not found',p_run_id; END IF;
  IF v_run.status<>'running' THEN RETURN jsonb_build_object('run_id',p_run_id,'status',v_run.status); END IF;


  IF v_run.metadata_json->>'transport' IS DISTINCT FROM 'blitz_worker'
   OR v_run.metadata_json->>'dataset' IS DISTINCT FROM 'promoted_pool_signatures'
   OR v_run.connector_id IS DISTINCT FROM (SELECT id FROM public.connectors WHERE connector_key='solana_rpc_promoted_pools' LIMIT 1)
  THEN RAISE EXCEPTION 'invalid external promoted claim'; END IF;
  IF p_error IS NOT NULL THEN
   UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=left(p_error,500) WHERE id=p_run_id;
   RETURN jsonb_build_object('status','failed','run_id',p_run_id);
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payload must be an object'; END IF;
  v_payload:=p_payload;
  IF NOT (v_payload ? 'error') AND jsonb_typeof(v_payload->'result') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'signature result must be an array'; END IF;
  IF v_payload ? 'error' THEN
    UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=left((v_payload->'error')::text,500)
    WHERE id=p_run_id;
    RETURN jsonb_build_object('run_id',p_run_id,'status','failed','rpc_error',v_payload->'error');
  END IF;

  SELECT c.source_id INTO v_source_id FROM public.connectors c WHERE c.id=v_run.connector_id;
  v_chain_id:=(v_run.metadata_json->>'chain_id')::bigint;
  v_fetched:=COALESCE(jsonb_array_length(v_payload->'result'),0);

  INSERT INTO public.raw_events(
    source_id,connector_id,ingestion_run_id,event_type,chain_id,event_timestamp,processing_status,payload_json,schema_version,metadata_json
  ) VALUES(
    v_source_id,v_run.connector_id,p_run_id,'solana_promoted_pool_signature_batch',v_chain_id,now(),'processed',v_payload,'1',
    jsonb_build_object(
      'pool_id',(v_run.metadata_json->>'pool_id')::bigint,'pool_address',v_run.metadata_json->>'pool_address',
      'market_id',(v_run.metadata_json->>'market_id')::bigint,'venue_id',(v_run.metadata_json->>'venue_id')::bigint,
      'asset_instance_id',(v_run.metadata_json->>'asset_instance_id')::bigint,'http_status',200,'transport','blitz_worker'
    )
  ) RETURNING id INTO v_raw_id;

  INSERT INTO public.blockchain_transactions(
    chain_id,source_id,ingestion_run_id,raw_event_id,tx_hash,tx_hash_normalized,slot,transaction_index,
    transaction_status,block_time,metadata_json
  )
  SELECT v_chain_id,v_source_id,p_run_id,v_raw_id,x->>'signature',x->>'signature',
         NULLIF(x->>'slot','')::bigint,NULLIF(x->>'transactionIndex','')::int,
         CASE WHEN x->'err' IS NULL OR x->'err'='null'::jsonb THEN 'finalized' ELSE 'failed' END,
         CASE WHEN x->>'blockTime' IS NULL THEN NULL ELSE to_timestamp((x->>'blockTime')::double precision) END,
         jsonb_build_object(
           'confirmation_status',x->>'confirmationStatus','memo',x->'memo','rpc_err',x->'err',
           'monitored_pool',v_run.metadata_json->>'pool_address',
           'monitored_pool_id',(v_run.metadata_json->>'pool_id')::bigint,
           'monitored_market_id',(v_run.metadata_json->>'market_id')::bigint,
           'monitored_venue_id',(v_run.metadata_json->>'venue_id')::bigint,
           'monitored_asset_instance_id',(v_run.metadata_json->>'asset_instance_id')::bigint,
           'onchain_scope','promoted_pumpswap_pool'
         )
  FROM jsonb_array_elements(COALESCE(v_payload->'result','[]'::jsonb)) x
  WHERE NULLIF(x->>'signature','') IS NOT NULL
  ON CONFLICT (chain_id,tx_hash_normalized) DO UPDATE SET
    metadata_json=public.blockchain_transactions.metadata_json||EXCLUDED.metadata_json;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;

  UPDATE public.ingestion_runs SET status='success',finished_at=now(),records_fetched=v_fetched,records_inserted=v_inserted,
    metadata_json=metadata_json||jsonb_build_object('raw_event_id',v_raw_id,'finalized_at',now()) WHERE id=p_run_id;
  UPDATE public.connectors SET status='ready',last_success_at=now(),last_error=NULL,updated_at=now() WHERE id=v_run.connector_id;
  RETURN jsonb_build_object('run_id',p_run_id,'status','success','records_fetched',v_fetched,'transactions_touched',v_inserted,'raw_event_id',v_raw_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.arian_external_claim_promoted_signatures_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_claim_promoted_signatures_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_peek_promoted_signatures_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_peek_promoted_signatures_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_ingest_promoted_signatures_v1(bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_ingest_promoted_signatures_v1(bigint,jsonb,text) TO service_role,postgres;

