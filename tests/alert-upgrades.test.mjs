import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBestPair, poolKey, fetchAllPairs } from '../src/dexscreener.js';
import {
  detectLargeSelloff, updateRugWatch, updateObservedHighs, createEarlyLiquidityAlertEmbed,
  buildAlertDiagnostics, captureMarketDiagnostics, saveRefreshState, createStorageEmbed,
  parseConfig, publishDashboard, updateLargeSelloffs,
} from '../src/tracker.js';
import { executeTrackerCommand } from '../src/commands.js';

const SOL='So11111111111111111111111111111111111111112';
const STORE='423456789012345678', MSG='523456789012345678';
const RUG='623456789012345678', ATH='723456789012345678';
const DASH='823456789012345678', SELL='923456789012345678';
const date=minute=>({now:()=>new Date(Date.UTC(2026,10,28,0,minute,0))});
const token=()=>({chain:'solana',address:SOL,symbol:'GOO'});
function pair({liq=12000,price=0.001,mc=100000,pool='main-pool',
 m5=-3,h1=-8,h6=-11,buys=30,sells=90,txns=true}={}){
 return {chainId:'solana',pairAddress:pool,baseToken:{address:SOL,symbol:'GOO'},
  priceUsd:price,marketCap:mc,liquidity:{usd:liq},
  priceChange:{m5,h1,h6},...(txns?{txns:{
    m5:{buys:20,sells:25},h1:{buys:50,sells:60},h6:{buys,sells},
  }}:{}),url:'https://dexscreener.com/solana/demo'};
}
function fixture({rug=true,ath=false,sell=false,t=null}={}){
 const item=t||token();
 const config={version:1,dashboardChannelId:DASH,dashboardMessageId:null,
  rugChannelId:rug?RUG:null,athChannelId:ath?ATH:null,
  selloffChannelId:sell?SELL:null,tokens:[item]};
 const store={config,configChannelId:STORE,configMessageId:MSG};
 const messages=[],writes=[];
 const client={async request(path,opts={}){
  if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method==='PATCH'){
   writes.push(opts.body);return {id:MSG};
  }
  if(path==='/channels/'+STORE+'/messages/'+MSG && !opts.method)return null;
  if(path==='/channels/'+RUG+'/messages'&&opts.method==='POST'){
   messages.push({path,embed:opts.body.embeds[0]});return {id:'111111111111111111'};
  }
  if(path==='/channels/'+ATH+'/messages'&&opts.method==='POST'){
   messages.push({path,embed:opts.body.embeds[0]});return {id:'222222222222222222'};
  }
  if(path==='/channels/'+SELL+'/messages'&&opts.method==='POST'){
   messages.push({path,embed:opts.body.embeds[0]});return {id:'333333333333333333'};
  }
  if(path==='/channels/'+DASH+'/messages'&&opts.method==='POST'){
   messages.push({path,embed:opts.body.embeds[0]});return {id:'444444444444444444'};
  }
  if(path==='/channels/'+DASH+'/messages/444444444444444444'&&opts.method==='PATCH')return {id:'444444444444444444'};
  throw Error('Unexpected '+path+' '+opts.method);
 }};
 return {store,client,messages,writes,item};
}
const entries=(f,p)=>[{token:f.item,pair:p}];

test('slow bleed triggers on 6h decline with real trading pressure without changing 5m/1h rules',()=>{
 const p=pair({m5:-3,h1:-13,h6:-45,buys:40,sells:65});
 assert.deepEqual(detectLargeSelloff(p),{window:'h6',priceChange:-45,buys:40,sells:65});
 assert.equal(detectLargeSelloff(pair({m5:-3,h1:-13,h6:-44.9,buys:40,sells:95})),null);
 assert.equal(detectLargeSelloff(pair({m5:-3,h1:-13,h6:-47,buys:45,sells:54})),null);
 assert.equal(detectLargeSelloff(pair({m5:-3,h1:-13,h6:-47,buys:25,sells:55})),null);
 assert.equal(detectLargeSelloff(pair({m5:-3,h1:-13,h6:null,buys:25,sells:100})),null);
});

