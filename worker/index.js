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

const WORKER_BUILD = 'rug-60s-v3';

export default {
  async scheduled(controller, env) {
    // These logs distinguish a missing secret, an upstream HTTP failure,
    // and a Cron Trigger that never reaches the scheduled handler.
    console.log('[crypto-tracker] Cron invocation started', {
      schedule: controller?.cron ?? '* * * * *',
      secretConfigured: typeof env?.REFRESH_SECRET === 'string' && env.REFRESH_SECRET.length >= 16,
    });
    try {
      await refreshCryptoTracker(env);
      console.log('[crypto-tracker] Scheduled refresh succeeded');
    } catch (error) {
      console.error('[crypto-tracker] Scheduled refresh failed:', String(error?.message ?? error));
      throw error;
    }
  },
  // Read-only status endpoint, safe to open from the Cloudflare "Visit" button.
  // It never calls Vercel or exposes any secret values.
  fetch(_request, env) {
    return Response.json({
      service: 'discord-crypto-tracker',
      workerBuild: WORKER_BUILD,
      secretConfigured: typeof env?.REFRESH_SECRET === 'string' && env.REFRESH_SECRET.length >= 16,
      cronSchedule: '* * * * *',
      rugPollInterval: 'once per minute (with dashboard and ATH refresh)',
      note: 'Read-only Worker status. HTTP requests do not trigger refresh.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  },
};
