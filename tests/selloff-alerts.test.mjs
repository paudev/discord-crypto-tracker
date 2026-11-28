import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelloffAlertEmbed, createStorageEmbed, detectLargeSelloff,
  parseConfig, serializeConfig, updateLargeSelloffs, publishDashboard } from '../src/tracker.js';

const SOL = 'So11111111111111111111111111111111111111112';
const DATA = '423456789012345678', STORE_MESSAGE = '523456789012345678';
const DASH = '723456789012345678', SELLOFF = '823456789012345678';
const RUG = '923456789012345678', ATH = '623456789012345678';
const at = minutes => ({ now: () => new Date(Date.UTC(2026,10,28,0,minutes,0)) });

function market({m5=-23,h1=-9,m5buys=12,m5sells=38,h1buys=60,h1sells=80}={}) {
  return {
    chainId:'solana', pairAddress:'sample-pool', baseToken:{address:SOL,symbol:'DREAD'},
    priceUsd:'0.000031', marketCap:42000, liquidity:{usd:24000},
    priceChange:{m5,h1},
    txns:{m5:{buys:m5buys,sells:m5sells},h1:{buys:h1buys,sells:h1sells}},
    url:'https://dexscreener.com/solana/dread',
  };
}
function fixture({enabled=true,fail=false,token={},channel=SELLOFF}={}) {
  const t={chain:'solana',address:SOL,symbol:'DREAD',...token};
  const store={config:{version:1,dashboardChannelId:DASH,dashboardMessageId:null,
    rugChannelId:RUG,athChannelId:ATH,selloffChannelId:enabled?channel:null,tokens:[t]},
    configChannelId:DATA,configMessageId:STORE_MESSAGE};
  const messages=[],saves=[];
  const client={async request(path,options={}) {
    if(path==='/channels/'+DATA+'/messages/'+STORE_MESSAGE && options.method==='PATCH') {
      saves.push(options.body);return {id:STORE_MESSAGE};
    }
    if(path==='/channels/'+channel+'/messages' && options.method==='POST') {
      if(fail)throw Error('Discord missing permission');
      messages.push({path,body:options.body});return {id:'111111111111111111'};
    }
    throw Error('Unexpected request '+path);
  }};
  return {store,client,messages,saves,token:t,setFail(v){fail=v}};
}
function entries(f,pair){return [{token:f.token,pair}];}

test('5-minute rapid selloff requires 20% fall, 2:1 selling and at least 20 trades',()=>{
  const signal=detectLargeSelloff(market({m5:-20,m5buys:7,m5sells:14}));
  assert.deepEqual(signal,{window:'m5',priceChange:-20,buys:7,sells:14});
  assert.equal(detectLargeSelloff(market({m5:-19.99})),null);
  assert.equal(detectLargeSelloff(market({m5:-21,m5buys:8,m5sells:15})),null);
  assert.equal(detectLargeSelloff(market({m5:-21,m5buys:6,m5sells:13})),null);
});

test('1-hour sustained selloff catches prolonged selling without 5-minute collapse',()=>{
  const signal=detectLargeSelloff(market({m5:-3,h1:-35,h1buys:15,h1sells:35}));
  assert.deepEqual(signal,{window:'h1',priceChange:-35,buys:15,sells:35});
  assert.equal(detectLargeSelloff(market({m5:-3,h1:-34.9,h1buys:10,h1sells:90})),null);
  assert.equal(detectLargeSelloff(market({m5:-3,h1:-36,h1buys:20,h1sells:29})),null);
});

test('missing or invalid data and high sell counts without a price collapse do not trigger',()=>{
  const base=market({m5:-6,h1:-8,m5buys:3,m5sells:850,h1buys:3,h1sells:900});
  assert.equal(detectLargeSelloff(base),null);
  assert.equal(detectLargeSelloff(null),null);
  assert.equal(detectLargeSelloff({...base,priceChange:null}),null);
  assert.equal(detectLargeSelloff({...market(),txns:{h1:{buys:3,sells:40}}}),null);
  assert.equal(detectLargeSelloff({...market(),txns:{m5:{buys:null,sells:40}}}),null);
  assert.equal(detectLargeSelloff({...market(),txns:{m5:{buys:0,sells:'bad'}}}),null);
  assert.equal(detectLargeSelloff({...market(),txns:{m5:{buys:0,sells:-24}}}),null);
  assert.equal(detectLargeSelloff({...market(),txns:{m5:{buys:0,sells:3}}}),null);
  assert.deepEqual(detectLargeSelloff(market({m5buys:0,m5sells:25})),
    {window:'m5',priceChange:-23,buys:0,sells:25});
});