test('slow bleed posts in selected selloff channel using existing cooldown',async()=>{
 const f=fixture({rug:false,sell:true});
 let p=pair({m5:-3,h1:-13,h6:-50,buys:30,sells:120});
 const result=await updateLargeSelloffs(f.client,f.store,entries(f,p),date(0));
 assert.equal(result.selloffAlerts,1);
 assert.equal(f.messages[0].path,'/channels/'+SELL+'/messages');
 assert.equal(f.messages[0].embed.title,'🟥 Slow Bleed Detected');
 assert.match(f.messages[0].embed.description,/Price change \(6 hours\): \*\*-50\.00%\*\*/);
 assert.equal((await updateLargeSelloffs(f.client,f.store,entries(f,p),date(20))).selloffAlerts,0);
});

test('early liquidity warning only posts on two consecutive qualifying same-pool samples',async()=>{
 const f=fixture();
 await updateRugWatch(f.client,f.store,entries(f,pair()),date(0));
 let first=await updateRugWatch(f.client,f.store,entries(f,pair({liq:4600})),date(1));
 assert.equal(first.earlyLiquidityAlerts,0);
 assert.equal(f.messages.length,0);
 let second=await updateRugWatch(f.client,f.store,entries(f,pair({liq:4500})),date(2));
 assert.equal(second.earlyLiquidityAlerts,1);
 assert.equal(second.rugAlerts,0);
 assert.equal(f.messages.length,1);
 assert.equal(f.messages[0].embed.title,'⚠️ Early Liquidity Warning');
 assert.match(f.messages[0].embed.footer.text,/Not proof of LP withdrawal/);
 assert.equal((await updateRugWatch(f.client,f.store,entries(f,pair({liq:4300})),date(3))).earlyLiquidityAlerts,0);
 assert.ok(f.item.r[6] > 0);
});

test('early warning clears a pending confirmation after healthy recovery, missing sample, or changed pool',async()=>{
 const f=fixture();
 await updateRugWatch(f.client,f.store,entries(f,pair()),date(0));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:4200})),date(1));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:9500})),date(2));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:4200})),date(3));
 assert.equal(f.messages.length,0);
 await updateRugWatch(f.client,f.store,[{token:f.item,pair:null,error:'429'}],date(4));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:4200})),date(5));
 assert.equal(f.messages.length,0);
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:4200,pool:'other-pool'})),date(6));
 assert.equal(f.messages.length,0);
});

test('critical rug detection takes precedence over early warning and keeps 6h critical cooldown',async()=>{
 const f=fixture();
 await updateRugWatch(f.client,f.store,entries(f,pair()),date(0));
 let r=await updateRugWatch(f.client,f.store,entries(f,pair({liq:2000,price:0.0002})),date(1));
 assert.equal(r.rugAlerts,1);
 assert.equal(r.earlyLiquidityAlerts,0);
 assert.match(f.messages[0].embed.title,/Suspected rug/);
});

test('ATH ignores a single extreme market-cap spike, confirms on next valid reading',async()=>{
 const f=fixture({rug:false,ath:true,t:{...token(),h:30000,a:30000}});
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:180000})),date(0));
 assert.equal(f.messages.length,0);
 assert.equal(f.item.h,30000);
 assert.ok(Array.isArray(f.item.q));
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:170000})),date(1));
 assert.equal(f.messages.length,1);
 assert.equal(f.item.h,170000);
 assert.equal(f.item.q,undefined);
});

test('ATH discarded spike does not pollute observed history',async()=>{
 const f=fixture({rug:false,ath:true,t:{...token(),h:30000,a:30000}});
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:180000})),date(0));
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:29000})),date(1));
 assert.equal(f.item.h,30000);
 assert.equal(f.messages.length,0);
 assert.equal(f.item.q,undefined);
});

test('sticky selection keeps tracked pool even if another pool temporarily has more liquidity',()=>{
 const main=pair({pool:'pool-main',liq:6000,mc:100000});
 const competing=pair({pool:'pool-competing',liq:120000,mc:230000});
 const t={...token(),p:poolKey(main)};
 assert.equal(selectBestPair([competing,main],t),main);
 assert.equal(selectBestPair([competing],t),competing);
 assert.equal(selectBestPair([competing,main],{...token()}),competing);
});

