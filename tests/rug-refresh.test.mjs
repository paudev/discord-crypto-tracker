import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/rug-refresh.js';
import { serializeConfig } from '../src/tracker.js';

const GUILD = '123456789012345678';
const STORAGE = '423456789012345678';
const STORAGE_MESSAGE = '523456789012345678';
const DASH = '723456789012345678';
const RUG = '823456789012345678';
const SOL = 'So11111111111111111111111111111111111111112';

function mockResponse() {
  return {
    statusCode: 200, headers: {}, result: null,
    setHeader(name,value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.result = value; return this; },
  };
}

test('rug-only endpoint rejects GET and missing/invalid credentials',async()=>{
  const previous=process.env.REFRESH_SECRET;
  process.env.REFRESH_SECRET='example-super-secret-value-12345';
  try {
    const get=mockResponse();
    await handler({ method:'GET',headers:{} },get);
    assert.equal(get.statusCode,405);
    const noBearer=mockResponse();
    await handler({ method:'POST',headers:{} },noBearer);
    assert.equal(noBearer.statusCode,401);
    const wrong=mockResponse();
    await handler({ method:'POST',headers:{authorization:'Bearer wrong-secret'} },wrong);
    assert.equal(wrong.statusCode,401);
  } finally {
    if(previous===undefined)delete process.env.REFRESH_SECRET;
    else process.env.REFRESH_SECRET=previous;
  }
});

test('extra rug poll reads and updates baselines but never edits dashboard/ATH',async()=>{
  const priorEnv=Object.fromEntries(['REFRESH_SECRET','DISCORD_BOT_TOKEN','DISCORD_GUILD_ID']
    .map(key=>[key,process.env[key]]));
  const priorFetch=globalThis.fetch;
  const requests=[];
  const config={version:1,dashboardChannelId:DASH,dashboardMessageId:null,
    rugChannelId:RUG,athChannelId:null,tokens:[{chain:'solana',address:SOL,symbol:'DREAD'}]};
  process.env.REFRESH_SECRET='example-super-secret-value-12345';
  process.env.DISCORD_BOT_TOKEN='dummy-test-token';
  process.env.DISCORD_GUILD_ID=GUILD;
  globalThis.fetch=async(url,options={})=>{
    const address=String(url).replace('https://discord.com/api/v10','');
    requests.push({url:String(url),method:options.method||'GET'});
    const data=(payload,status=200)=>({ok:status===200,status,
      json:async()=>payload,headers:{get:()=>null}});
    if(address==='/guilds/'+GUILD+'/channels')return data([
      {id:STORAGE,name:'crypto-tracker-data',type:0,topic:'[SpicyTracker storage]'},
    ]);
    if(address==='/channels/'+STORAGE+'/messages?limit=100')return data([
      {id:STORAGE_MESSAGE,content:serializeConfig(config)},
    ]);
    if(address.startsWith('/channels/'+STORAGE+'/messages/')&&options.method==='PATCH')return data({id:STORAGE_MESSAGE});
    if(String(url).startsWith('https://api.dexscreener.com/token-pairs/v1/solana/'))return data([
      {chainId:'solana',pairAddress:'SolanaPool123',
        baseToken:{address:SOL,symbol:'DREAD'},priceUsd:'0.0012',marketCap:12000,
        liquidity:{usd:12000},url:'https://dexscreener.com/solana/demo'},
    ]);
    throw Error('Unexpected request '+options.method+' '+url);
  };
  try{
    const res=mockResponse();
    await handler({method:'POST',headers:{
      authorization:'Bearer example-super-secret-value-12345',
    }},res);
    assert.equal(res.statusCode,200);
    assert.equal(res.result.rugEnabled,true);
    assert.equal(res.result.tokens,1);
    assert.equal(res.result.rugAlerts,0);
    assert.equal(requests.filter(x=>x.url.includes('/channels/'+STORAGE+'/messages/'+STORAGE_MESSAGE) && x.method==='PATCH').length,1);
    assert.equal(requests.filter(x=>x.url.includes('/channels/'+DASH+'/messages')).length,0);
    assert.equal(requests.filter(x=>x.url.includes('/channels/'+RUG+'/messages')).length,0);
  }finally{
    globalThis.fetch=priorFetch;
    for(const [k,v] of Object.entries(priorEnv)){
      if(v===undefined)delete process.env[k];
      else process.env[k]=v;
    }
  }
});