test('selloff alerts are independent from the rug/ATH channel and honor cooldown',async()=>{
  const f=fixture();
  const first=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(0));
  assert.deepEqual(first,{selloffAlerts:1,selloffEnabled:true});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].path,'/channels/'+SELLOFF+'/messages');
  assert.equal(f.messages[0].body.embeds[0].title,'🟥 Large Selloff Detected');
  assert.deepEqual(f.messages[0].body.allowed_mentions.parse,[]);
  assert.equal(f.store.config.rugChannelId,RUG);
  assert.equal(f.store.config.athChannelId,ATH);
  const silent=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(59));
  assert.equal(silent.selloffAlerts,0);
  assert.equal(f.messages.length,1);
  const again=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(60));
  assert.equal(again.selloffAlerts,1);
  assert.equal(f.messages.length,2);
  assert.ok(f.token.s>0);
});

test('failed alert keeps cooldown free for next-minute retry',async()=>{
  const f=fixture({fail:true});
  const original=console.error;console.error=()=>{};
  try {
    const first=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(0));
    assert.equal(first.selloffAlerts,0);
    assert.equal(f.token.s,undefined);
  }finally{console.error=original;}
  f.setFail(false);
  const retry=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(1));
  assert.equal(retry.selloffAlerts,1);
  assert.equal(f.messages.length,1);
});

test('disabled selloff alerts never post or alter saved samples',async()=>{
  const f=fixture({enabled:false,token:{r:['pool',12000,0.1,1790000000,0]}});
  const before=JSON.stringify(f.store.config);
  assert.deepEqual(await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(0)),
    {selloffAlerts:0,selloffEnabled:false});
  assert.equal(JSON.stringify(f.store.config),before);
  assert.equal(f.saves.length,0);
});

test('can deliberately share rug channel, without changing liquidity alerts',async()=>{
  const f=fixture({channel:RUG});
  const result=await updateLargeSelloffs(f.client,f.store,entries(f,market()),at(0));
  assert.equal(result.selloffAlerts,1);
  assert.equal(f.messages[0].path,'/channels/'+RUG+'/messages');
});

test('live selloff card includes true rolling window, buys/sells, chart and safety explanation',()=>{
  const pair=market({m5:0,h1:-39,h1buys:25,h1sells:75});
  const signal=detectLargeSelloff(pair);
  const embed=createSelloffAlertEmbed({chain:'solana',address:SOL,symbol:'DREAD'},pair,signal,new Date('2026-11-28T00:00:00Z'));
  assert.match(embed.description,/Price change \(1 hour\): \*\*-39\.00%\*\*/);
  assert.match(embed.description,/Buys: \*\*25\*\* · Sells: \*\*75\*\*/);
  assert.match(embed.description,/3\.00×/);
  assert.match(embed.description,/View chart/);
  assert.match(embed.footer.text,/not USD volume/i);
  assert.match(embed.footer.text,/Not proof of a rug/);
  assert.equal(embed.timestamp,'2026-11-28T00:00:00.000Z');
});

test('25 token configuration with independent channels and selloff timestamps round-trips',()=>{
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const tokens=Array.from({length:25},(_,i)=>({
    chain:'solana',address:SOL.slice(0,-1)+chars[i],symbol:'COIN'+i,
    h:42000+i,a:42000+i,t:1760000000,r:['pool'+i,22000,0.00001,1760000000,0],
    s:1790000000,
  }));
  const cfg={version:1,dashboardChannelId:DASH,rugChannelId:RUG,athChannelId:ATH,
    selloffChannelId:SELLOFF,tokens};
  const embed=createStorageEmbed(cfg);
  assert.ok(embed.description.length<=4096);
  assert.deepEqual(parseConfig({embeds:[embed]}),cfg);
  assert.deepEqual(parseConfig(serializeConfig(cfg)),cfg);
});

test('normal dashboard refresh reuses existing API response for selloff alerts',async()=>{
  const f=fixture();
  f.store.config.athChannelId=null;
  f.store.config.rugChannelId=null;
  f.client.request=async function(path,options={}) {
    if(path==='/channels/'+DATA+'/messages/'+STORE_MESSAGE && options.method==='PATCH')return {id:STORE_MESSAGE};
    if(path==='/channels/'+SELLOFF+'/messages' && options.method==='POST'){
      f.messages.push({path,body:options.body});return {id:'111111111111111111'};
    }
    if(path==='/channels/'+DASH+'/messages' && options.method==='POST')return {id:'222222222222222222'};
    throw Error('Unexpected '+path);
  };
  let lookups=0;
  const fetcher=async()=>{lookups++;return {ok:true,json:async()=>[market()]};};
  const result=await publishDashboard(f.client,f.store,{fetcher,now:at(0).now});
  assert.equal(lookups,1);
  assert.equal(result.selloffAlerts,1);
  assert.equal(result.selloffEnabled,true);
  assert.equal(f.messages.length,1);
});
