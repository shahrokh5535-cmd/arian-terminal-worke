-- Additive preparation only. Job 6 stays on its legacy command until verified cutover.
create or replace function public.arian_external_claim_solana_transaction_details_v1(p_limit integer default 2)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare r record; v_connector bigint; v_run bigint; v_claims jsonb := '[]';
begin
 if p_limit is null or p_limit < 1 or p_limit > 5 then raise exception 'limit must be 1..5'; end if;
 select id into v_connector from public.connectors where connector_key='solana_rpc_main' and is_enabled;
 if v_connector is null then raise exception 'Solana connector missing'; end if;
 for r in
  select bt.* from public.blockchain_transactions bt join public.chains ch on ch.id=bt.chain_id
  where ch.chain_key='solana' and bt.transaction_status='finalized'
   and not (bt.metadata_json ? 'detail_request_id')
   and (
    (coalesce(bt.metadata_json->>'detail_status','pending') in ('pending','failed','rate_limited')
     and coalesce((bt.metadata_json->>'detail_attempts')::int,0)<3
     and coalesce(nullif(bt.metadata_json->>'detail_retry_after','')::timestamptz,'-infinity')<=now())
    or (bt.metadata_json->>'detail_status'='external_fetching'
        and (bt.metadata_json->>'detail_claim_expires_at')::timestamptz<=now())
   )
  order by (coalesce(bt.metadata_json->>'onchain_scope','')='promoted_pumpswap_pool') desc,
   case when bt.metadata_json->>'onchain_scope'='promoted_pumpswap_pool' then bt.block_time end desc nulls last,
   bt.block_time asc nulls last,bt.id
  limit p_limit for update of bt skip locked
 loop
  if r.metadata_json->>'detail_status'='external_fetching' then
   update public.ingestion_runs set status='failed',finished_at=now(),error_count=1,error_message='external detail lease expired'
    where id=(r.metadata_json->>'detail_claim_run_id')::bigint and status='running';
  end if;
  insert into public.ingestion_runs(connector_id,run_type,status,metadata_json)
   values(v_connector,'scheduled','running',jsonb_build_object('provider','solana_rpc','transport','blitz_worker',
    'dataset','solana_transaction_detail','transaction_id',r.id)) returning id into v_run;
  update public.blockchain_transactions set updated_at=now(),
   metadata_json=(metadata_json-'detail_retry_after')||jsonb_build_object('detail_status','external_fetching',
    'detail_claim_run_id',v_run,'detail_claim_expires_at',now()+interval '2 minutes',
    'detail_requested_at',now(),'detail_attempts',coalesce((metadata_json->>'detail_attempts')::int,0)+1,
    'max_supported_transaction_version',1)
   where id=r.id;
  v_claims:=v_claims||jsonb_build_array(jsonb_build_object('transaction_id',r.id,'tx_hash',r.tx_hash,'run_id',v_run));
 end loop;
 return jsonb_build_object('status',case when jsonb_array_length(v_claims)=0 then 'idle' else 'claimed' end,'claims',v_claims);
end; $$;

