import test from 'node:test';
import assert from 'node:assert/strict';
import { updateObservedHighs, createHighAlertEmbed, createDashboardEmbeds, parseConfig, serializeConfig, createStorageEmbed } from '../src/tracker.js';
import { executeTrackerCommand } from '../src/commands.js';
import { editInteractionResponse } from '../src/discord.js';

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
  assert.match(body.embeds[0].description,/\$1\.50K/);
  assert.match(body.embeds[0].description,/\$1\.00K/);
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
test('minimum gain and 30-minute cooldown prevent repeating small highs',async()=>{
  const f=fixture({baseline:100,minPct:5});
  const at=(iso)=>({now:()=>new Date(iso)});
  await updateObservedHighs(f.client,f.store,sample(f.store,103),at('2026-11-23T00:00:00Z'));
  assert.equal(f.posted.length,0);
  await updateObservedHighs(f.client,f.store,sample(f.store,106),at('2026-11-23T00:01:00Z'));
  assert.equal(f.posted.length,1);
  await updateObservedHighs(f.client,f.store,sample(f.store,112),at('2026-11-23T00:02:00Z'));
  assert.equal(f.posted.length,1);
  assert.equal(f.store.config.tokens[0].h,112);
  assert.equal(f.store.config.tokens[0].a,106);
  await updateObservedHighs(f.client,f.store,sample(f.store,113),at('2026-11-23T00:32:00Z'));
  assert.equal(f.posted.length,2);
  assert.equal(f.store.config.tokens[0].t,Math.floor(Date.parse('2026-11-23T00:32:00Z')/1000));
});
test('configured zero percent still enforces effective five-percent minimum',async()=>{
  const f=fixture({baseline:100,minPct:0});
  await updateObservedHighs(f.client,f.store,sample(f.store,104));
  assert.equal(f.posted.length,0);
  assert.equal(f.store.config.tokens[0].h,104);
  await updateObservedHighs(f.client,f.store,sample(f.store,106));
  assert.equal(f.posted.length,1);
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
test('ATH preview and real notification produce the EXACT same Discord embed',()=>{
  const token={chain:'solana',address:SOL,symbol:'DREAD',h:120000,a:120000};
  const pair={baseToken:{symbol:'DREAD'},priceUsd:'0.004',marketCap:125000,url:'https://dexscreener.com/solana/demo'};
  const clock=new Date('2026-11-23T01:02:00Z');
  const previous=100000, current=125000;
  const live=createHighAlertEmbed(token,pair,previous,current,clock);
  const simulation=createHighAlertEmbed(token,pair,previous,current,clock);
  assert.deepEqual(simulation,live);
  assert.equal(live.title,'New market-cap high');
  assert.equal(live.color,0x22c55e);
  assert.match(live.description,/\$125\.00K/);
  assert.match(live.description,/\+25\.00%/);
  assert.match(live.footer.text,/Not verified lifetime ATH/);
  assert.doesNotMatch(JSON.stringify(live),/PREVIEW|TEST ONLY|Simulated|No changes saved/i);
  assert.equal(token.h,120000);
  assert.equal(token.a,120000);
});

test('compact dashboard separates tokens without attaching separators to headings',()=>{
  const tokenA={chain:'solana',address:SOL,symbol:'DREAD'};
  const tokenB={chain:'base',address:'0x'+'a'.repeat(40),symbol:'MOON'};
  const entries=[{
    token:tokenA,
    pair:{baseToken:{symbol:'DREAD'},marketCap:120000,priceUsd:0.004,
      liquidity:{usd:5000},priceChange:{h24:8,m5:-2},
      url:'https://dexscreener.com/solana/demo'}
  },{
    token:tokenB,
    pair:{baseToken:{symbol:'MOON'},marketCap:32000,priceUsd:0.006,
      liquidity:{usd:4000},priceChange:{h24:-3,m5:1},
      url:'https://dexscreener.com/base/demo'}
  }];
  const card=createDashboardEmbeds(entries)[0];
  assert.equal(card.fields,undefined);
  assert.equal(card.title,undefined);
  const description=card.description;
  assert.ok(description.startsWith('**2 tracked tokens** · Live DEX markets\n\n────────────\n**DREAD** · SOLANA'));
  assert.ok(description.endsWith('\n\n────────────'));
  assert.match(description,/^\*\*DREAD\*\* · SOLANA$/m);
  assert.match(description,/^\*\*MOON\*\* · BASE$/m);
  assert.match(description,/CA \x60[^\x60]+\x60\n\n────────────\n\*\*MOON\*\* · BASE/);
  assert.match(description,/\*\*MC \$120\.00K\*\*/);
  assert.match(description,/🟩 \+8\.00%/);
  assert.match(description,/🟥 -2\.00%/);
  assert.match(description,/\[View chart\]\(https:\/\/dexscreener\.com\/solana\/demo\)/);
  assert.doesNotMatch(description,/──── \*\*|\x60{3}ansi/);
  assert.equal(description.split('────────────').length-1,3);
  assert.ok(description.split('────────────').every((segment,index)=>index===0 || !segment.startsWith('\n\n')));
});

test('twelve tokens fit in one compact embed with starting, between-token and ending separators',()=>{
  const entries=Array.from({length:12},(_,i)=>({
    token:{chain:'solana',symbol:'COIN'+i,address:SOL.slice(0,-2)+String(i).padStart(2,'0')},
    pair:{baseToken:{symbol:'COIN'+i},marketCap:123456789,priceUsd:0.000123,
      liquidity:{usd:600000},priceChange:{h24:12,m5:-3},
      url:'https://dexscreener.com/solana/'+'a'.repeat(52)}
  }));
  const card=createDashboardEmbeds(entries)[0];
  assert.equal(card.fields,undefined);
  assert.equal(card.title,undefined);
  assert.equal(card.description.split('────────────').length-1,13);
  assert.ok(card.description.startsWith('**12 tracked tokens** · Live DEX markets\n\n────────────\n'));
  assert.ok(card.description.endsWith('\n\n────────────'));
  assert.ok(card.description.length<=4096);
});

test('ATH preview posts and displays the exact live alert embed, with no preview-only text',async()=>{
  const guild='923456789012345678';
  const token={chain:'solana',address:SOL,symbol:'DREAD',h:100000,a:100000};
  const cfg={version:1,dashboardChannelId:DASH,dashboardMessageId:null,
    athChannelId:ALERT,athMinPct:0,tokens:[token]};
  const posted=[];
  const pairs=[{chainId:'solana',baseToken:{symbol:'DREAD',address:SOL},
    priceUsd:'0.004',marketCap:125000,liquidity:{usd:12000},url:'https://dexscreener.com/solana/demo'}];
  const client={async request(path,opts={}){
    if(path==='/guilds/'+guild+'/channels')return [
      {id:STORE,name:'crypto-tracker-data',type:0},
      {id:ALERT,name:'ath-alerts',type:0},
    ];
    if(path==='/channels/'+STORE+'/messages?limit=100')
      return [{id:MSG,embeds:[createStorageEmbed(cfg)]}];
    if(path==='/channels/'+ALERT+'/messages' && opts.method==='POST'){
      posted.push(opts.body);return {id:'999456789012345678'};
    }
    throw new Error('Unexpected Discord call '+path);
  }};
  const response=await executeTrackerCommand({
    interaction:{guild_id:guild,channel_id:DASH,member:{permissions:'32'},
      data:{options:[{name:'ath-preview',options:[{name:'increase',value:25}]}]}},
    client,fetcher:async()=>({ok:true,json:async()=>pairs}),
  });
  assert.equal(posted.length,1);
  assert.deepEqual(response,{embeds:posted[0].embeds});
  assert.deepEqual(posted[0].allowed_mentions,{parse:[]});
  assert.doesNotMatch(JSON.stringify(response),/preview|test only|simulated|no changes saved/i);
  const hypotheticalPair={...pairs[0],marketCap:156250,priceUsd:0.005};
  const exactLive=createHighAlertEmbed(token,hypotheticalPair,125000,156250,new Date(response.embeds[0].timestamp));
  assert.match(response.embeds[0].description,/\$156\.25K/);
  assert.deepEqual(response.embeds[0],exactLive);
  assert.equal(cfg.tokens[0].h,100000);
  assert.equal(cfg.tokens[0].a,100000);

  let patchBody;
  await editInteractionResponse('123456789012345678','interaction-token',response,
    async (_url,init)=>{patchBody=JSON.parse(init.body);return {ok:true};});
  assert.deepEqual(patchBody.embeds,posted[0].embeds);
  assert.equal(patchBody.content,'');
  assert.deepEqual(patchBody.allowed_mentions,{parse:[]});
});

test('manually recorded $48.7K ATH blocks false new-high alerts until a meaningful breakout',async()=>{
  const f=fixture({baseline:31000,minPct:0});
  f.store.config.tokens[0].b=48700;
  await updateObservedHighs(f.client,f.store,sample(f.store,40000),{now:()=>new Date('2026-11-23T00:00:00Z')});
  assert.equal(f.posted.length,0);
  await updateObservedHighs(f.client,f.store,sample(f.store,49000),{now:()=>new Date('2026-11-23T00:01:00Z')});
  assert.equal(f.posted.length,0);
  await updateObservedHighs(f.client,f.store,sample(f.store,52000),{now:()=>new Date('2026-11-23T00:02:00Z')});
  assert.equal(f.posted.length,1);
  assert.match(f.posted[0].embeds[0].description,/\$48\.70K/);
  assert.match(f.posted[0].embeds[0].description,/\$52\.00K/);
  assert.match(f.posted[0].embeds[0].footer.text,/manually recorded/i);
});
test('DREAD simulation uses historical $48.7K, not current $31K, without mutating records',async()=>{
  const guild='923456789012345678';
  const token={chain:'solana',address:SOL,symbol:'DREAD',h:31000,a:31000,b:48700};
  const cfg={version:1,dashboardChannelId:DASH,athChannelId:ALERT,tokens:[token]};
  const posted=[];
  const client={async request(path,opts={}){
    if(path==='/guilds/'+guild+'/channels')return [{id:STORE,name:'crypto-tracker-data',type:0},{id:ALERT,type:0}];
    if(path==='/channels/'+STORE+'/messages?limit=100')return [{id:MSG,embeds:[createStorageEmbed(cfg)]}];
    if(path==='/channels/'+ALERT+'/messages'&&opts.method==='POST'){posted.push(opts.body);return {id:'999456789012345678'};}
    throw Error('Unexpected Discord call '+path);
  }};
  const response=await executeTrackerCommand({
    interaction:{guild_id:guild,channel_id:DASH,member:{permissions:'32'},
      data:{options:[{name:'ath-preview',options:[{name:'increase',value:15}]}]}},
    client,fetcher:async()=>({ok:true,json:async()=>[
      {chainId:'solana',baseToken:{address:SOL,symbol:'DREAD'},marketCap:31000,
       priceUsd:'0.000035',liquidity:{usd:11970}}
    ]}),
  });
  assert.deepEqual(response.embeds,posted[0].embeds);
  assert.match(response.embeds[0].description,/\$48\.70K/);
  assert.match(response.embeds[0].description,/\$56\.01K/);
  assert.match(response.embeds[0].description,/\+15\.00%/);
  assert.equal(token.h,31000);
  assert.equal(token.b,48700);
});

test('twelve tokens can store manual ATHs and cooldown timestamps within embed limits',()=>{
  const config={version:1,dashboardChannelId:DASH,dashboardMessageId:MSG,
    athChannelId:ALERT,athMinPct:5,cv:4,
    tokens:Array.from({length:12},(_,i)=>({
      chain:'solana',address:SOL.slice(0,-2)+String(i).padStart(2,'0'),
      symbol:'LONGSYMBOLFORCOINTESTXXX',
      h:123456789.12,a:123456789.12,b:123456789.12,t:1795387904,
    }))};
  const serialized=serializeConfig(config);
  assert.ok(serialized.length>2000);
  assert.ok(serialized.length<=3000);
  assert.equal(parseConfig(serialized)?.tokens.length,12);
  assert.ok(createStorageEmbed(config).description.length<=4096);
});
