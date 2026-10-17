import test from "node:test";
import assert from "node:assert/strict";
import {presentVerifiedTrade} from "../src/stage-d-pnl-release-gate.js";
const valid = {signature:"signature_sample",inputAmountRaw:"100",outputAmountRaw:"200",
  inputUsd:10,outputUsd:15,feeUsd:0.5,evidence:{finalized:true,signatureMatches:true,
  inputOutputVerified:true,executionQuoteVerified:true,feeVerified:true,historyComplete:true,
  source:"solana_transaction"}};
test("incomplete history remains UNKNOWN",()=>{const t=structuredClone(valid);t.evidence.historyComplete=false;assert.equal(presentVerifiedTrade(t).pnlStatus,"UNKNOWN")});
test("historical reference price cannot prove execution quote",()=>{const t=structuredClone(valid);t.evidence.source="historical_reference_candle";assert.equal(presentVerifiedTrade(t).eligibleForSmartMoneyWinRate,false)});
test("missing fees are UNKNOWN",()=>{const t=structuredClone(valid);t.feeUsd=null;assert.equal(presentVerifiedTrade(t).realizedPnlUsd,null)});
test("unverified signature remains UNKNOWN",()=>{const t=structuredClone(valid);t.evidence.signatureMatches=false;assert.equal(presentVerifiedTrade(t).win,null)});
test("complete verified trade can calculate net PnL",()=>{const t=presentVerifiedTrade(valid);assert.equal(t.realizedPnlUsd,4.5);assert.equal(t.win,true)});
test("no negative or unbounded amounts",()=>{const t=structuredClone(valid);t.inputAmountRaw="-100";assert.equal(presentVerifiedTrade(t).pnlStatus,"UNKNOWN")});
