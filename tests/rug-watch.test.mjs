import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPairs } from '../src/dexscreener.js';
import { createDashboardPages, createStorageEmbed, parseConfig, publishDashboard,
  serializeConfig, updateRugWatch } from '../src/tracker.js';

const SOL = 'So11111111111111111111111111111111111111112';
const CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const STORE = '423456789012345678', MSG = '523456789012345678';
const DASH = '723456789012345678', RUG = '823456789012345678';

function tokens25() {
  return Array.from({length: 25}, (_, i) => ({
    chain: 'solana', address: SOL.slice(0, -1) + CHARS[i], symbol: 'TOKEN' + i,
    h: 100000 + i, a: 100000 + i, b: 150000 + i, t: 1764000000,
    r: ['pool_' + i, 12000, 0.0002, 1764000000, 0],
  }));
}
function pairs(tokens) {
  return tokens.map(token => ({
    chainId: token.chain, pairAddress: 'pool_' + token.symbol,
    baseToken: { address: token.address, symbol: token.symbol },
    priceUsd: '0.0002', marketCap: 100000, liquidity: { usd: 12000 },
    priceChange: { h24: 10, m5: -2 },
    url: 'https://dexscreener.com/solana/' + token.address,
  }));
}
function fixture(tokens = [{chain:'solana',address:SOL,symbol:'DREAD'}]) {
  const stored = {version:1,dashboardChannelId:DASH,dashboardMessageId:null,
    athChannelId:null,rugChannelId:RUG,tokens};
  const store = {config:stored,configChannelId:STORE,configMessageId:MSG};
  const sent=[],edited=[],deleted=[];
  let nextId=900000000000000000n, failRug=false;
  const client={async request(path,options={}){
    if(path==='/channels/'+STORE+'/messages/'+MSG && options.method==='PATCH') return {id:MSG};
    if(path==='/channels/'+RUG+'/messages' && options.method==='POST') {
      if(failRug)throw Error('Discord denied send');
      sent.push(options.body); return {id:String(++nextId)};
    }
    if(path==='/channels/'+DASH+'/messages' && options.method==='POST') {
      sent.push(options.body); return {id:String(++nextId)};
    }
    if(path.startsWith('/channels/'+DASH+'/messages/') && options.method==='PATCH') {
      edited.push(options.body); return {id:path.split('/').at(-1)};
    }
    if(path.startsWith('/channels/'+DASH+'/messages/') && options.method==='DELETE') {
      deleted.push(path); return {};
    }
    throw Error('Unexpected request '+path+' ('+options.method+')');
  }};
  return {client,store,sent,edited,deleted,setFail(v){failRug=v}};
}