test('captures last check status and pool switch without storing large pair records',()=>{
 const f=fixture(),t=f.item;
 captureMarketDiagnostics(entries(f,pair({pool:'pool-A'})),new Date('2026-11-28T00:00:00Z'));
 assert.deepEqual(t.d,[1795824000,0,0]);
 assert.equal(t.p,'pool-A');
 captureMarketDiagnostics(entries(f,pair({pool:'pool-B'})),new Date('2026-11-28T00:01:00Z'));
 assert.deepEqual(t.d,[1795824060,0,1]);
 assert.equal(t.p,'pool-B');
 captureMarketDiagnostics([{token:t,pair:null,error:'429'}],new Date('2026-11-28T00:02:00Z'));
 assert.deepEqual(t.d,[1795824120,2,0]);
});

test('diagnostics show current eligibility, stored check health, pool and cooldown',()=>{
 const f=fixture({rug:true,ath:true,sell:true}),t=f.item;
 const clock=new Date('2026-11-28T00:10:00Z');
 captureMarketDiagnostics(entries(f,pair()),clock);
 t.s=Math.floor(clock.getTime()/1000)-60;
 t.r=['main-pool',12000,0.001,Math.floor(clock.getTime()/1000)-120,0,0,0];
 const text=buildAlertDiagnostics(t,pair({h6:-50,m5:-1,h1:-3,buys:30,sells:110}),f.store.config,clock);
 assert.match(text,/Selloff.*h6 conditions met.*cooldown active/);
 assert.match(text,/Rug\/Liquidity.*USD liquidity drop/);
 assert.match(text,/Last scheduled check/);
 assert.match(text,/Selected pool/);
 assert.match(text,/not a historical audit/);
});

test('merge state before persistence preserves user channel changes, removed tokens, and latest alert cooldowns',async()=>{
 const f=fixture({rug:true,ath:true,sell:true});
 const remote={...f.store.config,selloffChannelId:null,athMinPct:12,
  tokens:[{...f.item,h:100000,a:100000,s:1795824120}]};
 f.item.h=80000;f.item.a=90000;f.item.s=1795824000;
 f.item.d=[1795824180,0,0];f.item.p='main-pool';
 let saved;
 f.client.request=async(path,opts={})=>{
  if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method===undefined)
   return {embeds:[createStorageEmbed(remote)]};
  if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method==='PATCH'){
   saved=opts.body;return {id:MSG};
  }
  throw Error('Unexpected '+path);
 };
 await saveRefreshState(f.client,f.store);
 assert.equal(f.store.config.selloffChannelId,null);
 assert.equal(f.store.config.athMinPct,12);
 assert.equal(f.store.config.tokens[0].h,100000);
 assert.equal(f.store.config.tokens[0].s,1795824120);
 assert.deepEqual(f.store.config.tokens[0].d,[1795824180,0,0]);
 assert.ok(saved);
});

test('concurrent refreshes within one instance share one market fetch and one dashboard post',async()=>{
 const f=fixture({rug:false,ath:false,sell:false});
 let ready; const gate=new Promise(resolve=>{ready=resolve});
 let calls=0;
 const fetcher=async()=>{
  calls++;await gate;
  return {ok:true,json:async()=>[pair()]};
 };
 const first=publishDashboard(f.client,f.store,{fetcher,date:date(0)});
 const second=publishDashboard(f.client,f.store,{fetcher,date:date(0)});
 ready();
 const results=await Promise.all([first,second]);
 assert.equal(calls,1);
 assert.equal(f.messages.filter(x=>x.path==='/channels/'+DASH+'/messages').length,1);
 assert.equal(results[1].coalesced,true);
});

test('serialized diagnostics, pinned pool and warning history fit private embed for 25 tokens',()=>{
 const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
 const cfg={version:1,dashboardChannelId:DASH,dashboardMessageId:null,
   rugChannelId:RUG,selloffChannelId:SELL,athChannelId:ATH,
   tokens:Array.from({length:25},(_,i)=>({chain:'solana',address:SOL.slice(0,-1)+chars[i],
     symbol:'TOK'+i,p:'pool-'+i,d:[1795824000,0,0],
     r:['pool-'+i,12000,0.0001,1795823940,0,1795823999,1795824010],
     h:120000,a:120000,b:130000,q:[1795824000,'pool-'+i],s:1795824020,t:1795824030}))};
 const embed=createStorageEmbed(cfg);
 assert.ok(embed.description.length<=4096);
 assert.deepEqual(parseConfig({embeds:[embed]}),cfg);
});


