-- Only linked-public-post HTTP moves to Blitz. Jobs 30/31 stay active until verified.
-- Profile jobs 32/33 remain unchanged; public mirror confidence/scoring remains DB-local.
CREATE OR REPLACE FUNCTION public.arian_external_peek_x_public_social_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record;
BEGIN
 SELECT ci.external_content_id tweet_id,ci.content_url tweet_url INTO r
 FROM public.content_items ci JOIN public.connectors c ON c.source_id=ci.source_id
 WHERE c.connector_key='x_public_mirror_fxtwitter' AND c.is_enabled
 AND ci.metadata_json->>'provider'='fxtwitter' AND ci.external_content_id ~ '^[0-9]{1,25}$'
 ORDER BY ci.published_at DESC NULLS LAST,ci.id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
 RETURN jsonb_build_object('status','ready','tweet_id',r.tweet_id,'tweet_url',r.tweet_url);
END; $$;

CREATE OR REPLACE FUNCTION public.arian_external_claim_x_public_social_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_connector_id bigint; v_source_id bigint; v_run_id bigint; v_event_id bigint; v_asset_id bigint;
 v_instance_id bigint; v_chain_id bigint; v_url text; v_tweet_id text; v_legacy record;
BEGIN
 -- During shadow operation, consume an already-returned legacy response before
 -- taking the connector lock. This preserves the finalizer's run->connector lock order.
 -- No HTTP is enqueued here; unresolved legacy requests continue to block claiming.
 SELECT c.id INTO v_connector_id FROM public.connectors c
 WHERE c.connector_key='x_public_mirror_fxtwitter' AND c.is_enabled LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'X mirror connector unavailable'; END IF;
 FOR v_legacy IN
  SELECT ir.id FROM public.ingestion_runs ir
  WHERE ir.connector_id=v_connector_id AND ir.status='running'
   AND ir.metadata_json->>'dataset'='linked_token_social_post'
   AND ir.metadata_json->>'transport' IS DISTINCT FROM 'blitz_worker'
   AND EXISTS(SELECT 1 FROM net._http_response response
     WHERE response.id=(ir.metadata_json->>'http_request_id')::bigint)
  ORDER BY ir.started_at LIMIT 1 FOR UPDATE OF ir SKIP LOCKED
 LOOP
  PERFORM public.arian_finalize_x_public_social_ingestion(v_legacy.id);
 END LOOP;
 SELECT c.id,c.source_id INTO v_connector_id,v_source_id FROM public.connectors c
 WHERE c.connector_key='x_public_mirror_fxtwitter' AND c.is_enabled
 LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X mirror connector unavailable'; END IF;
 UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,
 error_message='External X post claim expired',
 metadata_json=metadata_json||jsonb_build_object('retry_after',now()+interval '10 minutes')
 WHERE connector_id=v_connector_id AND status='running' AND metadata_json->>'transport'='blitz_worker'
 AND metadata_json->>'collector'='x_public_social' AND started_at<now()-interval '10 minutes';
 IF EXISTS(SELECT 1 FROM public.ingestion_runs WHERE connector_id=v_connector_id AND status='running'
 AND metadata_json->>'dataset'='linked_token_social_post') THEN
 RETURN jsonb_build_object('status','idle','reason','pending_linked_post'); END IF;
    WITH candidates AS (
      SELECT tde.id AS event_id,tde.asset_id,tde.asset_instance_id,tde.chain_id,
             link->>'url' AS social_url,tde.discovered_at
      FROM public.token_discovery_events tde
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(tde.evidence_json->'profile'->'links','[]'::jsonb)
      ) link
      WHERE lower(COALESCE(link->>'type',''))='twitter'
        AND COALESCE(tde.metadata_json->>'promotion_hold','false')<>'true'
      UNION ALL
      SELECT tde.id,tde.asset_id,tde.asset_instance_id,tde.chain_id,
             social->>'url',tde.discovered_at
      FROM public.token_discovery_events tde
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(tde.evidence_json->'pair'->'info'->'socials','[]'::jsonb)
      ) social
      WHERE lower(COALESCE(social->>'type',''))='twitter'
        AND COALESCE(tde.metadata_json->>'promotion_hold','false')<>'true'
    ), normalized AS (
      SELECT DISTINCT ON (asset_instance_id)
             event_id,asset_id,asset_instance_id,chain_id,social_url,discovered_at,
             substring(social_url from '/status/([0-9]+)') AS tweet_id
      FROM candidates
      WHERE social_url ~* '^https?://(x[.]com|twitter[.]com)/[A-Za-z0-9_]+/status/[0-9]+([/?#].*)?$'
      ORDER BY asset_instance_id,discovered_at DESC
    )
    SELECT n.event_id,n.asset_id,n.asset_instance_id,n.chain_id,n.social_url,n.tweet_id
      INTO v_event_id,v_asset_id,v_instance_id,v_chain_id,v_url,v_tweet_id
    FROM normalized n
    WHERE n.tweet_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.content_items ci
        WHERE ci.source_id=v_source_id AND ci.external_content_id=n.tweet_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ingestion_runs ir
        WHERE ir.connector_id=v_connector_id
          AND ir.status='running'
          AND ir.metadata_json->>'tweet_id'=n.tweet_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ingestion_runs ir WHERE ir.connector_id=v_connector_id
        AND ir.status='failed' AND ir.metadata_json->>'transport'='blitz_worker'
        AND ir.metadata_json->>'collector'='x_public_social' AND ir.metadata_json->>'tweet_id'=n.tweet_id
        AND nullif(ir.metadata_json->>'retry_after','')::timestamptz>now()
      )
    ORDER BY n.discovered_at DESC,n.event_id DESC
    LIMIT 1;


 IF v_tweet_id IS NULL THEN RETURN jsonb_build_object('status','idle','reason','no_eligible_post'); END IF;
 INSERT INTO public.ingestion_runs(connector_id,run_type,status,metadata_json)
 VALUES(v_connector_id,'scheduled','running',jsonb_build_object(
 'provider','fxtwitter','upstream_platform','x','dataset','linked_token_social_post',
 'collector','x_public_social','transport','blitz_worker','tweet_id',v_tweet_id,'tweet_url',v_url,
 'discovery_event_id',v_event_id,'asset_id',v_asset_id,'asset_instance_id',v_instance_id,
 'chain_id',v_chain_id,'trust_tier','third_party_public_mirror'))
 RETURNING id INTO v_run_id;
 RETURN jsonb_build_object('status','claimed','run_id',v_run_id,'tweet_id',v_tweet_id,'tweet_url',v_url,
 'asset_instance_id',v_instance_id);
