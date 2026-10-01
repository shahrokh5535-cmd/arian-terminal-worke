-- External HTTP preparation for legacy job 18. Keep job 18/10 until real Blitz verification.
CREATE OR REPLACE FUNCTION public.arian_external_peek_discovered_risk_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_connector bigint; r record;
BEGIN
 SELECT id INTO v_connector FROM public.connectors WHERE connector_key='rugcheck_rest' AND is_enabled LIMIT 1;
 IF v_connector IS NULL THEN RAISE EXCEPTION 'RugCheck connector unavailable'; END IF;
 SELECT ai.id,ai.contract_address mint INTO r 
 from public.asset_instances ai join public.chains ch on ch.id=ai.chain_id
 where ch.chain_key='solana' and ch.is_active and ai.contract_address is not null
  and exists(select 1 from public.token_discovery_events tde where tde.asset_instance_id=ai.id)
  and not exists(select 1 from public.asset_risk_current arc where arc.asset_instance_id=ai.id and arc.assessed_at>=now()-interval '24 hours')
  and not exists(select 1 from public.ingestion_runs ir where ir.connector_id=v_connector and ir.status='running'
   and ir.metadata_json->>'asset_instance_id'=ai.id::text)
  and not exists(select 1 from public.ingestion_runs ir where ir.connector_id=v_connector and ir.status='failed'
   and ir.metadata_json->>'transport'='blitz_worker' and ir.metadata_json->>'collector'='discovered_risk'
   and ir.metadata_json->>'asset_instance_id'=ai.id::text
   and nullif(ir.metadata_json->>'retry_after','')::timestamptz>now())
 order by ai.id
 LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
 RETURN jsonb_build_object('status','ready','asset_instance_id',r.id,'mint',r.mint);
END; $$;

