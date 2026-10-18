-- Stage D separate proof of temporary WSOL account close for one finalized sale.
-- Evidence only: fee/native debits are not presumed unrelated or trade PnL.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
CREATE TABLE arian_private.arian_d_sale_settlement_traces_v1 (
 signature text PRIMARY KEY REFERENCES arian_private.arian_d_finalized_quote_observations_v1(signature),
 temporary_wsol_account text NOT NULL,
 wsol_transfer_into_temp_lamports bigint NOT NULL CHECK(wsol_transfer_into_temp_lamports>0),
 close_destination_wallet text NOT NULL,
 close_owner_wallet text NOT NULL,
 other_wallet_native_out_lamports bigint NOT NULL CHECK(other_wallet_native_out_lamports>=0),
 network_fee_lamports bigint NOT NULL CHECK(network_fee_lamports>=0),
 wallet_native_net_lamports bigint NOT NULL,
 status text NOT NULL DEFAULT 'WSOL_UNWRAP_WITH_ADDITIONAL_DEBITS' CHECK(status='WSOL_UNWRAP_WITH_ADDITIONAL_DEBITS'),
 usd_pnl_verified boolean NOT NULL DEFAULT false CHECK(NOT usd_pnl_verified),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK(wallet_native_net_lamports =
 wsol_transfer_into_temp_lamports-other_wallet_native_out_lamports-network_fee_lamports)
);
ALTER TABLE arian_private.arian_d_sale_settlement_traces_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arian_private.arian_d_sale_settlement_traces_v1 FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE arian_private.arian_d_sale_settlement_traces_v1 IS
'Observed finalized transfer to temp WSOL token account then parsed closeAccount to signer. Other debits remain unclassified; NOT USD PnL.';
INSERT INTO arian_private.arian_d_sale_settlement_traces_v1
(signature,temporary_wsol_account,wsol_transfer_into_temp_lamports,close_destination_wallet,close_owner_wallet,
 other_wallet_native_out_lamports,network_fee_lamports,wallet_native_net_lamports)
SELECT '2zUkjemYcDVTaGPHKjmxmQMTJwQrBZVMov3WVLjSChQmcCSGbTKh3kAsYqF9Hsv7pCdZ6PfztbMEmnumBDB4sSdT',
'8BPfE49zdfbX657mKmRah6k1KHUeHp7dW5TveCeXaD4A',
14486770,'Ey8SjmvZWo1nHvSp5eFGEx1gm9jB4vw8vmTBwusuu1A5',
'Ey8SjmvZWo1nHvSp5eFGEx1gm9jB4vw8vmTBwusuu1A5',
19801000+144867,204000,-5663097
FROM arian_private.arian_d_finalized_quote_observations_v1 o
JOIN arian_private.arian_d_verified_spl_token_account_flows_v1 e USING(signature)
WHERE e.signature='2zUkjemYcDVTaGPHKjmxmQMTJwQrBZVMov3WVLjSChQmcCSGbTKh3kAsYqF9Hsv7pCdZ6PfztbMEmnumBDB4sSdT'
AND o.wsol_quote_transfer_lamports=14486770 AND o.fee_lamports=204000
AND o.owner_native_delta_lamports=-5663097
AND e.wallet_address='Ey8SjmvZWo1nHvSp5eFGEx1gm9jB4vw8vmTBwusuu1A5';
DO $check$ BEGIN
IF (SELECT count(*) FROM arian_private.arian_d_sale_settlement_traces_v1)<>1
THEN RAISE EXCEPTION 'One signed settlement trace required'; END IF;
END $check$;
COMMIT;