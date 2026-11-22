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

test('formats safe prices without mention injection', function testTiny(){
 assert.match(formatPrice(0.00000001435),/1\.435/);
 const es=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'@everyone'},priceUsd:'0.01',marketCap:550000,liquidity:{usd:15000},priceChange:{h24:-3.2,m5:1.5},url:'https://dexscreener.com/solana/abc'}}],new Date('2026-11-23T00:00:00Z'));
 assert.equal(es.length,1);assert.match(es[0].description,/\$0\.01/);
 assert.match(es[0].description,/\*\*MC: \$550\.00K\*\*/);
 assert.doesNotMatch(es[0].title,/@everyone/);
 assert.equal(es[0].color,0xe74c3c);
 assert.equal(es[0].timestamp,'2026-11-23T00:00:00.000Z');
});

test('serializes and restores Discord-persisted configuration', function testConfig(){
 const config={version:1,dashboardChannelId:'123456789012345678',dashboardMessageId:null,tokens:[{chain:'solana',address:SOL}]};
 assert.deepEqual(parseConfig(serializeConfig(config)),config);
 assert.equal(parseConfig('ordinary chat'),null);
});

test('market cap is inline and token has colored border without colored circles', function testCap(){
 const es=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},priceUsd:'0.00004431',marketCap:38940,liquidity:{usd:13610},priceChange:{h24:52.45},url:'https://dexscreener.com/solana/abc'}}]);
 assert.equal(es.length,1);
 assert.equal(es[0].title,'DREAD · SOLANA');
 assert.equal(es[0].color,0x2ecc71);
 assert.ok(es[0].description.split('\n').includes('**MC: $38.94K**'));
 assert.ok(es[0].description.includes('Price **$0.00004431**'));
 assert.ok(es[0].description.includes('24h **+52.45%**'));
 assert.ok(es[0].description.includes('5m **—**'));
 assert.doesNotMatch(es[0].description,/[🟢🔴⚪]/u);
 assert.ok(es[0].description.includes('So111111…111112'));
});

test('falling price uses red embed accent and signed percentages', function testRed(){
 const es=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DOWN'},marketCap:22000,priceUsd:'1.2',priceChange:{h24:-10.2,m5:-0.3}}}]);
 assert.equal(es[0].color,0xe74c3c);
 assert.ok(es[0].description.includes('24h **-10.20%**'));
 assert.ok(es[0].description.includes('5m **-0.30%**'));
});

test('two tokens get separate green and red embeds in the same message', function testTwo(){
 const es=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},marketCap:38940,priceUsd:0.001,priceChange:{h24:6}}},{token:{chain:'base',address:ETH},pair:{baseToken:{symbol:'CoT'},marketCap:2320000,priceUsd:0.023,priceChange:{h24:-2}}}]);
 assert.equal(es.length,2);
 assert.equal(es[0].color,0x2ecc71);
 assert.equal(es[1].color,0xe74c3c);
 assert.match(es[0].description,/MC: \$38\.94K/);
 assert.match(es[1].description,/MC: \$2\.32M/);
 assert.equal(es[1].footer.text.includes('DEX Screener'),true);
});

test('twelve tokens use at most ten embeds and preserve every symbol', function testTwelve(){
 const entries=Array.from({length:12},(_,i)=>({token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'T'+i},marketCap:20000+i,priceUsd:'0.01',priceChange:{h24:i%2?-1:1}}}));
 const es=createDashboardEmbeds(entries);
 assert.equal(es.length,10);
 assert.ok(es.every(x=>x.description.length<=4096));
 assert.ok(es.reduce((sum,e)=>sum+e.title.length+e.description.length+(e.footer?.text.length??0),0)<6000);
 assert.match(es[0].title,/T0/);
 assert.match(es[8].description,/T8/);
 assert.match(es[8].description,/T9/);
 assert.match(es[9].description,/T10/);
 assert.match(es[9].description,/T11/);
});

test('eleven tokens group final pair into tenth embed', function testEleven(){
 const entries=Array.from({length:11},(_,i)=>({token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'T'+i},marketCap:20000+i,priceUsd:'0.01'}}));
 const es=createDashboardEmbeds(entries);
 assert.equal(es.length,10);
 assert.match(es[9].description,/T9/);
 assert.match(es[9].description,/T10/);
});

test('empty watchlist remains a valid embed', function testEmpty(){
 const es=createDashboardEmbeds([]);
 assert.equal(es.length,1);
 assert.match(es[0].description,/No tracked tokens/);
 assert.equal(es[0].color,0x5865f2);
});

test('missing pool uses stored token symbol and neutral border', function testFallback(){
 const es=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'DREAD'},pair:null,error:'timeout'}]);
 assert.equal(es[0].title,'DREAD · SOLANA');
 assert.match(es[0].description,/Market data unavailable/);
 assert.equal(es[0].color,0x5865f2);
});
