import { CHAIN_CHOICES } from './discord.js';

const DEX_API = 'https://api.dexscreener.com';
const SUPPORTED = new Set(CHAIN_CHOICES.map(x => x.value));
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[a-fA-F0-9]{40}$/;

export function normalizeToken(chain, address) {
  const c = String(chain ?? '').toLowerCase().trim();
  let a = String(address ?? '').trim();
  if (!SUPPORTED.has(c)) throw new Error('Unsupported chain. Choose one of the offered networks.');
  if (c === 'ronin' && /^ronin:[a-fA-F0-9]{40}$/i.test(a)) a = '0x' + a.slice(6);
  if (c === 'solana' ? !SOLANA.test(a) : !EVM.test(a)) throw new Error(`Invalid ${c} token contract address.`);
  return { chain: c, address: c === 'solana' ? a : a.toLowerCase() };
}

function matchAddress(a, b, chain) {
  return chain === 'solana' ? a === b : String(a).toLowerCase() === String(b).toLowerCase();
}

// A compact identifier lets the tracker keep the same pool between refreshes,
// even when another liquidity pool briefly becomes larger. Switching pools can
// otherwise create spurious market-cap ATHs and hide real liquidity declines.
export function poolKey(pair) {
  const address = String(pair?.pairAddress || '');
  return address.length > 20 ? address.slice(0, 8) + address.slice(-8) : address;
}
export function selectBestPair(pairs, token) {
  if (!Array.isArray(pairs)) return null;
  const valid = pairs.filter(p => p && p.chainId === token.chain &&
    matchAddress(p.baseToken?.address, token.address, token.chain) &&
    Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0);
  // Keep an established pool while DEX still returns valid prices for it.
  const preferred = token.p || token.r?.[0];
  if (preferred) {
    const matched = valid.find(p => poolKey(p) === preferred);
    if (matched) return matched;
  }
  return valid.sort((a, b) =>
    Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0] ?? null;
}

export async function fetchTokenPair(token, fetcher = globalThis.fetch) {
  const { chain, address } = normalizeToken(token.chain, token.address);
  const url = `${DEX_API}/token-pairs/v1/${chain}/${encodeURIComponent(address)}`;
  const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(11000) });
  if (!response.ok) throw new Error(`DEX Screener returned HTTP ${response.status}`);
  const pairs = await response.json();
  return selectBestPair(pairs, { chain, address });
}

export async function fetchAllPairs(tokens, fetcher = globalThis.fetch) {
  // Batch up to 30 token addresses per chain to reduce requests per minute.
  const results = new Array(tokens.length), grouped = new Map();
  tokens.forEach((token, index) => {
    const list = grouped.get(token.chain) || [];
    list.push({ token, index });
    grouped.set(token.chain, list);
  });
  const batches = [];
  for (const [chain, items] of grouped)
    for (let i = 0; i < items.length; i += 30) batches.push({ chain, items: items.slice(i, i + 30) });
  await Promise.all(batches.map(async ({ chain, items }) => {
    try {
      if (items.length === 1) {
        const { token, index } = items[0];
        results[index] = { token, pair: await fetchTokenPair(token, fetcher) };
        return;
      }
      const addresses = items.map(({ token }) => normalizeToken(token.chain, token.address).address);
      const url = DEX_API + '/tokens/v1/' + chain + '/' + addresses.map(encodeURIComponent).join(',');
      const response = await fetcher(url, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(11000),
      });
      if (!response.ok) throw new Error('DEX Screener returned HTTP ' + response.status);
      const pairs = await response.json();
      if (!Array.isArray(pairs)) throw new Error('DEX Screener returned invalid token data');
      for (const { token, index } of items) results[index] = { token, pair: selectBestPair(pairs, token) };
    } catch (error) {
      for (const { token, index } of items) results[index] = { token, pair: null, error: error.message };
    }
  }));
  return results;
}