create or replace function public.arian_external_ingest_solana_transaction_detail_v1(
 p_transaction_id bigint,p_run_id bigint,p_payload jsonb,p_error text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare r public.blockchain_transactions%rowtype; v_run public.ingestion_runs%rowtype;
 v_result jsonb; v_raw bigint; v_signers int; v_payer text; v_error text; v_rate boolean;
begin
 select * into r from public.blockchain_transactions where id=p_transaction_id for update;
 if not found then raise exception 'transaction missing'; end if;
 select * into v_run from public.ingestion_runs where id=p_run_id for update;
 if not found or v_run.metadata_json->>'transport' is distinct from 'blitz_worker'
  or v_run.metadata_json->>'dataset' is distinct from 'solana_transaction_detail'
  or (v_run.metadata_json->>'transaction_id')::bigint is distinct from p_transaction_id
  then raise exception 'invalid detail claim'; end if;
 if v_run.status<>'running' then return jsonb_build_object('status',v_run.status,'run_id',p_run_id,'already_completed',true); end if;
 if r.metadata_json->>'detail_status' is distinct from 'external_fetching'
  or (r.metadata_json->>'detail_claim_run_id')::bigint is distinct from p_run_id then
  raise exception 'stale detail claim';
 end if;
 v_result:=p_payload->'result';
 v_rate:=coalesce(p_payload->'error'->>'code'='429',false) or p_error='HTTP 429';
 v_error:=case when p_error is not null then left(p_error,500)
  when p_payload ? 'error' then 'Solana RPC error '||coalesce(p_payload->'error'->>'code','unknown')
  when v_result is null or v_result='null'::jsonb then 'RPC result is null'
  when jsonb_typeof(v_result)<>'object' or jsonb_typeof(v_result->'transaction'->'message'->'accountKeys') is distinct from 'array'
   or jsonb_typeof(v_result->'meta') is distinct from 'object' then 'Invalid transaction payload' end;
 if v_error is not null then
  update public.blockchain_transactions set updated_at=now(),
   metadata_json=((metadata_json-'detail_claim_expires_at')-'detail_claim_run_id')||jsonb_build_object(
    'detail_status',case when v_rate then 'rate_limited' else 'failed' end,'detail_error',v_error,
    'detail_failed_at',now(),'detail_retry_after',now()+interval '5 minutes',
    'detail_attempts',case when v_rate then greatest(coalesce((metadata_json->>'detail_attempts')::int,1)-1,0)
     else coalesce((metadata_json->>'detail_attempts')::int,1) end)
   where id=r.id;
  update public.ingestion_runs set status='failed',finished_at=now(),error_count=1,error_message=v_error where id=p_run_id;
  return jsonb_build_object('status','failed','run_id',p_run_id,'error',v_error);
 end if;
 v_payer:=coalesce(v_result->'transaction'->'message'->'accountKeys'->0->>'pubkey',v_result->'transaction'->'message'->'accountKeys'->>0);
 select count(*)::int into v_signers from jsonb_array_elements(v_result->'transaction'->'message'->'accountKeys') k
  where coalesce((k->>'signer')::boolean,false);
 insert into public.raw_events(source_id,connector_id,ingestion_run_id,event_type,chain_id,event_timestamp,
  processing_status,payload_json,schema_version,metadata_json)
 values(r.source_id,v_run.connector_id,p_run_id,'solana_transaction_detail',r.chain_id,
  coalesce(to_timestamp((v_result->>'blockTime')::double precision),r.block_time),'processed',v_result,'1',
  jsonb_build_object('transaction_id',r.id,'tx_hash',r.tx_hash,'transport','blitz_worker')) returning id into v_raw;
 update public.blockchain_transactions set slot=coalesce((v_result->>'slot')::bigint,slot),
  block_time=coalesce(to_timestamp((v_result->>'blockTime')::double precision),block_time),
  fee_native_raw=coalesce((v_result->'meta'->>'fee')::numeric,fee_native_raw),signer_count=v_signers,
  transaction_status=case when v_result->'meta'->'err' is null or v_result->'meta'->'err'='null'::jsonb then 'finalized' else 'failed' end,
  updated_at=now(),metadata_json=(((metadata_json-'detail_claim_expires_at')-'detail_claim_run_id')-'detail_error')||
   jsonb_build_object('detail_status','processed','detail_raw_event_id',v_raw,'detail_processed_at',now(),
    'fee_payer',v_payer,'compute_units_consumed',v_result->'meta'->'computeUnitsConsumed',
    'detail_rpc_slot',v_result->'slot','detail_transport','blitz_worker') where id=r.id;
 update public.ingestion_runs set status='success',finished_at=now(),records_fetched=1,records_inserted=1,
  records_updated=1,error_count=0,metadata_json=metadata_json||jsonb_build_object('raw_event_id',v_raw) where id=p_run_id;
 return jsonb_build_object('status','success','run_id',p_run_id,'raw_event_id',v_raw,'transaction_id',r.id);
end; $$;

create or replace function public.arian_run_solana_local_processing_v1()
returns jsonb language plpgsql set search_path = pg_catalog as $$
declare r record; v_legacy jsonb; v_swaps jsonb;
begin
 for r in select ir.id from public.ingestion_runs ir join public.connectors c on c.id=ir.connector_id
  where c.connector_key='solana_rpc_main' and ir.status='running'
   and ir.metadata_json->>'transport' is distinct from 'blitz_worker' order by ir.started_at limit 10
 loop perform public.arian_finalize_solana_pool_signatures(r.id); end loop;
 v_legacy:=public.arian_finalize_solana_transaction_details(20);
 v_swaps:=public.arian_detect_raydium_sol_usdc_swaps(50);
 return jsonb_build_object('legacy_details',v_legacy,'raydium_swaps',v_swaps,'ran_at',now());
end; $$;

revoke all on function public.arian_external_claim_solana_transaction_details_v1(integer) from public,anon,authenticated;
revoke all on function public.arian_external_ingest_solana_transaction_detail_v1(bigint,bigint,jsonb,text) from public,anon,authenticated;
revoke all on function public.arian_run_solana_local_processing_v1() from public,anon,authenticated;
grant execute on function public.arian_external_claim_solana_transaction_details_v1(integer) to service_role,postgres;
grant execute on function public.arian_external_ingest_solana_transaction_detail_v1(bigint,bigint,jsonb,text) to service_role,postgres;
grant execute on function public.arian_run_solana_local_processing_v1() to service_role,postgres;
