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



test('single formatted message retains original design constraints for 3 dynamic tokens', () => {
  const e=createDashboardEmbeds([
    {token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},marketCap:29820,priceUsd:0.00003394,liquidity:{usd:11750},priceChange:{h24:16.76,m5:-3.9},url:'https://dexscreener.com/solana/dread'}},
    {token:{chain:'solana',address:'5kqi4kDq56H9UfHq14jXtmy189zpyxaYdXCQ4qHvDtHW'},pair:{baseToken:{symbol:'CoT'},marketCap:2320000,priceUsd:0.002318,liquidity:{usd:99830},priceChange:{h24:102,m5:-0.36}}},
    {token:{chain:'solana',address:'2Er88nn9W1pumpABCDEF1234567890abcdefghijkLMNO'},pair:{baseToken:{symbol:'REALM'},marketCap:14650,priceUsd:0.00001464,liquidity:{usd:null},priceChange:{h24:4.25,m5:null}}}
  ]);
  assert.equal(e.length,1);
  assert.equal(e[0].fields,undefined);
  assert.equal(e[0].color,0x64748b);
  const d=e[0].description;
  assert.match(d,/^3 tokens tracked\n\n━━━━━━━━━━━━━━━━/);
  assert.equal(d.split('━━━━━━━━━━━━━━━━').length-1,4);
  assert.ok(d.endsWith('━━━━━━━━━━━━━━━━'));
  assert.ok(d.indexOf('**DREAD**')<d.indexOf('**CoT**')&&d.indexOf('**CoT**')<d.indexOf('**REALM**'));
  assert.match(d,/\*\*MC \$29\.82K\*\*  ·  24h \*\*\+16\.76%\*\*/);
  assert.match(d,/Price \*\*\$0\.00003394\*\*  ·  Liquidity \*\*\$11\.75K\*\*/);
  assert.match(d,/5m \*\*-3\.90%\*\*  ·  CA \`So111111…111112\`/);
  assert.match(d,/Liquidity \*\*N\/A\*\*/);
  assert.match(d,/\[Chart ↗\]\(https:\/\/dexscreener\.com\/solana\/dread\)/);
  assert.doesNotMatch(d,/[🟢🔴⚪🔥🌊🏰💰💧📈📉╭╮╰╯├┤│]/u);
});

test('symbol labels are driven by external token data, not a fixed name set',()=>{
  const e=createDashboardEmbeds([{token:{chain:'base',address:ETH,symbol:'FUTURECOIN'},
    pair:{baseToken:{symbol:'FUTURECOIN'},marketCap:37500,priceUsd:0.5,priceChange:{h24:-7,m5:0}}}])[0];
  assert.match(e.description,/\*\*FUTURECOIN\*\*  ·  BASE/);
  assert.equal(e.description.split('━━━━━━━━━━━━━━━━').length-1,2);
  assert.match(e.description,/24h \*\*-7\.00%\*\*/);
});

test('twelve tokens with long links stay in one Discord embed',()=>{
  const url='https://dexscreener.com/avalanche/'+'a'.repeat(76);
  const entries=Array.from({length:12},(_,i)=>({token:{chain:'avalanche',address:'0x1111111111111111111111111111111111111111'},
    pair:{baseToken:{symbol:'DYNAMICLONGLABEL'+i},marketCap:1999999,priceUsd:'0.00000012345',liquidity:{usd:500000},priceChange:{h24:112.23,m5:-3.33},url}}));
  const embeds=createDashboardEmbeds(entries);
  assert.equal(embeds.length,1);
  assert.equal(embeds[0].fields,undefined);
  assert.equal(embeds[0].description.split('━━━━━━━━━━━━━━━━').length-1,13);
  assert.equal((embeds[0].description.match(/\[Chart ↗\]/g)||[]).length,12);
  assert.ok(embeds[0].description.length<=4096);
  assert.ok(JSON.stringify(embeds[0]).length<=6000);
});

test('unknown pool uses stored symbol and the standard separators',()=>{
  const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'UNKNOWN'},pair:null,error:'timeout'}])[0];
  assert.match(e.description,/\*\*UNKNOWN\*\*/);
  assert.match(e.description,/Market data unavailable/);
  assert.equal(e.description.split('━━━━━━━━━━━━━━━━').length-1,2);
});

test('empty watchlist and legacy watchlist serialization work',()=>{
  const e=createDashboardEmbeds([])[0];
  assert.match(e.description,/No tracked tokens/);
  assert.equal(e.color,0x64748b);
  const config={version:1,dashboardChannelId:'123456789012345678',dashboardMessageId:null,tokens:[{chain:'solana',address:SOL}]};
  assert.deepEqual(parseConfig(serializeConfig(config)),config);
});

test('FDV fallback and liquidity missing versus zero remain distinct',()=>{
  const e=createDashboardEmbeds([
    {token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'A'},priceUsd:0.5,fdv:90000,liquidity:{usd:0}}},
    {token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'B'},marketCap:1000,priceUsd:0.5,liquidity:{usd:null}}}
  ])[0];
  assert.match(e.description,/\*\*FDV \$90\.00K\*\*/);
  assert.match(e.description,/Liquidity \*\*\$0\*\*/);
  assert.match(e.description,/Liquidity \*\*N\/A\*\*/);
});

test('token symbols are sanitized to prevent Discord mentions',()=>{
  const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'@everyone'},marketCap:550000,priceUsd:0.01}}])[0];
  assert.doesNotMatch(e.description,/@everyone/);
  assert.match(e.description,/\*\*MC \$550\.00K\*\*/);
});
