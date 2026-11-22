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

export function selectBestPair(pairs, token) {
  if (!Array.isArray(pairs)) return null;
  return pairs
    .filter(p => p && p.chainId === token.chain && matchAddress(p.baseToken?.address, token.address, token.chain)
      && Number.isFinite(Number(p.priceUsd)) && Number(p.priceUsd) > 0)
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0] ?? null;
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
  // A bounded number of independent requests, without overwhelming the free API.
  const results = [];
  for (let i = 0; i < tokens.length; i += 4) {
    const batch = await Promise.all(tokens.slice(i, i + 4).map(async token => {
      try { return { token, pair: await fetchTokenPair(token, fetcher) }; }
      catch (error) { return { token, pair: null, error: error.message }; }
    }));
    results.push(...batch);
  }
  return results;
}
