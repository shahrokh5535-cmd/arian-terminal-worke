import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSolanaTokenAccountFlow } from '../src/solana-token-flow-audit.js';

const owner='Ey8SjmvZWo1nHvSp5eFGEx1gm9jB4vw8vmTBwusuu1A5';
const mint='SaPFjDCz4bcrqVkU6JWjskJftp9jENNxP5T9Ur1pump';
const account='9JZuWww9sfb5hnCTEe9zn9SHB2XiEmDZrDWem8xL8G1n';
const pool='8Xa7oP25VtGznGNU7rtMHtb3MYk2Qzd5NHxdV4nKskMD';
const poolToken='B9RKFBbRZaMBSyJ6Xbnw67ShBn7fgBXT2kbMVGZke3sV';
const opts={owner,mint,tokenAccount:account,poolOwners:[pool]};

function makeTx({before='425468621245',after='0',kind='sell',
   version=1,program='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
   created=false,closed=false,poolOwner=pool}={}) {
  const tb=(amount,index,holder)=>({accountIndex:index,mint,owner:holder,
    uiTokenAmount:{amount,decimals:6}});
  const instructions=[];
  if(created) instructions.push({program:'spl-associated-token-account',
    parsed:{type:'create',info:{account}}});
  if(kind!=='close') {
    const diff=BigInt(after??0)-BigInt(before??0);
    instructions.push({program:'spl-token',parsed:{type:'transferChecked',
      info:{mint,source:kind==='sell'?account:poolToken,
        destination:kind==='sell'?poolToken:account,
        tokenAmount:{amount:(diff<0n?-diff:diff).toString()}}}});
  }
  if(closed) instructions.push({program:'spl-token',
    parsed:{type:'closeAccount',info:{account}}});
  return {version,slot:454323957,
    transaction:{message:{accountKeys:[{pubkey:account},{pubkey:poolToken}],
      instructions:[{programId:program},...instructions]}},
    meta:{err:null,
      preTokenBalances:[...(before==null?[]:[tb(before,0,owner)]),
        tb('100000000',1,poolOwner)],
      postTokenBalances:[...(after==null?[]:[tb(after,0,owner)]),
        tb('100000000',1,poolOwner)]}};
}

test('version-1 TIFFANY pool sale is evidence only',()=>{
  const x=auditSolanaTokenAccountFlow(makeTx(),opts);
  assert.equal(x.kind,'dex_pool_sell');
  assert.equal(x.deltaRaw,'-425468621245');
  assert.equal(x.productionReplayAuthorized,false);
  assert.equal(x.pnlVerified,false);
});
test('new account buy requires account creation evidence',()=>{
  const x=auditSolanaTokenAccountFlow(makeTx({
    before:null,after:'60416729397',kind:'buy',created:true,version:0
  }),opts);
  assert.equal(x.kind,'dex_pool_buy');
  assert.equal(x.beforeRaw,'0');
});
test('missing pre-balance without creation is blocked',()=>{
  assert.equal(auditSolanaTokenAccountFlow(makeTx({
    before:null,after:'60416729397',kind:'buy'
  }),opts).reason,'missing_pre_balance_without_account_creation');
});
test('token movement without DEX program remains unknown',()=>{
  const x=auditSolanaTokenAccountFlow(makeTx({
    program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  }),opts);
  assert.equal(x.status,'unsupported');
});
test('unrecognized pool owner is rejected',()=>{
  assert.equal(auditSolanaTokenAccountFlow(makeTx({
    poolOwner:'untrusted-pool'
  }),opts).status,'unsupported');
});
test('zero balance token account close is separate from sell',()=>{
  const x=auditSolanaTokenAccountFlow(makeTx({
    before:'0',after:null,kind:'close',closed:true,version:0
  }),opts);
  assert.equal(x.kind,'empty_token_account_close');
  assert.equal(x.deltaRaw,'0');
});
test('failed Solana transaction is ignored',()=>{
  const x=makeTx(); x.meta.err={InstructionError:[0,'Failure']};
  assert.equal(auditSolanaTokenAccountFlow(x,opts).status,'unsupported');
});
test('token account owner mismatch is rejected',()=>{
  const x=makeTx();x.meta.preTokenBalances[0].owner='different-owner';
  assert.equal(auditSolanaTokenAccountFlow(x,opts).reason,'token_account_owner_mismatch');
});
test('missing post-balance is not guessed without close instruction',()=>{
  assert.equal(auditSolanaTokenAccountFlow(makeTx({
    before:'100',after:null
  }),opts).reason,'missing_post_balance_without_close');
});
test('unsupported transaction versions fail closed',()=>{
  assert.equal(auditSolanaTokenAccountFlow(makeTx({version:2}),opts).reason,
    'unsupported_transaction_version');
});
test('never authorizes production replay even on valid DEX buys',()=>{
  const x=auditSolanaTokenAccountFlow(makeTx({
    before:'0',after:'425468621245',kind:'buy',version:1
  }),opts);
  assert.equal(x.kind,'dex_pool_buy');
  assert.equal(x.productionReplayAuthorized,false);
});
