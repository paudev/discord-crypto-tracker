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

test('formats tiny token prices and safe token fields', () => {
  assert.match(formatPrice(0.00000001435), /1\.435/);
  const embed = createDashboardEmbed([{ token: { chain: 'solana', address: SOL }, pair: {
    chainId: 'solana', baseToken: { address: SOL, symbol: '@everyone' }, priceUsd: '0.01', liquidity: { usd: 15000 },
    marketCap: 550000, priceChange: { m5: 1.5, h24: -3.2 }, url: 'https://dexscreener.com/solana/abc'
  } }], new Date('2026-11-23T00:00:00Z'));
  assert.match(embed.fields[0].value, /\$0\.01/);
  assert.match(embed.fields[0].value, /💰 \*\*MARKET CAP\*\*\n\*\*\$550\.00K\*\*/);
  assert.doesNotMatch(embed.fields[0].name, /@/);
  assert.equal(embed.timestamp, '2026-11-23T00:00:00.000Z');
});

test('serializes and restores Discord-persisted token configuration', () => {
  const config = { version: 1, dashboardChannelId: '123456789012345678', dashboardMessageId: null, tokens: [{ chain: 'solana', address: SOL }] };
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  assert.equal(parseConfig('just a random message'), null);
});


test('market cap is primary and other metrics have comfortable spacing', () => {
  const embed = createDashboardEmbed([{
    token: { chain: 'solana', address: SOL },
    pair: { baseToken: { symbol: 'DREAD' }, priceUsd: '0.00004431', marketCap: 38940,
      liquidity: { usd: 13610 }, priceChange: { h24: 52.45 },
      url: 'https://dexscreener.com/solana/abc' },
  }]);
  assert.equal(embed.color, 0x2ecc71);
  assert.match(embed.fields[0].name, /^🟢 DREAD/);
  const lines = embed.fields[0].value.split('\n');
  assert.equal(lines.length, 8);
  assert.equal(lines[0], '💰 **MARKET CAP**');
  assert.equal(lines[1], '**$38.94K**');
  assert.equal(lines[2], '');
  assert.ok(lines[3].includes('**Price**  $0.00004431'));
  assert.ok(lines[4].includes('**24h** 🟢 **+52.45%**') && lines[4].includes('**5m** —'));
  assert.ok(lines[5].includes('💧 **Liquidity**  $13.61K'));
  assert.equal(lines[6], '');
  assert.ok(lines[7].includes('View chart') && lines[7].includes('So111111…111112'));
  assert.ok(!embed.fields[0].value.includes(SOL));
});

test('negative token has red accent and compact signed changes', () => {
  const embed = createDashboardEmbed([{
    token: { chain: 'solana', address: SOL },
    pair: { baseToken: { symbol: 'DOWN' }, priceUsd: '1.2', priceChange: { m5: -0.3, h24: -10.2 } },
  }]);
  assert.equal(embed.color, 0xe74c3c);
  assert.match(embed.fields[0].name, /^🔴/);
  assert.ok(embed.fields[0].value.includes('**5m** -0.30%'));
  assert.ok(embed.fields[0].value.includes('**24h** 🔴 **-10.20%**'));
});

test('twelve mixed tokens fit into one neutral Discord embed', () => {
  const entries = Array.from({length: 12}, (_, i) => ({
    token: {chain: 'solana', address: SOL},
    pair: {baseToken: {symbol: 'T' + i}, priceUsd: '0.01', priceChange: {h24: i % 2 ? -1 : 1}},
  }));
  const embed = createDashboardEmbed(entries);
  assert.equal(embed.color, 0x5865f2);
  assert.equal(embed.fields.length, 12);
  assert.ok(JSON.stringify(embed).length < 6000);
});
