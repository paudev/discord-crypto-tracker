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
  assert.match(embed.fields[0].value, /MC \$550\.00K/);
  assert.doesNotMatch(embed.fields[0].name, /@/);
  assert.equal(embed.timestamp, '2026-11-23T00:00:00.000Z');
});

test('serializes and restores Discord-persisted token configuration', () => {
  const config = { version: 1, dashboardChannelId: '123456789012345678', dashboardMessageId: null, tokens: [{ chain: 'solana', address: SOL }] };
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  assert.equal(parseConfig('just a random message'), null);
});