CREATE OR REPLACE FUNCTION public.arian_external_claim_discovered_risk_v1(p_limit integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_connector bigint; r record; v_run bigint; v_claims jsonb:='[]';
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>2 THEN RAISE EXCEPTION 'limit must be 1..2'; END IF;
 SELECT id INTO v_connector FROM public.connectors WHERE connector_key='rugcheck_rest' AND is_enabled LIMIT 1;
 IF v_connector IS NULL THEN RAISE EXCEPTION 'RugCheck connector unavailable'; END IF;
 UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,
  error_message='External discovered-risk claim expired',
  metadata_json=metadata_json||jsonb_build_object('retry_after',now()+interval '10 minutes')
 WHERE connector_id=v_connector AND status='running' AND metadata_json->>'transport'='blitz_worker'
  AND metadata_json->>'collector'='discovered_risk' AND started_at<now()-interval '15 minutes';
 FOR r IN SELECT ai.id,ai.chain_id,ai.contract_address mint 
 from public.asset_instances ai join public.chains ch on ch.id=ai.chain_id
 where ch.chain_key='solana' and ch.is_active and ai.contract_address is not null
  and exists(select 1 from public.token_discovery_events tde where tde.asset_instance_id=ai.id)
  and not exists(select 1 from public.asset_risk_current arc where arc.asset_instance_id=ai.id and arc.assessed_at>=now()-interval '24 hours')
  and not exists(select 1 from public.ingestion_runs ir where ir.connector_id=v_connector and ir.status='running'
   and ir.metadata_json->>'asset_instance_id'=ai.id::text)
  and not exists(select 1 from public.ingestion_runs ir where ir.connector_id=v_connector and ir.status='failed'
   and ir.metadata_json->>'transport'='blitz_worker' and ir.metadata_json->>'collector'='discovered_risk'
   and ir.metadata_json->>'asset_instance_id'=ai.id::text
   and nullif(ir.metadata_json->>'retry_after','')::timestamptz>now())
 order by ai.id
 LIMIT p_limit FOR UPDATE OF ai SKIP LOCKED LOOP
  INSERT INTO public.ingestion_runs(connector_id,run_type,status,metadata_json)
  VALUES(v_connector,'scheduled','running',jsonb_build_object('provider','rugcheck','dataset','token_report_summary',
   'collector','discovered_risk','transport','blitz_worker','asset_instance_id',r.id,'chain_id',r.chain_id,
   'mint',r.mint,'stage','external_claimed')) RETURNING id INTO v_run;
  v_claims:=v_claims||jsonb_build_array(jsonb_build_object('run_id',v_run,'asset_instance_id',r.id,'mint',r.mint));
 END LOOP;
 RETURN jsonb_build_object('status',case when jsonb_array_length(v_claims)=0 then 'idle' else 'claimed' end,'claims',v_claims);
END; $$;
CREATE OR REPLACE FUNCTION public.arian_external_ingest_discovered_risk_v1(p_run_id bigint,p_payload jsonb,p_error text DEFAULT NULL,p_checked_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_run public.ingestion_runs%ROWTYPE;
    v_response record;
    v_payload jsonb;
    v_source_id bigint;
    v_asset_instance_id bigint;
    v_asset_id bigint;
    v_chain_id bigint;
    v_raw_event_id bigint;
    v_assessment_id bigint;
    v_risk_score numeric;
    v_safety_score numeric;
BEGIN
    SELECT * INTO v_run FROM public.ingestion_runs WHERE id=p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ingestion run % not found',p_run_id; END IF;
    IF v_run.status<>'running' THEN
        RETURN jsonb_build_object('run_id',p_run_id,'status',v_run.status);
    END IF;


    IF v_run.metadata_json->>'transport' IS DISTINCT FROM 'blitz_worker'
     OR v_run.metadata_json->>'collector' IS DISTINCT FROM 'discovered_risk'
     OR v_run.metadata_json->>'dataset' IS DISTINCT FROM 'token_report_summary'
     OR v_run.connector_id IS DISTINCT FROM (SELECT id FROM public.connectors WHERE connector_key='rugcheck_rest' LIMIT 1)
     THEN RAISE EXCEPTION 'Invalid discovered-risk claim'; END IF;
    IF p_error IS NOT NULL THEN
     UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=left(p_error,500),
      metadata_json=metadata_json||jsonb_build_object('retry_after',now()+CASE
       WHEN p_error='HTTP 404' THEN interval '6 hours'
       WHEN p_error='HTTP 429' THEN interval '10 minutes'
       ELSE interval '15 minutes' END)
     WHERE id=p_run_id;
     RETURN jsonb_build_object('run_id',p_run_id,'status','failed');
    END IF;
    IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RugCheck payload must be an object'; END IF;
    v_payload:=p_payload;
    v_asset_instance_id:=(v_run.metadata_json->>'asset_instance_id')::bigint;

    SELECT ai.asset_id,ai.chain_id INTO v_asset_id,v_chain_id
    FROM public.asset_instances ai
    WHERE ai.id=v_asset_instance_id AND ai.contract_address IS NOT DISTINCT FROM v_run.metadata_json->>'mint'
     AND EXISTS(SELECT 1 FROM public.chains ch WHERE ch.id=ai.chain_id AND ch.chain_key='solana' AND ch.is_active);
    IF v_asset_id IS NULL THEN RAISE EXCEPTION 'Claimed Solana asset identity missing'; END IF;

    SELECT c.source_id INTO v_source_id
    FROM public.connectors c WHERE c.id=v_run.connector_id;

    v_risk_score:=NULLIF(v_payload->>'score_normalised','')::numeric;
    IF v_risk_score IS NULL OR v_risk_score<0 OR v_risk_score>100 THEN
        UPDATE public.ingestion_runs
           SET status='failed',finished_at=now(),error_count=1,
               error_message='Invalid RugCheck score_normalised',metadata_json=metadata_json||jsonb_build_object('retry_after',now()+interval '15 minutes')
         WHERE id=p_run_id;
        RETURN jsonb_build_object('run_id',p_run_id,'status','failed','reason','invalid_score');
    END IF;

    v_safety_score:=ROUND(100-v_risk_score,2);

    INSERT INTO public.raw_events(
        source_id,connector_id,ingestion_run_id,event_type,chain_id,asset_id,asset_instance_id,
        event_timestamp,processing_status,payload_json,schema_version,metadata_json
    ) VALUES (
        v_source_id,v_run.connector_id,p_run_id,'rugcheck_risk_summary',v_chain_id,v_asset_id,v_asset_instance_id,
        p_checked_at,'validated',v_payload,'1',jsonb_build_object('http_status',200,'risk_score',v_risk_score,'transport','blitz_worker','collector','discovered_risk')
    ) RETURNING id INTO v_raw_event_id;

    SELECT r.assessment_id INTO v_assessment_id
    FROM public.record_asset_risk_assessment_v1(
        p_asset_id=>v_asset_id,
        p_safety_score=>v_safety_score,
        p_asset_instance_id=>v_asset_instance_id,
        p_chain_id=>v_chain_id,
        p_source_id=>v_source_id,
        p_risk_probability=>v_risk_score,
        p_risk_level=>NULL,
        p_risk_flags=>COALESCE(v_payload->'risks','[]'::jsonb),
        p_components_json=>jsonb_build_object(
            'tokenProgram',v_payload->'tokenProgram',
            'tokenType',v_payload->'tokenType',
            'lpLockedPct',v_payload->'lpLockedPct',
            'rugcheck_score_normalised',v_risk_score
        ),
        p_evidence_json=>jsonb_build_object(
            'raw_event_id',v_raw_event_id,
            'provider','rugcheck',
            'summary',v_payload
        ),
        p_assessment_version=>'rugcheck-summary-v1',
        p_assessment_method=>'rugcheck_api',
        p_assessed_at=>p_checked_at,
        p_expires_at=>p_checked_at+interval '24 hours'
    ) r;

    UPDATE public.raw_events
       SET processing_status='processed',
           metadata_json=metadata_json||jsonb_build_object('risk_assessment_id',v_assessment_id,'safety_score',v_safety_score)
     WHERE id=v_raw_event_id;

    UPDATE public.intelligence_scores i
       SET risk_score=v_safety_score,
           analysis_json=COALESCE(i.analysis_json,'{}'::jsonb)||jsonb_build_object(
               'risk_status','production_live',
               'risk_source','rugcheck',
               'risk_assessment_id',v_assessment_id,
               'rugcheck_risk_score',v_risk_score,
               'risk_safety_score',v_safety_score,
               'risk_calculated_at',p_checked_at
           )
     WHERE i.id=(
         SELECT x.id FROM public.intelligence_scores x
         JOIN public.asset_instances ai ON ai.id=v_asset_instance_id
         WHERE lower(x.token_ca)=lower(ai.contract_address)
         ORDER BY x.created_at DESC LIMIT 1
     );

    UPDATE public.ingestion_runs
       SET status='success',finished_at=now(),records_fetched=1,records_inserted=1,
           metadata_json=metadata_json||jsonb_build_object(
               'http_status',200,
               'raw_event_id',v_raw_event_id,
               'risk_assessment_id',v_assessment_id,
               'safety_score',v_safety_score,
               'finalized_at',now()
           )
     WHERE id=p_run_id;

    UPDATE public.connectors
       SET status='ready',last_success_at=now(),last_error=NULL,updated_at=now()
     WHERE id=v_run.connector_id;

    RETURN jsonb_build_object(
        'run_id',p_run_id,'status','success','raw_event_id',v_raw_event_id,
        'assessment_id',v_assessment_id,'risk_score',v_risk_score,'safety_score',v_safety_score
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.arian_external_peek_discovered_risk_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_peek_discovered_risk_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_claim_discovered_risk_v1(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_claim_discovered_risk_v1(integer) TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_ingest_discovered_risk_v1(bigint,jsonb,text,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_ingest_discovered_risk_v1(bigint,jsonb,text,timestamp with time zone) TO service_role,postgres;

