-- DB-local selection repair only: profile HTTP remains legacy, jobs 32/33 active.
CREATE OR REPLACE FUNCTION public.arian_enqueue_x_profile_social_asset(p_asset_instance_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_connector_id bigint; v_asset_id bigint; v_chain_id bigint; v_contract text;
  v_handle text; v_profile_url text; v_run_id bigint; v_request_id bigint; v_existing bigint;
BEGIN
  SELECT ai.asset_id,ai.chain_id,ai.contract_address_normalized
    INTO v_asset_id,v_chain_id,v_contract
  FROM public.asset_instances ai WHERE ai.id=p_asset_instance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset_instance % not found',p_asset_instance_id; END IF;

  SELECT c.id INTO v_connector_id FROM public.connectors c
  WHERE c.connector_key='x_public_mirror_fxtwitter' AND c.is_enabled=true LIMIT 1;
  IF v_connector_id IS NULL THEN RAISE EXCEPTION 'X public mirror connector missing'; END IF;

  WITH urls AS (
    SELECT link->>'url' AS url,3 AS priority,tde.discovered_at AS seen_at
    FROM public.token_discovery_events tde
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tde.evidence_json->'profile'->'links','[]'::jsonb)) link
    WHERE tde.asset_instance_id=p_asset_instance_id AND lower(COALESCE(link->>'type',''))='twitter'
    UNION ALL
    SELECT social->>'url',2,tde.discovered_at
    FROM public.token_discovery_events tde
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tde.evidence_json->'pair'->'info'->'socials','[]'::jsonb)) social
    WHERE tde.asset_instance_id=p_asset_instance_id AND lower(COALESCE(social->>'type',''))='twitter'
    UNION ALL
    SELECT social->>'url',1,re.received_at
    FROM public.raw_events re
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(re.payload_json)='array' THEN re.payload_json ELSE jsonb_build_array(re.payload_json) END
    ) pair
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pair->'info'->'socials','[]'::jsonb)) social
    WHERE pair->'baseToken'->>'address'=v_contract
      AND lower(COALESCE(social->>'type',''))='twitter'
  )
  SELECT u.url,substring(u.url from '^https?://(?:x\.com|twitter\.com)/([A-Za-z0-9_]+)/?$')
    INTO v_profile_url,v_handle
  FROM urls u
  WHERE u.url ~* '^https?://(x\.com|twitter\.com)/[A-Za-z0-9_]+/?$'
  ORDER BY u.priority DESC,u.seen_at DESC
  LIMIT 1;

  IF v_handle IS NULL THEN RETURN NULL; END IF;

  -- A failed public account must not monopolize every ten-minute polling slot.
  -- Keep HTTP and all existing profile normalization unchanged until external migration.
  IF EXISTS(
    SELECT 1 FROM public.ingestion_runs ir
    WHERE ir.connector_id=v_connector_id AND ir.status='failed'
      AND ir.metadata_json->>'dataset'='x_profile_timeline'
      AND lower(ir.metadata_json->>'profile_handle')=lower(v_handle)
      AND ir.started_at>=now()-CASE WHEN ir.error_message='HTTP 404'
        THEN interval '6 hours' ELSE interval '15 minutes' END
  ) THEN RETURN NULL; END IF;


  SELECT ir.id INTO v_existing FROM public.ingestion_runs ir
  WHERE ir.connector_id=v_connector_id AND ir.status='running'
    AND ir.metadata_json->>'dataset'='x_profile_timeline'
    AND ir.metadata_json->>'asset_instance_id'=p_asset_instance_id::text
    AND ir.started_at>=now()-interval '15 minutes'
  ORDER BY ir.started_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  INSERT INTO public.ingestion_runs(connector_id,run_type,status,metadata_json)
  VALUES(v_connector_id,'scheduled','running',jsonb_build_object(
    'provider','fxtwitter','upstream_platform','x','dataset','x_profile_timeline',
    'profile_handle',v_handle,'profile_url',v_profile_url,
    'asset_id',v_asset_id,'asset_instance_id',p_asset_instance_id,'chain_id',v_chain_id,
    'trust_tier','third_party_public_mirror','content_policy','own_posts_only','limit',5
  )) RETURNING id INTO v_run_id;

  SELECT net.http_get(
    url := 'https://api.fxtwitter.com/2/profile/'||v_handle||'/statuses',
    params := jsonb_build_object('count','5'),
    headers := jsonb_build_object('Accept','application/json','User-Agent','ArianTerminal/1.0'),
    timeout_milliseconds := 10000
  ) INTO v_request_id;

  UPDATE public.ingestion_runs
     SET metadata_json=metadata_json||jsonb_build_object('http_request_id',v_request_id,'requested_at',now())
   WHERE id=v_run_id;
  RETURN v_run_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.arian_enqueue_x_profile_social_asset(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_enqueue_x_profile_social_asset(bigint) TO service_role,postgres;

