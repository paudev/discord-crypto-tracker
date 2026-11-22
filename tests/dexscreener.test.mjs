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

test("safe fields do not mention Discord roles", function testSafe(){
 const embeds=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'@everyone'},priceUsd:0.01,marketCap:550000,liquidity:{usd:15000},priceChange:{h24:-3.2,m5:1.5}}}],new Date('2026-11-23T00:00:00Z'));
 assert.equal(embeds.length,1);
 assert.equal(embeds[0].fields.length,1);
 assert.doesNotMatch(JSON.stringify(embeds),/@everyone/);
 assert.match(embeds[0].fields[0].value,/\$0\.01/);
 assert.match(embeds[0].fields[0].value,/\*\*MC \$550\.00K\*\*/);
 assert.equal(embeds[0].timestamp,'2026-11-23T00:00:00.000Z');
});

test("stored token configs retain backward compatibility", function testStore(){
 const config={version:1,dashboardChannelId:'123456789012345678',dashboardMessageId:null,tokens:[{chain:'solana',address:SOL}]};
 assert.deepEqual(parseConfig(serializeConfig(config)),config);
 assert.equal(parseConfig('ordinary message'),null);
});

test("three live tokens render in clean native fields without decorative characters", function testThree(){
 const entries=[
 {token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'DREAD'},marketCap:29820,priceUsd:0.00003394,liquidity:{usd:11750},priceChange:{h24:16.76,m5:-3.9},url:'https://dexscreener.com/solana/dread'}},
 {token:{chain:'solana',address:'5kqi4kDq56H9UfHq14jXtmy189zpyxaYdXCQ4qHvDtHW'},pair:{baseToken:{symbol:'CoT'},marketCap:2320000,priceUsd:0.002318,liquidity:{usd:99830},priceChange:{h24:102,m5:-0.36}}},
 {token:{chain:'solana',address:'2Er88nn9W1pumpABCDEF1234567890abcdefghijkLMNO'},pair:{baseToken:{symbol:'REALM'},marketCap:14650,priceUsd:0.00001464,liquidity:{usd:null},priceChange:{h24:4.25,m5:null}}}
 ];
 const embeds=createDashboardEmbeds(entries);
 assert.equal(embeds.length,1);
 const embed=embeds[0];
 assert.equal(embed.title,'SpicyTracker · Crypto Markets');
 assert.equal(embed.description,'3 tokens tracked');
 assert.equal(embed.color,0x64748b);
 assert.deepEqual(embed.fields.map(x=>x.name),['DREAD · SOLANA','CoT · SOLANA','REALM · SOLANA']);
 assert.ok(embed.fields.every(x=>x.inline===false));
 const value=embed.fields[0].value;
 assert.ok(value.split('\n')[0].includes('**MC $29.82K**  ·  24h **+16.76%**'));
 assert.match(value,/Price \*\*\$0\.00003394\*\*  ·  Liquidity \*\*\$11\.75K\*\*/);
 assert.match(value,/5m -3\.90%.*\[View chart ↗\]\(https:\/\/dexscreener\.com\/solana\/dread\)/);
 assert.match(value,/CA `So111111…111112`/);
 assert.match(embed.fields[2].value,/Liquidity \*\*N\/A\*\*/);
 assert.doesNotMatch(JSON.stringify(embed),/[🟢🔴⚪🔥🌊🏰💰💵💧⚡🏷️📈📉]/u);
 assert.doesNotMatch(JSON.stringify(embed),/[╭╮╰╯├┤│─]/u);
});

test("any dynamic token symbol and chain render without special case mapping", function testDynamic(){
 const symbol='MYSTERYXYZ';
 const embed=createDashboardEmbeds([{token:{chain:'base',address:ETH,symbol},pair:{baseToken:{symbol},marketCap:13700,priceUsd:0.5,priceChange:{h24:-7}}}])[0];
 assert.equal(embed.fields[0].name,'MYSTERYXYZ · BASE');
 assert.match(embed.fields[0].value,/24h \*\*-7\.00%\*\*/);
 assert.equal(embed.fields[0].value.split('\n').length,4);
});

test("twelve tokens stay within Discord message and field limits", function testTwelve(){
 const entries=Array.from({length:12},(_,i)=>({token:{chain:'avalanche',address:ETH},pair:{baseToken:{symbol:'DYNAMIC'+i},marketCap:345000,priceUsd:0.000000032547,liquidity:{usd:95000},priceChange:{h24:1.23,m5:-4.5},url:'https://dexscreener.com/avalanche/'+'a'.repeat(120)}}));
 const e=createDashboardEmbeds(entries);
 assert.equal(e.length,1);
 assert.equal(e[0].fields.length,12);
 assert.ok(e[0].fields.every(f=>f.value.length<=1024));
 assert.ok(e[0].fields.every(f=>f.inline===false));
 const total=[e[0].title,e[0].description,e[0].footer.text,...e[0].fields.flatMap(f=>[f.name,f.value])].join('').length;
 assert.ok(total<6000);
 assert.ok(e[0].fields[11].name.startsWith('DYNAMIC11'));
});

test("unavailable price pairs show the saved symbol", function testUnavailable(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'NEWCOIN'},pair:null,error:'timeout'}])[0];
 assert.equal(e.fields.length,1);
 assert.equal(e.fields[0].name,'NEWCOIN · SOLANA');
 assert.match(e.fields[0].value,/Market data unavailable/);
});

test("empty watchlist is readable", function testEmpty(){
 const e=createDashboardEmbeds([])[0];
 assert.equal(e.fields.length,0);
 assert.match(e.description,/No tracked tokens/);
});

test("FDV is distinctly labeled", function testFDV(){
 const e=createDashboardEmbeds([{token:{chain:'solana',address:SOL,symbol:'MINT'},pair:{baseToken:{symbol:'MINT'},priceUsd:0.5,fdv:90000,priceChange:{h24:0,m5:-0.5}}}])[0];
 assert.match(e.fields[0].value,/\*\*FDV \$90\.00K\*\*/);
 assert.match(e.fields[0].value,/5m -0\.50%/);
});

test("zero and unknown liquidity are distinct", function testLiquidity(){
 const zero=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'ZERO'},priceUsd:0.5,marketCap:90000,liquidity:{usd:0}}}])[0];
 assert.match(zero.fields[0].value,/Liquidity \*\*\$0\*\*/);
 const unknown=createDashboardEmbeds([{token:{chain:'solana',address:SOL},pair:{baseToken:{symbol:'UNKNOWN'},priceUsd:0.5,marketCap:90000,liquidity:{usd:null}}}])[0];
 assert.match(unknown.fields[0].value,/Liquidity \*\*N\/A\*\*/);
});
