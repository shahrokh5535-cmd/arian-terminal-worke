import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSolanaTokenAccountFlow } from '../src/solana-token-flow-audit.js';

const owner = 'Ey8SjmvZWo1nHvSp5eFGEx1gm9jB4vw8vmTBwusuu1A5';
const mint = 'SaPFjDCz4bcrqVkU6JWjskJftp9jENNxP5T9Ur1pump';
const tokenAccount = '9JZuWww9sfb5hnCTEe9zn9SHB2XiEmDZrDWem8xL8G1n';
const poolToken = 'B9RKFBbRZaMBSyJ6Xbnw67ShBn7fgBXT2kbMVGZke3sV';
const poolOwner = '8Xa7oP25VtGznGNU7rtMHtb3MYk2Qzd5NHxdV4nKskMD';
const options = {owner,mint,tokenAccount,poolOwners:[poolOwner]};
const balance = (accountIndex, raw, holder) => ({accountIndex,mint,owner:holder,uiTokenAmount:{amount:raw,decimals:6}});
function fixture({before='425468621245',after='0',dex=true,recipientOwner=poolOwner,close=false,create=false}={}) {
  const delta=BigInt(after??0)-BigInt(before??0);
  const source=delta<0n?tokenAccount:poolToken;
  const destination=delta<0n?poolToken:tokenAccount;
  const amount=(delta<0n?-delta:delta).toString();
  const instructions=[
    ...(dex?[{programId:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'}]:[]),
    ...(create?[{parsed:{type:'create',info:{account:tokenAccount}}}]:[]),
    ...(delta!==0n?[{parsed:{type:'transferChecked',info:{mint,source,destination,tokenAmount:{amount}}}]:[]),
    ...(close?[{parsed:{type:'closeAccount',info:{account:tokenAccount}}}]:[])
  ];
  return {version:1,slot:454323957,transaction:{message:{accountKeys:[{pubkey:tokenAccount},{pubkey:poolToken}],instructions}},meta:{err:null,preTokenBalances:[...(before===null?[]:[balance(0,before,owner)]),balance(1,'787365811335158',recipientOwner)],postTokenBalances:[...(after===null?[]:[balance(0,after,owner)]),balance(1,'787791279956403',recipientOwner)]}};
}

test('Solana v1 PumpSwap pool exit is a DEX sale, never verified PnL',()=>{
  const r=auditSolanaTokenAccountFlow(fixture(),options);
  assert.equal(r.kind,'dex_pool_sell');
  assert.equal(r.deltaRaw,'-425468621245');
  assert.equal(r.pnlVerified,false);
  assert.equal(r.productionReplayAuthorized,false);
});
test('ordinary wallet transfer cannot become a sale',()=>{
  const r=auditSolanaTokenAccountFlow(fixture({dex:false}),options);
  assert.equal(r.status,'unsupported');
  assert.equal(r.productionReplayAuthorized,false);
});
test('unknown pool ownership blocks sale classification',()=>{
  const r=auditSolanaTokenAccountFlow(fixture({recipientOwner:'other-owner'}),options);
  assert.equal(r.status,'unsupported');
});
test('missing pre-balance without explicit account creation blocks buy',()=>{
  const r=auditSolanaTokenAccountFlow(fixture({before:null,after:'100'}),options);
  assert.equal(r.reason,'missing_pre_balance_without_account_creation');
});
test('empty account closure is not a sale',()=>{
  const r=auditSolanaTokenAccountFlow(fixture({before:'0',after:null,close:true}),options);
  assert.equal(r.kind,'empty_token_account_close');
  assert.equal(r.pnlVerified,false);
});
test('failed transaction is not a trade',()=>{
  const tx=fixture(); tx.meta.err={InstructionError:[0,'Failure']};
  assert.equal(auditSolanaTokenAccountFlow(tx,options).status,'unsupported');
});
