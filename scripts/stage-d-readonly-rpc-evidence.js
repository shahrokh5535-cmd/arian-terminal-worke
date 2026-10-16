// Stage D: bounded read-only Solana RPC evidence inspection. NO writes or PnL.
import { setTimeout as sleep } from "node:timers/promises";
const ids = [
"3qaLS3miSAe6SBV13v4KDCCse9wUsqv3ebT8zaypDb3JRawLY4on9z5LddiDv5yaRjwkJGQoiB3JuuRmejAHxTmn",
"4iCUHe7EoDkXSjBThTvWxcfDHnxyz3eEhZsxcQKpq54217bkFEWzy2mria5wHAh3k9S72R91wdaUKcXKdZQHJX8k",
"2x4UzPZSTLBySs89gXeHksupnLgDCGqZvBa4GvGXcDUbMhnBDU3rmeNnYVBymWu4cBnGWTq6ZYQ7sSvTUMK3NNqD",
"4xHAAMAisUGPj5vv88j2MiVWVLDZ4yVu8vWsT7YwYTdaKwAoxhSM9Q3sP77XyLcmbD19Rfo8qRgEXNAVr6WTXNkZ",
"2VejEv1ELgwZ6QCVWEnmZQ7Bo1WGPQnndYBqhzRRH2wwJEbdGhLVinypAEXG2PncLQf8mK3RzWJ6RyrccM3ZtjBa",
"2YpUwaUq1gLEtVE1PPrPModbHDNQcgsF9EuLTETHh2DpS8qMCn9Fn1z4tJM97LbGqg3wfM52TUBNvspbLntoNnJH",
"2zUkjemYcDVTaGPHKjmxmQMTJwQrBZVMov3WVLjSChQmcCSGbTKh3kAsYqF9Hsv7pCdZ6PfztbMEmnumBDB4sSdT",
"5bUNzSSAf1PiLE8xco6N5e5rteUXy67ioKy6DtdQ4ZaxvtjsiSQKS7UBp8ogns3jpvavA32fNqLy68XoFNiB8Sz5"
];
const endpoint = process.env.SOLANA_RPC_READONLY_URL;
if (!endpoint) { console.error("Set SOLANA_RPC_READONLY_URL (no credentials printed)"); process.exitCode = 2; }
else {
  let url;
  try {
    url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) throw Error("RPC URL must be HTTPS");
  } catch { console.error("Invalid secure RPC endpoint"); process.exit(2); }
  const results = [];
  for (let i=0;i<ids.length;i++) {
    const signature=ids[i];
    let row={signature,status:"UNKNOWN",feeLamports:null,slot:null,blockTime:null,
      solBalanceChanges:[],tokenBalanceChanges:[],pnlVerified:false,productionReplayAuthorized:false};
    try {
      const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:i+1,method:"getTransaction",
          params:[signature,{encoding:"jsonParsed",commitment:"finalized",maxSupportedTransactionVersion:1}]}),
        signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw Error("rpc_http_"+response.status);
      const json=await response.json();
      if (json.error) throw Error("rpc_error_"+json.error.code);
      const tx=json.result;
      if (!tx) throw Error("historical_transaction_unavailable");
      if (tx.meta?.err != null || !tx.meta || !tx.transaction?.message) throw Error("transaction_failed_or_incomplete");
      const keys=(tx.transaction.message.accountKeys||[]).map(x=>typeof x==="string"?x:x.pubkey);
      if(!Array.isArray(tx.meta.preBalances)||!Array.isArray(tx.meta.postBalances)||
         tx.meta.preBalances.length!==tx.meta.postBalances.length||
         tx.meta.preBalances.length!==keys.length) throw Error("native_balances_incomplete");
      row.status="EVIDENCE_ONLY";row.slot=tx.slot;row.blockTime=tx.blockTime;
      row.feeLamports=Number.isSafeInteger(tx.meta.fee)?tx.meta.fee:null;
      row.solBalanceChanges=keys.flatMap((account,index)=>{
        const before=tx.meta.preBalances[index],after=tx.meta.postBalances[index];
        if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||before===after)return [];
        return [{account,deltaLamports:after-before}];
      });
      const tokens=new Map();
      for(const [phase,arr] of [["before",tx.meta.preTokenBalances],["after",tx.meta.postTokenBalances]]){
        for(const t of arr||[]) {
          const k=String(t.accountIndex)+":"+String(t.mint);
          const prev=tokens.get(k)||{account:keys[t.accountIndex],mint:t.mint,before:null,after:null,owner:t.owner||null};
          prev[phase]=t.uiTokenAmount?.amount??null;tokens.set(k,prev);
        }
      }
      row.tokenBalanceChanges=[...tokens.values()].map(t=>({...t,deltaRaw:t.before!==null&&t.after!==null&&/^[0-9]+$/.test(t.before)&&/^[0-9]+$/.test(t.after)?(BigInt(t.after)-BigInt(t.before)).toString():null}));
    } catch(e) {row.status="UNKNOWN";row.reason=String(e.message).slice(0,100);}
    results.push(row);
    if(i+1<ids.length) await sleep(900);
  }
  console.log(JSON.stringify({mode:"read_only_evidence",count:results.length,results},null,2));
}
