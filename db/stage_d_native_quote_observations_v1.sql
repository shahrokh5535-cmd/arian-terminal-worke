-- Stage D: staged on-chain native quote observations. NO production replay or USD PnL.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $pre$ BEGIN
 IF to_regclass('arian_private.arian_d_finalized_quote_observations_v1') IS NOT NULL THEN
   RAISE EXCEPTION 'Observation table already exists: manual review required';
 END IF;
 IF to_regclass('arian_private.arian_d_verified_spl_token_account_flows_v1') IS NULL THEN
   RAISE EXCEPTION 'Prior finalized token evidence missing';
 END IF;
END $pre$;
CREATE TABLE arian_private.arian_d_finalized_quote_observations_v1 (
 signature text PRIMARY KEY REFERENCES arian_private.arian_d_verified_spl_token_account_flows_v1(signature),
 slot bigint NOT NULL,
 fee_lamports bigint NOT NULL CHECK(fee_lamports>=0),
 wsol_quote_transfer_lamports bigint CHECK(wsol_quote_transfer_lamports>0),
 owner_native_delta_lamports bigint NOT NULL,
 settlement_status text NOT NULL CHECK(settlement_status IN
 ('BUY_SPEND_OBSERVED','SELL_CREDIT_OBSERVED','SELL_SETTLEMENT_UNKNOWN','ACCOUNT_CLOSE_ONLY')),
 rpc_method text NOT NULL DEFAULT 'getTransaction_jsonParsed_finalized'
   CHECK(rpc_method='getTransaction_jsonParsed_finalized'),
 quote_mint text NOT NULL DEFAULT 'So11111111111111111111111111111111111111112'
   CHECK(quote_mint='So11111111111111111111111111111111111111112'),
 usd_execution_value_verified boolean NOT NULL DEFAULT false CHECK(NOT usd_execution_value_verified),
 realized_pnl_verified boolean NOT NULL DEFAULT false CHECK(NOT realized_pnl_verified),
 observed_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((settlement_status='ACCOUNT_CLOSE_ONLY' AND wsol_quote_transfer_lamports IS NULL)
     OR (settlement_status<>'ACCOUNT_CLOSE_ONLY' AND wsol_quote_transfer_lamports IS NOT NULL)),
 CHECK (settlement_status<>'BUY_SPEND_OBSERVED' OR owner_native_delta_lamports<0),
 CHECK (settlement_status<>'SELL_CREDIT_OBSERVED' OR owner_native_delta_lamports>0)
);
COMMENT ON TABLE arian_private.arian_d_finalized_quote_observations_v1 IS
 'Staged confirmed native WSOL transfer evidence only. NOT USD prices or verified PnL. Owner balance delta includes rent, fees and unrelated transfers.';
