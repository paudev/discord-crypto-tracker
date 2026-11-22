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

test('formats token prices without unsafe mentions', function testSafe(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'@everyone'},priceUsd:'0.01',marketCap:550000,liquidity:{usd:15000},priceChange:{h24:-3.2,m5:1.5},url:'https://dexscreener.com/solana/abc'}}],new Date('2026-11-23T00:00:00Z'));
 assert.equal(e.length,1);
 assert.match(e[0].description,/\$0\.01/);
 assert.match(e[0].description,/\*\*MC \$550\.00K\*\*/);
 assert.doesNotMatch(e[0].description,/@everyone/);
 assert.equal(e[0].timestamp,'2026-11-23T00:00:00.000Z');
});

test('serializes and restores Discord watchlists', function testRoundtrip(){
 const cfg={version:1,dashboardChannelId:'123456789012345678',dashboardMessageId:null,tokens:[{chain:'solana',address:SOL}]};
 assert.deepEqual(parseConfig(serializeConfig(cfg)),cfg);
 assert.equal(parseConfig('hello'),null);
});

test('single card prioritizes MC and has no colored circles', function testCompact(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},priceUsd:'0.00004431',marketCap:38940,liquidity:{usd:13610},priceChange:{h24:52.45},url:'https://dexscreener.com/solana/abc'}}]);
 assert.equal(e.length,1);
 assert.equal(e[0].title,'SpicyTracker · 1 token');
 assert.equal(e[0].color,0xf43f5e);
 assert.equal(e[0].author,undefined);
 const d=e[0].description;
 assert.match(d,/\*\*DREAD\*\* · SOLANA/);
 assert.ok(d.split('\n').includes('**MC $38.94K**  ·  24h **↗ +52.45%**'));
 assert.match(d,/Price \*\*\$0\.00004431\*\*.*Liq \*\*\$13\.61K\*\*/);
 assert.ok(d.includes('5m —'));
 assert.doesNotMatch(d,/[🟢🔴⚪]/u);
 assert.match(d,/\[Chart ↗\]\(https:\/\/dexscreener\.com\/solana\/abc\)/);
});

test('two tokens appear in the same colored card with one light separator', function testUnison(){
 const entries=[
  {token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:{baseToken:{symbol:'DREAD'},marketCap:38940,priceUsd:'0.00004431',priceChange:{h24:10}}},
  {token:{chain:'base',address:ETH,symbol:'CoT'},pair:{baseToken:{symbol:'CoT'},marketCap:2320000,priceUsd:'0.023',priceChange:{h24:-2}}}
 ];
 const e=createDashboardEmbeds(entries);
 assert.equal(e.length,1);
 assert.equal(e[0].color,0xf43f5e);
 assert.equal(e[0].title,'SpicyTracker · 2 tokens');
 const content=e[0].description;
 assert.equal(content.split('────────────────────').length-1,1);
 assert.match(content,/DREAD/);assert.match(content,/CoT/);
 assert.match(content,/↗ \+10\.00%/);assert.match(content,/↘ -2\.00%/);
 assert.match(content,/MC \$38\.94K/);assert.match(content,/MC \$2\.32M/);
});

test('all twelve tracked tokens fit in a single embed', function testTwelve(){
 const entries=Array.from({length:12},(_,i)=>({token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'T'+i},priceUsd:'0.01',marketCap:20000+i,priceChange:{h24:i%2?-1:1}}}));
 const e=createDashboardEmbeds(entries);
 assert.equal(e.length,1);
 assert.equal(e[0].description.split('────────────────────').length-1,11);
 assert.equal(e[0].description.match(/\*\*T\d+\*\*/g).length,12);
 assert.ok(e[0].description.length<=4096);
 assert.ok(JSON.stringify(e).length<=6000);
});

test('empty watchlists remain readable', function testNoData(){
 const e=createDashboardEmbeds([]);
 assert.equal(e.length,1);
 assert.match(e[0].description,/No tracked tokens/);
 assert.equal(e[0].title,'SpicyTracker · 0 tokens');
});

test('FDV fallback is clearly distinguished from MC', function testFDV(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:{baseToken:{symbol:'DREAD'},priceUsd:0.5,fdv:90000,priceChange:{m5:-0.5}}}]);
 assert.match(e[0].description,/\*\*FDV \$90\.00K\*\*/);
 assert.match(e[0].description,/5m ↘ -0\.50%/);
});

test('unavailable pools retain token symbols', function testFallback(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:null,error:'timeout'}]);
 assert.equal(e.length,1);
 assert.match(e[0].description,/DREAD/);
 assert.match(e[0].description,/Market data unavailable/);
});