test('25 token config compresses, round-trips highs and rug baselines and fits storage', () => {
  const tokens=tokens25(), config={version:1,dashboardChannelId:DASH,athChannelId:RUG,
    rugChannelId:RUG,dashboardMessageId:DASH,dashboardMessageIds:[DASH,MSG,RUG],tokens};
  const text=serializeConfig(config);
  assert.match(text,/CRYPTO_TRACKER_CONFIG_V1\nz:/);
  assert.ok(text.length<=5500);
  assert.deepEqual(parseConfig(text),config);
  const embed=createStorageEmbed(config);
  assert.ok(embed.description.length<=4096);
  assert.equal(parseConfig({embeds:[embed]})?.tokens.length,25);
  assert.match(embed.description,/Use \/tracker list/);
});
test('25 tokens are batched into one network request per chain',async()=>{
  const tokens=tokens25();
  let calls=0;
  const result=await fetchAllPairs(tokens,async url=>{
    calls++;
    assert.match(url,/\/tokens\/v1\/solana\//);
    assert.equal(url.split(',').length,25);
    return {ok:true,json:async()=>pairs(tokens)};
  });
  assert.equal(calls,1);
  assert.equal(result.length,25);
  assert.equal(result.filter(x=>x.pair).length,25);
  assert.equal(result[24].pair.baseToken.address,tokens[24].address);
});
test('batched API failure is marked unavailable, never fabricated as a rug',async()=>{
  const tokens=tokens25();
  const results=await fetchAllPairs(tokens,async()=>({ok:false,status:429}));
  assert.equal(results.length,25);
  assert.equal(results.every(x=>x.pair===null && x.error.includes('429')),true);
});
test('25 token dashboard creates three pages with intact per-token borders',()=>{
  const tokens=tokens25(), market=pairs(tokens);
  const entries=tokens.map((token,i)=>({token,pair:market[i]}));
  const pages=createDashboardPages(entries);
  assert.equal(pages.length,3);
  for(const [i,page] of pages.entries()){
    const d=page[0].description;
    assert.ok(d.length<=4096);
    assert.match(d,new RegExp('25 tracked tokens.*'+(i+1)+'/3'));
    assert.match(d,/────────────────────────────/);
    assert.doesNotMatch(d,/\x60{3}ansi/);
  }
  assert.equal(createDashboardPages(entries.slice(0,12)).length,1);
});
test('publishing 25 tokens creates three stable messages and removes stale extras',async()=>{
  const tokens=tokens25();
  for(const token of tokens){delete token.r;delete token.h;delete token.a;delete token.t;delete token.b;}
  const f=fixture(tokens);
  f.store.config.rugChannelId=null;
  const fetcher=async()=>({ok:true,json:async()=>pairs(tokens)});
  const first=await publishDashboard(f.client,f.store,{fetcher});
  assert.equal(first.pages,3);
  assert.equal(first.created,true);
  assert.equal(f.store.config.dashboardMessageIds.length,3);
  const second=await publishDashboard(f.client,f.store,{fetcher});
  assert.equal(second.pages,3);
  assert.equal(second.created,false);
  assert.equal(f.edited.length,3);
  f.store.config.tokens=tokens.slice(0,3);
  const third=await publishDashboard(f.client,f.store,{fetcher});
  assert.equal(third.pages,1);
  assert.equal(f.deleted.length,2);
  assert.equal(f.store.config.dashboardMessageIds,undefined);
});
function sample(token, {liq=12000,price=0.004,pool='pool_same'}={}){
  return [{token,pair:{pairAddress:pool,baseToken:{symbol:'DREAD'},
    priceUsd:price,marketCap:30000,liquidity:{usd:liq},
    url:'https://dexscreener.com/solana/demo'}}];
}
test('rug watch samples first, alerts after 70% liquidity and 50% price collapse',async()=>{
  const f=fixture(), token=f.store.config.tokens[0];
  const time=s=>({now:()=>new Date('2026-11-26T00:'+s+':00Z')});
  const first=await updateRugWatch(f.client,f.store,sample(token),time('00'));
  assert.equal(first.rugAlerts,0);
  const second=await updateRugWatch(f.client,f.store,sample(token,{liq:2500,price:0.001}),time('01'));
  assert.equal(second.rugAlerts,1);
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].embeds[0].title,/Suspected rug/);
  assert.match(f.sent[0].embeds[0].footer.text,/Not proof of fraud/);
  assert.deepEqual(f.sent[0].allowed_mentions.parse,[]);
  await updateRugWatch(f.client,f.store,sample(token,{liq:10,price:0.00001}),time('02'));
  assert.equal(f.sent.length,1);
});
test('95% liquidity loss alone triggers when the pool is unchanged and baseline was healthy',async()=>{
  const f=fixture(),t=f.store.config.tokens[0];
  await updateRugWatch(f.client,f.store,sample(t),{now:()=>new Date('2026-11-26T00:00:00Z')});
  const r=await updateRugWatch(f.client,f.store,sample(t,{liq:400,price:0.004}),{now:()=>new Date('2026-11-26T00:01:00Z')});
  assert.equal(r.rugAlerts,1);
});
test('missing pools, stale samples and pool migrations never cause rug alerts',async()=>{
  const f=fixture(),t=f.store.config.tokens[0];
  const now=s=>({now:()=>new Date('2026-11-26T00:'+s+':00Z')});
  await updateRugWatch(f.client,f.store,sample(t),now('00'));
  await updateRugWatch(f.client,f.store,[{token:t,pair:null,error:'429'}],now('01'));
  await updateRugWatch(f.client,f.store,sample(t,{liq:200,price:0.0001,pool:'new_pool'}),now('02'));
  assert.equal(f.sent.length,0);
  await updateRugWatch(f.client,f.store,sample(t,{liq:12000,price:0.004}),now('03'));
  await updateRugWatch(f.client,f.store,sample(t,{liq:200,price:0.0001}),now('25'));
  assert.equal(f.sent.length,0);
});
test('failed rug alert preserves prior baseline for retry',async()=>{
  const f=fixture(),t=f.store.config.tokens[0];
  const time=s=>({now:()=>new Date('2026-11-26T00:'+s+':00Z')});
  await updateRugWatch(f.client,f.store,sample(t),time('00'));
  f.setFail(true);
  const old=console.error; console.error=()=>{};
  try {
    const fail=await updateRugWatch(f.client,f.store,sample(t,{liq:100,price:0.0001}),time('01'));
    assert.equal(fail.rugAlerts,0);
  } finally { console.error=old; }
  f.setFail(false);
  const retry=await updateRugWatch(f.client,f.store,sample(t,{liq:100,price:0.0001}),time('02'));
  assert.equal(retry.rugAlerts,1);
});


test('high-entropy 25-token configuration survives multi-field private storage',()=>{
  let seed=742390;
  const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const randText=n=>Array.from({length:n},()=>chars[Math.floor(rng()*chars.length)]).join('');
  const tokens=Array.from({length:25},(_,i)=>({
    chain:'solana',address:randText(44),symbol:randText(24),
    h:rng()*1e11,a:rng()*1e11,b:rng()*1e11,t:1000000000+Math.floor(rng()*9e8),
    r:[randText(16),Math.round(rng()*1e7*100)/100,Number(rng().toPrecision(9)),
      1000000000+Math.floor(rng()*9e8),1000000000+Math.floor(rng()*9e8)],
  }));
  const config={version:1,dashboardChannelId:DASH,dashboardMessageId:DASH,
    dashboardMessageIds:[DASH,MSG,RUG],athChannelId:RUG,rugChannelId:RUG,cv:6,tokens};
  const embed=createStorageEmbed(config);
  assert.ok(Array.isArray(embed.fields) && embed.fields.length>0);
  assert.ok(embed.description.length<=4096);
  const total=embed.title.length+embed.description.length+embed.footer.text.length+
    embed.fields.reduce((sum,field)=>sum+field.name.length+field.value.length,0);
  assert.ok(total<=6000);
  assert.deepEqual(parseConfig({embeds:[embed]}),config);
});


test('liquidity drains across several minute samples trigger from the 15-minute baseline',async()=>{
  const f=fixture(),token=f.store.config.tokens[0];
  const time=minute=>({now:()=>new Date('2026-11-26T00:'+minute+':00Z')});
  await updateRugWatch(f.client,f.store,sample(token,{liq:12000,price:0.004}),time('00'));
  await updateRugWatch(f.client,f.store,sample(token,{liq:9500,price:0.003}),time('05'));
  await updateRugWatch(f.client,f.store,sample(token,{liq:6000,price:0.002}),time('09'));
  const result=await updateRugWatch(f.client,f.store,sample(token,{liq:3400,price:0.0008}),time('12'));
  assert.equal(result.rugAlerts,1);
  assert.equal(f.sent.length,1);
});