ALTER TABLE arian_private.arian_d_finalized_quote_observations_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arian_private.arian_d_finalized_quote_observations_v1 FROM PUBLIC,anon,authenticated;
WITH observations(signature,slot,fee_lamports,quote_lamports,owner_delta,status) AS (VALUES
('a4RqarD3Pp9yu8sws6W37MSnw3XmGEZWhKR7Lww836tgGL6ZHssqgewSd8VnXCdqNcainmLRE2FTzDmFu6xd8uU',453786102,5033,4914078,-6493383,'BUY_SPEND_OBSERVED'),
('3qaLS3miSAe6SBV13v4KDCCse9wUsqv3ebT8zaypDb3JRawLY4on9z5LddiDv5yaRjwkJGQoiB3JuuRmejAHxTmn',454078168,5000,1759057,-1785690,'BUY_SPEND_OBSERVED'),
('4iCUHe7EoDkXSjBThTvWxcfDHnxyz3eEhZsxcQKpq54217bkFEWzy2mria5wHAh3k9S72R91wdaUKcXKdZQHJX8k',454081528,9279,760724,751445,'SELL_CREDIT_OBSERVED'),
('2x4UzPZSTLBySs89gXeHksupnLgDCGqZvBa4GvGXcDUbMhnBDU3rmeNnYVBymWu4cBnGWTq6ZYQ7sSvTUMK3NNqD',454104847,5029,801418,-816303,'BUY_SPEND_OBSERVED'),
('4xHAAMAisUGPj5vv88j2MiVWVLDZ4yVu8vWsT7YwYTdaKwAoxhSM9Q3sP77XyLcmbD19Rfo8qRgEXNAVr6WTXNkZ',454247023,5996,6755207,6742456,'SELL_CREDIT_OBSERVED'),
('2VejEv1ELgwZ6QCVWEnmZQ7Bo1WGPQnndYBqhzRRH2wwJEbdGhLVinypAEXG2PncLQf8mK3RzWJ6RyrccM3ZtjBa',453749534,5000,7706484,-9320095,'BUY_SPEND_OBSERVED'),
('2YpUwaUq1gLEtVE1PPrPModbHDNQcgsF9EuLTETHh2DpS8qMCn9Fn1z4tJM97LbGqg3wfM52TUBNvspbLntoNnJH',453750045,6295,4327220,-4386731,'BUY_SPEND_OBSERVED'),
('3SmCZ3Z4ifkJFiXJVcU9VgV3LLNDvr7WeMWg28c3cLXEZpmoYeDQdBYk3KGSPyzTEkckCTgjeWXFWuUHs78N6SVn',453771540,5001,2232047,-2264497,'BUY_SPEND_OBSERVED'),
('dMqyV45cBaRn1K29A4X3yzgKa7eJmbNuXrsMRTrZLjPuPkBYtPUWcgfNhPmX2tXNLrihd7B71XrXkty5t6Ad7YU',453778095,6560,1446915,-1471269,'BUY_SPEND_OBSERVED'),
('2zUkjemYcDVTaGPHKjmxmQMTJwQrBZVMov3WVLjSChQmcCSGbTKh3kAsYqF9Hsv7pCdZ6PfztbMEmnumBDB4sSdT',454323957,204000,14486770,-5663097,'SELL_SETTLEMENT_UNKNOWN'),
('5bUNzSSAf1PiLE8xco6N5e5rteUXy67ioKy6DtdQ4ZaxvtjsiSQKS7UBp8ogns3jpvavA32fNqLy68XoFNiB8Sz5',454338458,19552,NULL,4480342,'ACCOUNT_CLOSE_ONLY')
)
INSERT INTO arian_private.arian_d_finalized_quote_observations_v1
(signature,slot,fee_lamports,wsol_quote_transfer_lamports,owner_native_delta_lamports,settlement_status)
SELECT o.signature,o.slot,o.fee_lamports,o.quote_lamports,o.owner_delta,o.status
FROM observations o
JOIN arian_private.arian_d_verified_spl_token_account_flows_v1 e
ON e.signature=o.signature AND e.slot=o.slot AND (
 (e.flow_kind='dex_pool_buy' AND o.status='BUY_SPEND_OBSERVED')
 OR (e.flow_kind='dex_pool_sell' AND o.status LIKE 'SELL_%')
 OR (e.flow_kind='account_close_after_zero' AND o.status='ACCOUNT_CLOSE_ONLY')
);
DO $verify$ DECLARE n int; missing int; incomplete int; BEGIN
SELECT count(*) INTO n FROM arian_private.arian_d_finalized_quote_observations_v1;
IF n<>11 THEN RAISE EXCEPTION 'Expected 11 finalized observations, got %',n; END IF;
SELECT count(*) INTO incomplete FROM arian_private.arian_d_finalized_quote_observations_v1
WHERE NOT (rpc_method='getTransaction_jsonParsed_finalized' AND realized_pnl_verified=false);
IF incomplete<>0 THEN RAISE EXCEPTION 'Evidence classification failure'; END IF;
END $verify$;
CREATE VIEW arian_private.arian_d_native_quote_audit_v1 WITH (security_barrier=true) AS
SELECT e.wallet_address_id,e.asset_instance_id,count(*) AS observations,
 count(*) FILTER(WHERE o.wsol_quote_transfer_lamports IS NOT NULL) AS quote_swaps,
 count(*) FILTER(WHERE e.flow_kind='account_close_after_zero') AS closed_accounts,
 count(*) FILTER(WHERE o.settlement_status='SELL_SETTLEMENT_UNKNOWN') AS unsettled_sales,
 sum(o.fee_lamports) AS network_fee_lamports,
 sum(o.wsol_quote_transfer_lamports) FILTER(WHERE e.flow_kind='dex_pool_buy') AS buy_wsol_lamports,
 sum(o.wsol_quote_transfer_lamports) FILTER(WHERE e.flow_kind='dex_pool_sell') AS sell_wsol_lamports,
 CASE WHEN count(*) FILTER(WHERE o.settlement_status='SELL_SETTLEMENT_UNKNOWN')=0
 THEN (sum(o.wsol_quote_transfer_lamports) FILTER(WHERE e.flow_kind='dex_pool_sell')
   -sum(o.wsol_quote_transfer_lamports) FILTER(WHERE e.flow_kind='dex_pool_buy'))
 ELSE NULL END AS quote_difference_lamports_not_pnl,
 false AS realized_pnl_verified,
 'NATIVE_QUOTE_EVIDENCE_ONLY'::text AS status
FROM arian_private.arian_d_verified_spl_token_account_flows_v1 e
JOIN arian_private.arian_d_finalized_quote_observations_v1 o USING(signature)
GROUP BY e.wallet_address_id,e.asset_instance_id;
REVOKE ALL ON arian_private.arian_d_native_quote_audit_v1 FROM PUBLIC,anon,authenticated;
COMMIT;
