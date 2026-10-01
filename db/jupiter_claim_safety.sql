CREATE OR REPLACE FUNCTION public.arian_external_claim_jupiter_token_enrichment_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
 v_connector_id bigint; v_instance_id bigint; v_mint text; v_run_id bigint;
begin
 select id into v_connector_id from public.connectors where connector_key='jupiter_tokens_rest' and is_enabled=true limit 1;
 if v_connector_id is null then raise exception 'Jupiter token connector missing'; end if;

 update public.ingestion_runs set status='failed',finished_at=now(),error_count=1,
  error_message=coalesce(error_message,'stale external Jupiter token enrichment run expired')
 where connector_id=v_connector_id and status='running' and metadata_json->>'transport'='blitz_worker'
   and started_at<now()-interval '15 minutes';

 select ai.id,ai.contract_address into v_instance_id,v_mint
 from public.asset_instances ai
 where ai.contract_address is not null
   and exists(select 1 from public.token_discovery_events tde where tde.asset_instance_id=ai.id)
   and exists(select 1 from public.chains ch where ch.id=ai.chain_id and ch.chain_key='solana')
   and not (ai.metadata_json ? 'jupiter_tokens_v2_at')
   and not exists (
     select 1 from public.ingestion_runs ir
     where ir.connector_id=v_connector_id and ir.status='running'
       and (ir.metadata_json->>'asset_instance_id')::bigint=ai.id
   )
 order by ai.first_seen_at,ai.id limit 1 for update of ai skip locked;

 if v_instance_id is null then return jsonb_build_object('status','idle'); end if;
 insert into public.ingestion_runs(connector_id,run_type,status,metadata_json)
 values(v_connector_id,'scheduled','running',jsonb_build_object(
  'provider','jupiter','dataset','tokens_v2_search','transport','blitz_worker','stage','external_claimed',
  'asset_instance_id',v_instance_id,'mint',v_mint)) returning id into v_run_id;
 return jsonb_build_object('status','claimed','run_id',v_run_id,'asset_instance_id',v_instance_id,'mint',v_mint);
end;$function$;

revoke all on function public.arian_external_claim_jupiter_token_enrichment_v1() from public,anon,authenticated;
grant execute on function public.arian_external_claim_jupiter_token_enrichment_v1() to service_role,postgres;

create or replace function public.arian_external_fail_jupiter_token_enrichment_v1(p_run_id bigint,p_error text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 update public.ingestion_runs set status='failed',finished_at=now(),error_count=1,error_message=left(p_error,500)
 where id=p_run_id and status='running' and metadata_json->>'transport'='blitz_worker'
 and metadata_json->>'dataset'='tokens_v2_search';
 return jsonb_build_object('run_id',p_run_id,'status','failed');
end; $$;
revoke all on function public.arian_external_fail_jupiter_token_enrichment_v1(bigint,text) from public,anon,authenticated;
grant execute on function public.arian_external_fail_jupiter_token_enrichment_v1(bigint,text) to service_role,postgres;
