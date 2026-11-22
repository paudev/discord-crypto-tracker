import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToken, selectBestPair, fetchTokenPair } from '../src/dexscreener.js';
import { createDashboardEmbed, formatPrice, parseConfig, serializeConfig } from '../src/tracker.js';

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

test('formats tiny token prices safely', function testTiny(){
 assert.match(formatPrice(0.00000001435),/1\.435/);
 const e=createDashboardEmbed([{token:{chain:"solana",address:SOL},pair:{baseToken:{symbol:"@everyone"},marketCap:550000,priceUsd:"0.01",liquidity:{usd:15000},priceChange:{h24:-3.2,m5:1.5},url:"https://dexscreener.com/solana/abc"}}],new Date("2026-11-23T00:00:00Z"));
 assert.match(e.description,/\$0\.01/);
 assert.match(e.description,/💰 \*\*MC: \$550\.00K\*\*/);
 assert.doesNotMatch(e.description,/@everyone/);
 assert.equal(e.timestamp,"2026-11-23T00:00:00.000Z");
});

test('serializes and restores Discord-persisted token configuration', () => {
  const config = { version: 1, dashboardChannelId: '123456789012345678', dashboardMessageId: null, tokens: [{ chain: 'solana', address: SOL }] };
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  assert.equal(parseConfig('just a random message'), null);
});


test('market cap and its value appear on the same line', function testCap(){
 const e=createDashboardEmbed([{token:{chain:"solana",address:SOL},pair:{baseToken:{symbol:"DREAD"},priceUsd:"0.00004431",marketCap:38940,liquidity:{usd:13610},priceChange:{h24:52.45},url:"https://dexscreener.com/solana/abc"}}]);
 assert.equal(e.color,0x2ecc71);
 assert.equal(e.fields,undefined);
 assert.match(e.description,/🟢 \*\*DREAD\*\* · SOLANA/);
 const lines=e.description.split("\n");
 assert.ok(lines.includes("💰 **MC: $38.94K**"));
 assert.ok(lines.some(x=>x.includes("Price **$0.00004431**")&&x.includes("Liquidity **$13.61K**")));
 assert.ok(lines.some(x=>x.includes("24h 🟢 **+52.45%**")&&x.includes("5m ⚪ —")));
 assert.ok(lines.some(x=>x.includes("[View chart]")&&x.includes("So111111…111112")));
});

test('negative changes retain red styling', function testNegative(){
 const e=createDashboardEmbed([{token:{chain:"solana",address:SOL},pair:{baseToken:{symbol:"DOWN"},priceUsd:"1.2",priceChange:{h24:-10.2,m5:-0.3}}}]);
 assert.equal(e.color,0xe74c3c);
 assert.ok(e.description.includes("🔴 **DOWN**"));
 assert.ok(e.description.includes("5m 🔴 -0.30%"));
 assert.ok(e.description.includes("24h 🔴 **-10.20%**"));
});

test('twelve tokens have separators and fit the embed limit', function testTwelve(){
 const entries=Array.from({length:12},(_,i)=>({token:{chain:"solana",address:SOL},pair:{baseToken:{symbol:"T"+i},priceUsd:"0.01",marketCap:20000+i,priceChange:{h24:i%2?-1:1}}}));
 const e=createDashboardEmbed(entries);
 assert.equal(e.color,0x5865f2);
 assert.equal(e.fields,undefined);
 assert.equal(e.description.split("────────────────────").length-1,11);
 assert.ok(e.description.length<=4096);
 assert.ok(JSON.stringify(e).length<6000);
});

test('each token has a distinct market cap block', function testSections(){
 const entries=[{token:{chain:"solana",address:SOL},pair:{baseToken:{symbol:"DREAD"},marketCap:38940,priceUsd:"0.001"}},
 {token:{chain:"base",address:ETH},pair:{baseToken:{symbol:"CoT"},marketCap:2320000,priceUsd:"0.023"}}];
 const e=createDashboardEmbed(entries);
 const sections=e.description.split("────────────────────");
 assert.equal(sections.length,2);
 assert.match(sections[0],/MC: \$38\.94K/);
 assert.match(sections[1],/MC: \$2\.32M/);
});
