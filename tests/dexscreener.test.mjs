import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, selectBestPair, fetchTokenPair } from '../src/dexscreener.js';
import { createDashboardEmbeds, formatPrice, parseConfig, serializeConfig } from '../src/tracker.js';

const SOL = 'So11111111111111111111111111111111111111112';
const ETH = '0x0000000000000000000000000000000000000001';

test('validates Solana and EVM addresses and normalizes EVM case', () => {
  assert.deepEqual(normalizeToken('solana', SOL), { chain: 'solana', address: SOL });
  assert.deepEqual(normalizeToken('BASE', ETH.toUpperCase().replace('0X', '0x')), { chain: 'base', address: ETH });
  assert.deepEqual(normalizeToken('ronin', 'ronin:' + ETH.slice(2)), { chain: 'ronin', address: ETH });
  assert.throws(() => normalizeToken('solana', 'not-a-contract'), /Invalid/);
  assert.throws(() => normalizeToken('unknown', ETH), /Unsupported/);
});

test('selects highest-liquidity base token pair and rejects quote-token prices', () => {
  const base = { chainId: 'solana', baseToken: { address: SOL, symbol: 'SOL' }, priceUsd: '120', liquidity: { usd: 5000 } };
  const better = { ...base, priceUsd: '125', liquidity: { usd: 100000 } };
  const quoted = { ...base, baseToken: { address: 'other-token' }, quoteToken: { address: SOL }, priceUsd: '0.00001', liquidity: { usd: 999999 } };
  const res = selectBestPair([base, quoted, better], { chain: 'solana', address: SOL });
  assert.equal(res, better);
  assert.equal(selectBestPair([quoted], { chain: 'solana', address: SOL }), null);
});

