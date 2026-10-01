-- Reserve one existing claim slot for recent canonical data, preserving a backlog/promoted slot.
CREATE OR REPLACE FUNCTION public.arian_external_claim_solana_transaction_details_v1(p_limit integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare r record; v_idx integer; v_connector bigint; v_run bigint; v_claims jsonb := '[]';
begin
 if p_limit is null or p_limit < 1 or p_limit > 5 then raise exception 'limit must be 1..5'; end if;
 select id into v_connector from public.connectors where connector_key='solana_rpc_main' and is_enabled;
 if v_connector is null then raise exception 'Solana connector missing'; end if;
 for v_idx in 1..p_limit loop
  select bt.* into r from public.blockchain_transactions bt join public.chains ch on ch.id=bt.chain_id
  where ch.chain_key='solana' and bt.transaction_status='finalized'
   and not (bt.metadata_json ? 'detail_request_id')
   and (
    (coalesce(bt.metadata_json->>'detail_status','pending') in ('pending','failed','rate_limited')
     and coalesce((bt.metadata_json->>'detail_attempts')::int,0)<3
     and coalesce(nullif(bt.metadata_json->>'detail_retry_after','')::timestamptz,'-infinity')<=now())
    or (bt.metadata_json->>'detail_status'='external_fetching'
        and (bt.metadata_json->>'detail_claim_expires_at')::timestamptz<=now())
   )
  order by
   ((coalesce(bt.metadata_json->>'onchain_scope','')='promoted_pumpswap_pool')=(v_idx%2=0)) desc,
   (v_idx%2=1 and coalesce(bt.metadata_json->>'onchain_scope','')<>'promoted_pumpswap_pool'
    and coalesce(bt.block_time,'-infinity')>=now()-interval '10 minutes') desc,
   case when bt.metadata_json->>'onchain_scope'='promoted_pumpswap_pool'
     or (v_idx%2=1 and bt.block_time>=now()-interval '10 minutes') then bt.block_time end desc nulls last,
   bt.block_time asc nulls last,bt.id
  limit 1 for update of bt skip locked;
  if not found then exit; end if;
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
    'max_supported_transaction_version',1,'detail_queue_policy','balanced_freshness_and_backlog')
   where id=r.id;
  v_claims:=v_claims||jsonb_build_array(jsonb_build_object('transaction_id',r.id,'tx_hash',r.tx_hash,'run_id',v_run));
 end loop;
 return jsonb_build_object('status',case when jsonb_array_length(v_claims)=0 then 'idle' else 'claimed' end,'claims',v_claims);
end; $function$;
REVOKE ALL ON FUNCTION public.arian_external_claim_solana_transaction_details_v1(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.arian_external_claim_solana_transaction_details_v1(integer) TO service_role,postgres;