END; $$;
CREATE OR REPLACE FUNCTION public.arian_external_ingest_x_public_social_v1(p_run_id bigint, p_payload jsonb, p_error text DEFAULT NULL, p_checked_at timestamptz DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_run public.ingestion_runs%ROWTYPE;
    v_payload jsonb;
    v_tweet jsonb;
    v_author jsonb;
    v_source_id bigint;
    v_raw_id bigint;
    v_influencer_id bigint;
    v_account_id bigint;
    v_content_id bigint;
    v_asset_id bigint;
    v_instance_id bigint;
    v_chain_id bigint;
    v_tweet_id text;
    v_handle text;
    v_author_id text;
    v_followers bigint;
    v_verified boolean;
    v_social_result record;
BEGIN
    SELECT * INTO v_run FROM public.ingestion_runs WHERE id=p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ingestion run % not found',p_run_id; END IF;
    IF v_run.status<>'running' THEN
      RETURN jsonb_build_object('run_id',p_run_id,'status',v_run.status,
        'raw_event_id',v_run.metadata_json->'raw_event_id','content_id',v_run.metadata_json->'content_id');
    END IF;

    IF v_run.metadata_json->>'transport' IS DISTINCT FROM 'blitz_worker'
      OR v_run.metadata_json->>'collector' IS DISTINCT FROM 'x_public_social'
      OR v_run.metadata_json->>'dataset' IS DISTINCT FROM 'linked_token_social_post'
      OR v_run.connector_id IS DISTINCT FROM (SELECT id FROM public.connectors WHERE connector_key='x_public_mirror_fxtwitter' LIMIT 1)
    THEN RAISE EXCEPTION 'Invalid external X post claim'; END IF;
    IF p_error IS NOT NULL THEN
      UPDATE public.ingestion_runs SET status='failed',finished_at=now(),error_count=1,error_message=left(p_error,500),
        metadata_json=metadata_json||jsonb_build_object('retry_after',now()+CASE
          WHEN p_error='HTTP 404' THEN interval '6 hours'
          WHEN p_error='HTTP 429' THEN interval '15 minutes'
          ELSE interval '10 minutes' END)
      WHERE id=p_run_id;
      RETURN jsonb_build_object('run_id',p_run_id,'status','failed');
    END IF;
    IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_payload->'tweet') IS DISTINCT FROM 'object'
      OR p_payload->>'code' IS DISTINCT FROM '200'
      OR p_payload->'tweet'->>'id' IS DISTINCT FROM v_run.metadata_json->>'tweet_id'
      OR jsonb_typeof(p_payload->'tweet'->'text') IS DISTINCT FROM 'string'
      OR length(trim(p_payload->'tweet'->>'text'))=0
    THEN RAISE EXCEPTION 'Invalid X post payload or identity'; END IF;
    v_payload:=p_payload;
    v_tweet:=v_payload->'tweet';
    IF COALESCE(v_payload->>'code','')<>'200' OR v_tweet IS NULL OR v_tweet='null'::jsonb THEN
      UPDATE public.ingestion_runs
         SET status='failed',finished_at=now(),error_count=1,
             error_message='FxTwitter response missing tweet payload'
       WHERE id=p_run_id;
      RETURN jsonb_build_object('run_id',p_run_id,'status','failed','reason','missing_tweet');
    END IF;

    v_author:=v_tweet->'author';
    v_tweet_id:=COALESCE(v_tweet->>'id',v_run.metadata_json->>'tweet_id');
    v_handle:=NULLIF(v_author->>'screen_name','');
    v_author_id:=NULLIF(v_author->>'id','');
    v_followers:=NULLIF(v_author->>'followers','')::bigint;
    v_verified:=COALESCE((v_author->'verification'->>'verified')::boolean,false);
    v_asset_id:=(v_run.metadata_json->>'asset_id')::bigint;
    v_instance_id:=(v_run.metadata_json->>'asset_instance_id')::bigint;
    v_chain_id:=(v_run.metadata_json->>'chain_id')::bigint;

    SELECT c.source_id INTO v_source_id
    FROM public.connectors c WHERE c.id=v_run.connector_id;

    INSERT INTO public.raw_events(
      source_id,connector_id,ingestion_run_id,event_type,chain_id,event_timestamp,
      processing_status,payload_json,schema_version,metadata_json
    ) VALUES(
      v_source_id,v_run.connector_id,p_run_id,'x_public_mirror_post',v_chain_id,
      CASE WHEN v_tweet->>'created_timestamp' IS NULL THEN now()
           ELSE to_timestamp((v_tweet->>'created_timestamp')::double precision) END,
      'processed',v_payload,'1',
      jsonb_build_object(
        'upstream_platform','x','provider','fxtwitter',
        'trust_tier','third_party_public_mirror',
        'tweet_id',v_tweet_id,'asset_instance_id',v_instance_id,
        'transport','blitz_worker','collector','x_public_social','checked_at',p_checked_at
      )
    ) RETURNING id INTO v_raw_id;

    IF v_handle IS NOT NULL THEN
      INSERT INTO public.influencers(username,platform,followers,credibility_score,total_calls,successful_calls)
      VALUES('x:'||v_handle,'x',LEAST(COALESCE(v_followers,0),2147483647)::integer,NULL,0,0)
      ON CONFLICT (username) DO UPDATE
        SET platform='x',followers=EXCLUDED.followers
      RETURNING id INTO v_influencer_id;

      IF v_influencer_id IS NULL THEN
        SELECT id INTO v_influencer_id FROM public.influencers WHERE username='x:'||v_handle;
      END IF;

      INSERT INTO public.influencer_accounts(
        influencer_id,source_id,external_account_id,account_handle,display_name,account_url,
        followers_count,is_verified,is_active,first_seen_at,last_seen_at,metadata_json
      ) VALUES(
        v_influencer_id,v_source_id,v_author_id,v_handle,v_author->>'name',v_author->>'url',
        v_followers,v_verified,true,now(),now(),
        jsonb_build_object('provider','fxtwitter','trust_tier','third_party_public_mirror')
      )
      ON CONFLICT (source_id,external_account_id) WHERE external_account_id IS NOT NULL
      DO UPDATE SET
        account_handle=EXCLUDED.account_handle,display_name=EXCLUDED.display_name,
        account_url=EXCLUDED.account_url,followers_count=EXCLUDED.followers_count,
        is_verified=EXCLUDED.is_verified,is_active=true,last_seen_at=now(),updated_at=now(),
        metadata_json=public.influencer_accounts.metadata_json||EXCLUDED.metadata_json
      RETURNING id INTO v_account_id;

      IF v_account_id IS NULL THEN
        SELECT id INTO v_account_id FROM public.influencer_accounts
        WHERE source_id=v_source_id AND external_account_id=v_author_id LIMIT 1;
      END IF;
    END IF;

    INSERT INTO public.content_items(
      source_id,raw_event_id,influencer_account_id,external_content_id,content_hash,
      content_type,content_url,author_handle,title,content_text,language_code,published_at,
      views_count,likes_count,comments_count,shares_count,metadata_json
    ) VALUES(
      v_source_id,v_raw_id,v_account_id,v_tweet_id,md5(COALESCE(v_tweet->>'text','')),
      'post',v_tweet->>'url',v_handle,NULL,v_tweet->>'text',v_tweet->>'lang',
      CASE WHEN v_tweet->>'created_timestamp' IS NULL THEN NULL
           ELSE to_timestamp((v_tweet->>'created_timestamp')::double precision) END,
      COALESCE(NULLIF(v_tweet->>'views','')::bigint,0),
      COALESCE(NULLIF(v_tweet->>'likes','')::bigint,0),
      COALESCE(NULLIF(v_tweet->>'replies','')::bigint,0),
      COALESCE(NULLIF(v_tweet->>'retweets','')::bigint,0)+COALESCE(NULLIF(v_tweet->>'quotes','')::bigint,0),
      jsonb_build_object(
        'provider','fxtwitter','upstream_platform','x',
        'trust_tier','third_party_public_mirror','source_confidence_cap',70,
        'author_followers',v_followers,'author_verified',v_verified,
        'bookmarks',COALESCE(NULLIF(v_tweet->>'bookmarks','')::bigint,0)
      )
    )
    ON CONFLICT (source_id,external_content_id) WHERE external_content_id IS NOT NULL
    DO UPDATE SET
      raw_event_id=EXCLUDED.raw_event_id,influencer_account_id=EXCLUDED.influencer_account_id,
      content_url=EXCLUDED.content_url,author_handle=EXCLUDED.author_handle,
      content_text=EXCLUDED.content_text,language_code=EXCLUDED.language_code,
      published_at=EXCLUDED.published_at,views_count=EXCLUDED.views_count,
      likes_count=EXCLUDED.likes_count,comments_count=EXCLUDED.comments_count,
      shares_count=EXCLUDED.shares_count,metadata_json=EXCLUDED.metadata_json,updated_at=now()
    RETURNING id INTO v_content_id;

    INSERT INTO public.content_mentions(
      content_id,asset_id,asset_instance_id,chain_id,raw_mention_text,normalized_mention,
      mention_type,sentiment_score,sentiment_label,relevance_score,confidence_score,
      mention_count,extraction_method,evidence_json,metadata_json
    )
    SELECT v_content_id,v_asset_id,v_instance_id,v_chain_id,a.symbol,a.symbol,
           'implicit',NULL,'unknown',95,70,1,
           'dexscreener_linked_x_post_fxtwitter_v1',
           jsonb_build_object(
             'tweet_url',v_tweet->>'url','tweet_id',v_tweet_id,
             'link_provenance','token_discovery_profile_or_pair_social',
             'provider','fxtwitter','upstream_platform','x'
           ),
           jsonb_build_object('trust_tier','third_party_public_mirror','confidence_cap',70)
    FROM public.assets a WHERE a.id=v_asset_id
    ON CONFLICT (content_id,asset_instance_id) WHERE asset_instance_id IS NOT NULL
    DO UPDATE SET
      relevance_score=EXCLUDED.relevance_score,
      confidence_score=EXCLUDED.confidence_score,
      evidence_json=EXCLUDED.evidence_json,
      metadata_json=EXCLUDED.metadata_json,
      detected_at=now();

    SELECT * INTO v_social_result
    FROM public.update_asset_social_intelligence_v2(v_asset_id,v_instance_id,'x_public_mirror_ingestion');

    UPDATE public.asset_social_scores_v2 s
       SET metadata_json=COALESCE(s.metadata_json,'{}'::jsonb)||jsonb_build_object(
         'source_policy','x_linked_public_mirror_v1',
         'provider','fxtwitter','upstream_platform','x',
         'trust_tier','third_party_public_mirror',
         'confidence_threshold_for_fusion',50,
         'last_source_content_id',v_content_id,
         'last_source_raw_event_id',v_raw_id
       ),updated_at=now()
     WHERE s.asset_instance_id=v_instance_id;

    UPDATE public.ingestion_runs
       SET status='success',finished_at=now(),records_fetched=1,records_inserted=1,
           metadata_json=metadata_json||jsonb_build_object(
             'raw_event_id',v_raw_id,'content_id',v_content_id,
             'social_score',v_social_result.final_social_score,
             'social_confidence',v_social_result.social_confidence,
             'finalized_at',now()
           )
     WHERE id=p_run_id;

    UPDATE public.connectors
       SET status='ready',last_success_at=now(),last_error=NULL,updated_at=now()
     WHERE id=v_run.connector_id;

    RETURN jsonb_build_object(
      'run_id',p_run_id,'status','success','raw_event_id',v_raw_id,
      'content_id',v_content_id,'asset_instance_id',v_instance_id,
      'social_score',v_social_result.final_social_score,
      'social_confidence',v_social_result.social_confidence
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.arian_external_peek_x_public_social_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_peek_x_public_social_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_claim_x_public_social_v1() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_claim_x_public_social_v1() TO service_role,postgres;
REVOKE ALL ON FUNCTION public.arian_external_ingest_x_public_social_v1(bigint,jsonb,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_ingest_x_public_social_v1(bigint,jsonb,text,timestamptz) TO service_role,postgres;