test('fetches a free API pair without an API key', async () => {
  let url;
  const pair = await fetchTokenPair({ chain: 'solana', address: SOL }, async request => {
    url = request;
    return { ok: true, json: async () => [{ chainId: 'solana', baseToken: { address: SOL }, priceUsd: '140' }] };
  });
  assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/solana/${SOL}`);
  assert.equal(pair.priceUsd, '140');
});

test("safely formats prices without injection", function safePriceTest(){
 const e=createDashboardEmbeds([{
  token:{chain:'solana',address:SOL},
  pair:{baseToken:{symbol:'@everyone'},priceUsd:0.01,marketCap:550000,liquidity:{usd:15000},priceChange:{h24:-3.2,m5:1.5}}
 }],new Date('2026-11-23T00:00:00Z'));
 assert.equal(e.length,1);
 assert.match(e[0].description,/\$0\.01/);
 assert.match(e[0].description,/\*\*MC \$550\.00K\*\*/);
 assert.doesNotMatch(e[0].description,/@everyone/);
 assert.equal(e[0].timestamp,'2026-11-23T00:00:00.000Z');
});

test("serializes and restores legacy watchlists", function roundtripTest(){
 const config={version:1,dashboardChannelId:'123456789012345678',dashboardMessageId:null,tokens:[{chain:'solana',address:SOL}]};
 assert.deepEqual(parseConfig(serializeConfig(config)),config);
 assert.equal(parseConfig('ordinary Discord message'),null);
});

test("three tokens share one framed embed with semantic emojis and clickable charts", function frameTest(){
 const entries=[
 {token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},marketCap:29820,priceUsd:0.00003394,liquidity:{usd:11750},priceChange:{h24:16.76,m5:-3.9},url:'https://dexscreener.com/solana/dread'}},
 {token:{chain:'solana',address:'5kqi4kDq56H9UfHq14jXtmy189zpyxaYdXCQ4qHvDtHW'},pair:{baseToken:{symbol:'CoT'},marketCap:2320000,priceUsd:0.002318,liquidity:{usd:99830},priceChange:{h24:102,m5:-0.36}}},
 {token:{chain:'solana',address:'2Er88nn9W1pumpABCDEF1234567890abcdefghijkLMNO'},pair:{baseToken:{symbol:'REALM'},marketCap:14650,priceUsd:0.00001464,liquidity:{usd:null},priceChange:{h24:4.25,m5:null}}}
 ];
 const e=createDashboardEmbeds(entries);
 assert.equal(e.length,1);
 assert.equal(e[0].color,0x64748b);
 assert.equal(e[0].title,'📊 SpicyTracker · 3 tokens');
 assert.equal(e[0].description.split('├──────────────────────┤').length-1,2);
 assert.match(e[0].description,/^╭──────────────────────╮/);
 assert.match(e[0].description,/╰──────────────────────╯$/);
 assert.match(e[0].description,/🔥 \*\*DREAD\*\*/);
 assert.match(e[0].description,/🌊 \*\*CoT\*\*/);
 assert.match(e[0].description,/🏰 \*\*REALM\*\*/);
 assert.match(e[0].description,/💰 \*\*MC \$29\.82K\*\* · 📈 24h \*\*\+16\.76%\*\*/);
 assert.match(e[0].description,/⚡ 5m \*\*-3\.90%\*\*/);
 assert.match(e[0].description,/🏷️ CA `So111111…111112`/);
 assert.match(e[0].description,/\[Chart ↗\]\(https:\/\/dexscreener\.com\/solana\/dread\)/);
 assert.match(e[0].description,/💧 Liq \*\*N\/A\*\*/);
 assert.doesNotMatch(e[0].description,/🟢|🔴|⚪/);
});

test("one token has top and bottom frames without a middle divider", function oneTokenTest(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:{baseToken:{symbol:'DREAD'},priceUsd:1.2,marketCap:800000,priceChange:{h24:-5,m5:1}}}]);
 assert.equal(e.length,1);
 assert.equal(e[0].description.includes('├──────────────────────┤'),false);
 assert.match(e[0].description,/📉 24h \*\*-5\.00%\*\*/);
 assert.match(e[0].description,/⚡ 5m \*\*\+1\.00%\*\*/);
 assert.equal(e[0].description.startsWith('╭'),true);
 assert.equal(e[0].description.endsWith('╯'),true);
});

test("twelve tokens fit within Discord's 4096-character embed limit", function twelveTokenTest(){
 const poolId='1234567890abcdef'.repeat(6);
 const tokens=Array.from({length:12},(_,i)=>({token:{chain:'avalanche',address:'0x1234567890abcdef1234567890abcdef12345678'},pair:{baseToken:{symbol:'LONGTOKENNAME'+i},marketCap:345000,priceUsd:0.000000032547,liquidity:{usd:95000},priceChange:{h24:1.23,m5:-4.5},url:'https://dexscreener.com/avalanche/'+poolId}}));
 const e=createDashboardEmbeds(tokens);
 assert.equal(e.length,1);
 assert.equal(e[0].description.split('├──────────────────────┤').length-1,11);
 assert.equal(e[0].description.match(/│ 🏷️ CA `/g).length,12);
 assert.ok(e[0].description.length<=4096);
 assert.ok(JSON.stringify(e).length<6000);
 assert.equal(e[0].color,0x64748b);
});

test("missing pool keeps a named token and neutral border", function basicErrorTest(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:null,error:'timeout'}]);
 assert.match(e[0].description,/🔥 \*\*DREAD\*\*/);
 assert.match(e[0].description,/Market data unavailable/);
 assert.equal(e[0].color,0x64748b);
});

test("empty tracker remains a valid embed", function noTokensTest(){
 const e=createDashboardEmbeds([]);
 assert.equal(e.length,1);
 assert.match(e[0].description,/No tracked tokens/);
 assert.equal(e[0].title,'📊 SpicyTracker · 0 tokens');
});

test("FDV is labeled distinctly and neutral changes remain legible", function fdvTest(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:{baseToken:{symbol:'DREAD'},priceUsd:0.5,fdv:90000,priceChange:{h24:0,m5:-0.5}}}]);
 assert.match(e[0].description,/\*\*FDV \$90\.00K\*\*/);
 assert.match(e[0].description,/📊 24h \*\*0\.00%\*\*/);
 assert.match(e[0].description,/⚡ 5m \*\*-0\.50%\*\*/);
});

test("zero liquidity remains zero rather than unavailable", function zeroLiquidityTest(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:{baseToken:{symbol:'DREAD'},priceUsd:0.5,marketCap:90000,liquidity:{usd:0}}}]);
 assert.match(e[0].description,/💧 Liq \*\*\$0\*\*/);
});