test('fresh first-time rug baseline is not dropped by reconciling with empty remote history',async()=>{
 const f=fixture({rug:true,ath:false,sell:false});
 const latest={...f.store.config,tokens:[{...f.item}]};
 const baseline=['main-pool',12000,0.001,1795824000,0,0,0];
 f.item.r=baseline;
 f.item.d=[1795824000,0,0];
 f.item.p='main-pool';
 f.client.request=async(path,opts={})=>{
  if(path==='/channels/'+STORE+'/messages/'+MSG && !opts.method)
   return {embeds:[createStorageEmbed(latest)]};
  if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method==='PATCH')
   return {id:MSG};
  throw Error('Unexpected '+path);
 };
 await saveRefreshState(f.client,f.store);
 assert.deepEqual(f.store.config.tokens[0].r,baseline);
 assert.deepEqual(f.store.config.tokens[0].d,[1795824000,0,0]);
});
test('reconciler does not restore a tracked token that a command removed',async()=>{
 const f=fixture({rug:true,ath:false,sell:false});
 const deleted={...f.store.config,tokens:[]};
 f.item.d=[1795824000,0,0];
 f.client.request=async(path,opts={})=>{
  if(path==='/channels/'+STORE+'/messages/'+MSG && !opts.method)
   return {embeds:[createStorageEmbed(deleted)]};
  if(path==='/channels/'+STORE+'/messages/'+MSG && opts.method==='PATCH')
   return {id:MSG};
  throw Error('Unexpected '+path);
 };
 await saveRefreshState(f.client,f.store);
 assert.equal(f.store.config.tokens.length,0);
});


test('high-entropy maximum 25-token alert history fits Discord storage after upgrades',()=>{
 let seed=927319;
 const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
 const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 const random=n=>Array.from({length:n},()=>chars[Math.floor(rnd()*chars.length)]).join('');
 const tokens=Array.from({length:25},()=>{
   const pool=random(16);
   return {chain:'solana',address:random(44),symbol:random(24),
     p:pool,d:[1760000000+Math.floor(rnd()*9e7),0,0],
     r:[pool,Math.floor(rnd()*1e7)/100,Number(rnd().toPrecision(9)),
       1760000000+Math.floor(rnd()*9e7),1760000000+Math.floor(rnd()*9e7),
       1760000000+Math.floor(rnd()*9e7),1760000000+Math.floor(rnd()*9e7)],
     h:Math.floor(rnd()*1e8),a:Math.floor(rnd()*1e8),
     b:Math.floor(rnd()*1e8),t:1760000000+Math.floor(rnd()*9e7),
     s:1760000000+Math.floor(rnd()*9e7),q:[1760000000+Math.floor(rnd()*9e7),pool]};
 });
 const cfg={version:1,dashboardChannelId:DASH,athChannelId:ATH,
   rugChannelId:RUG,selloffChannelId:SELL,cv:8,tokens};
 const embed=createStorageEmbed(cfg);
 assert.ok(embed.description.length<=4096);
 assert.deepEqual(parseConfig({embeds:[embed]}),cfg);
});


test('invalid priced sample interrupts early liquidity confirmation instead of generating a false alert',async()=>{
 const f=fixture();
 await updateRugWatch(f.client,f.store,entries(f,pair()),date(0));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:4300})),date(1));
 await updateRugWatch(f.client,f.store,entries(f,pair({liq:null,price:-1})),date(2));
 assert.equal(f.item.r[5],0);
 const next=await updateRugWatch(f.client,f.store,entries(f,pair({liq:4300})),date(3));
 assert.equal(next.earlyLiquidityAlerts,0);
 const confirmed=await updateRugWatch(f.client,f.store,entries(f,pair({liq:4200})),date(4));
 assert.equal(confirmed.earlyLiquidityAlerts,1);
});
test('missing API sample cancels pending ATH spike confirmation',async()=>{
 const f=fixture({rug:false,ath:true,t:{...token(),h:30000,a:30000}});
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:180000})),date(0));
 assert.ok(f.item.q);
 captureMarketDiagnostics([{token:f.item,pair:null,error:'429'}],
   new Date('2026-11-28T00:01:00Z'));
 assert.equal(f.item.q,undefined);
 await updateObservedHighs(f.client,f.store,entries(f,pair({mc:175000})),date(2));
 assert.equal(f.messages.length,0);
 assert.ok(f.item.q);
});
