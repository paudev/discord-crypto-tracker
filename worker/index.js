// This free Cloudflare Worker only schedules the Vercel API; it is a separate deployment.
const ENDPOINT = 'https://discord-crypto-tracker.vercel.app/api/refresh';

export async function refreshCryptoTracker(env, fetcher = globalThis.fetch) {
  const secret = env?.REFRESH_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('Configure REFRESH_SECRET in Cloudflare Worker secrets');
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Vercel crypto refresh failed (HTTP ${response.status})`);
  return response.status;
}

export default {
  async scheduled(_controller, env) {
    await refreshCryptoTracker(env);
    console.log('[crypto-tracker] Scheduled refresh succeeded');
  },
  fetch() {
    return new Response('Crypto Tracker scheduler is active; HTTP requests do not trigger refresh.', { status: 200 });
  },
};
