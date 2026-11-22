import test from 'node:test';
import assert from 'node:assert/strict';
import { updateObservedHighs, createHighAlertEmbed, parseConfig, serializeConfig, createStorageEmbed } from '../src/tracker.js';

const SOL='So11111111111111111111111111111111111111112';
const STORE='423456789012345678', MSG='523456789012345678', ALERT='623456789012345678', DASH='723456789012345678';

function fixture({athEnabled=true,minPct=0,baseline=null,failAlert=false}={}) {
  const token={chain:'solana',address:SOL,symbol:'DREAD',
    ...(baseline==null?{}:{h:baseline,a:baseline})};
  const config={version:1,dashboardChannelId:DASH,dashboardMessageId:null,tokens:[token],
    athChannelId:athEnabled?ALERT:null,athMinPct:minPct};
  const store={config,configChannelId:STORE,configMessageId:MSG};
  const calls=[],posted=[];
  const client={async request(path,opts={}){
    calls.push({path,method:opts.method,body:opts.body});
    if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method==='PATCH')return {id:MSG};
    if(path==='/channels/'+ALERT+'/messages' && opts.method==='POST'){
      if(failAlert)throw Object.assign(new Error('Missing Permissions'),{status:403});
      posted.push(opts.body);
      return {id:'823456789012345678'};
    }
    throw new Error('Unexpected Discord request '+path);
  }};
  return {client,store,calls,posted,setFail(v){failAlert=v}};
}
function sample(store,mc,extras={}){
  return [{token:store.config.tokens[0],pair:{baseToken:{symbol:'DREAD'},priceUsd:0.004,
    marketCap:mc,liquidity:{usd:12000},url:'https://dexscreener.com/solana/demo',...extras}}];
}
test('first observed market cap establishes baseline without a false alert',async()=>{
  const f=fixture();
  const res=await updateObservedHighs(f.client,f.store,sample(f.store,1000));
  assert.equal(res.alerts,0);
  assert.equal(f.posted.length,0);
  assert.equal(f.store.config.tokens[0].h,1000);
  assert.equal(f.store.config.tokens[0].a,1000);
});
test('higher sampled market cap sends notification to configured channel',async()=>{
  const f=fixture({baseline:1000});
  const result=await updateObservedHighs(f.client,f.store,sample(f.store,1500),{now:()=>new Date('2026-11-23T00:00:00Z')});
  assert.equal(result.alerts,1);
  assert.equal(f.posted.length,1);
  const body=f.posted[0];
  assert.deepEqual(body.allowed_mentions.parse,[]);
  assert.match(body.embeds[0].description,/MC  \$1\.50K/);
  assert.match(body.embeds[0].description,/Previous recorded MC  \*\*\$1\.00K\*\*/);
  assert.match(body.embeds[0].footer.text,/Not verified lifetime ATH/);
  assert.equal(body.embeds[0].timestamp,'2026-11-23T00:00:00.000Z');
  assert.equal(f.store.config.tokens[0].a,1500);
});
test('same or lower market caps never create duplicate high alerts',async()=>{
  const f=fixture({baseline:1000});
  await updateObservedHighs(f.client,f.store,sample(f.store,1200));
  await updateObservedHighs(f.client,f.store,sample(f.store,1200));
  await updateObservedHighs(f.client,f.store,sample(f.store,1150));
  assert.equal(f.posted.length,1);
});
test('minimum percent increase is measured against last alerted high',async()=>{
  const f=fixture({baseline:100,minPct:5});
  await updateObservedHighs(f.client,f.store,sample(f.store,103));
  assert.equal(f.posted.length,0);
  await updateObservedHighs(f.client,f.store,sample(f.store,106));
  assert.equal(f.posted.length,1);
  await updateObservedHighs(f.client,f.store,sample(f.store,108));
  assert.equal(f.posted.length,1);
  await updateObservedHighs(f.client,f.store,sample(f.store,112));
  assert.equal(f.posted.length,2);
});
test('disabled alerts track sampled highs without posting',async()=>{
  const f=fixture({baseline:100,athEnabled:false});
  const res=await updateObservedHighs(f.client,f.store,sample(f.store,200));
  assert.equal(res.athEnabled,false);
  assert.equal(f.store.config.tokens[0].h,200);
  assert.equal(f.posted.length,0);
});
test('FDV-only token does not trigger a market-cap high',async()=>{
  const f=fixture({baseline:100});
  await updateObservedHighs(f.client,f.store,sample(f.store,null,{fdv:9000}));
  assert.equal(f.store.config.tokens[0].h,100);
  assert.equal(f.posted.length,0);
});
test('failed notification can retry without breaking dashboard refresh',async()=>{
  const f=fixture({baseline:100,failAlert:true});
  const previous=console.error;console.error=()=>{};
  try{
    const first=await updateObservedHighs(f.client,f.store,sample(f.store,110));
    assert.equal(first.alerts,0);
    assert.equal(f.store.config.tokens[0].h,100);
    f.setFail(false);
    const second=await updateObservedHighs(f.client,f.store,sample(f.store,110));
    assert.equal(second.alerts,1);
    assert.equal(f.posted.length,1);
  } finally { console.error=previous; }
});
test('twelve tokens with stored highs fit private Discord configuration limits',()=>{
  const config={version:1,dashboardChannelId:DASH,athChannelId:ALERT,athMinPct:0,
    dashboardMessageId:null,tokens:Array.from({length:12},(_,i)=>({
      chain:'solana',address:SOL.slice(0,43)+String(i%10),
      symbol:'LONGSYMBOLFORCOIN'+i,h:123456789.123,a:123456789.123,
    }))};
  const saved=serializeConfig(config);
  assert.ok(saved.length<=2000);
  assert.equal(parseConfig(saved)?.tokens.length,12);
  assert.ok(createStorageEmbed(config).description.length<=4096);
});
test('simulated ATH preview is visibly labeled and leaves records unchanged',()=>{
  const token={chain:'solana',address:SOL,symbol:'DREAD',h:120000,a:120000};
  const pair={baseToken:{symbol:'DREAD'},priceUsd:'0.004',marketCap:125000,url:'https://dexscreener.com/solana/demo'};
  const embed=createHighAlertEmbed(token,pair,100000,125000,new Date('2026-11-23T01:02:00Z'),{preview:true});
  assert.match(embed.title,/PREVIEW/);
  assert.match(embed.description,/MC  \$125\.00K/);
  assert.match(embed.description,/TEST ONLY/);
  assert.match(embed.description,/\+25\.00%/);
  assert.match(embed.footer.text,/Simulated/);
  assert.equal(embed.color,0x5865f2);
  assert.equal(token.h,120000);
  assert.equal(token.a,120000);
});
