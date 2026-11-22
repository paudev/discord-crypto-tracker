import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

export const DISCORD_API = 'https://discord.com/api/v10';
export const CONFIG_MARKER = 'CRYPTO_TRACKER_CONFIG_V1\n';
export const MAX_TOKENS = 12;
export const CHAIN_CHOICES = [
  { name: 'Solana', value: 'solana' },
  { name: 'Ethereum', value: 'ethereum' },
  { name: 'Base', value: 'base' },
  { name: 'BNB Chain', value: 'bsc' },
  { name: 'Arbitrum', value: 'arbitrum' },
  { name: 'Polygon', value: 'polygon' },
  { name: 'Avalanche', value: 'avalanche' },
  { name: 'Ronin', value: 'ronin' },
];

export function verifyInteraction(rawBody, headers, publicKeyHex) {
  const signature = String(headers['x-signature-ed25519'] || '');
  const timestamp = String(headers['x-signature-timestamp'] || '');
  if (!/^[a-fA-F0-9]{128}$/.test(signature) || !/^\d{10}$/.test(timestamp) || !/^[a-fA-F0-9]{64}$/.test(publicKeyHex || '')) return false;
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() / 1000 - time) > 300) return false;
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const data = Buffer.concat([Buffer.from(timestamp), rawBody]);
    return cryptoVerify(null, data, key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

export function authorizedBearer(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function rawRequestBody(req, maxBytes = 512_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class DiscordError extends Error {
  constructor(message, status = 500, retryAfter = null) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function discordClient(token, fetcher = globalThis.fetch) {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is missing');
  return {
    async request(path, { method = 'GET', body, allow404 = false, timeout = 12000 } = {}) {
      const response = await fetcher(`${DISCORD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
      if (allow404 && response.status === 404) return null;
      let json;
      try { json = await response.json(); } catch { json = {}; }
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        throw new DiscordError(`Discord ${method} ${path.split('?')[0]} returned HTTP ${response.status}`, response.status, retry);
      }
      return json;
    },
  };
}

export async function editInteractionResponse(applicationId, interactionToken, message, fetcher = globalThis.fetch) {
  const payload = typeof message === 'string'
    ? { content: message.slice(0, 1950) }
    : {
        content: typeof message?.content === 'string' ? message.content.slice(0, 1950) : '',
        ...(Array.isArray(message?.embeds) ? { embeds: message.embeds } : {}),
      };
  const response = await fetcher(`${DISCORD_API}/webhooks/${applicationId}/${encodeURIComponent(interactionToken)}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Discord interaction follow-up failed (HTTP ${response.status})`);
}

export function safeText(value, max = 32) {
  return String(value ?? '').replace(/[\r\n@`<>*_~|\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
