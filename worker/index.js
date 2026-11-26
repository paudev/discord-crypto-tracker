// This free Cloudflare Worker only schedules the Vercel API; it is a separate deployment.
const ENDPOINT = 'https://discord-crypto-tracker.vercel.app/api/refresh';
const RUG_ENDPOINT = 'https://discord-crypto-tracker.vercel.app/api/rug-refresh';
export const RUG_CHECK_OFFSET_MS = 30_000;

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

export async function refreshRugWatch(env, fetcher = globalThis.fetch) {
  const secret = env?.REFRESH_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('Configure REFRESH_SECRET in Cloudflare Worker secrets');
  const response = await fetcher(RUG_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error('Vercel rug-only refresh failed (HTTP ' + response.status + ')');
  return response.status;
}

// Retain the normal minute-based dashboard refresh, then poll for rugs
// halfway through the minute without editing dashboard or ATH records.
// Only time spent executing JS counts toward the Worker CPU allowance.
export async function runScheduledCycle(env, {
  fetcher = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const started = now();
  const status = await refreshCryptoTracker(env, fetcher);
  const elapsed = Math.max(0, now() - started);
  if (elapsed > 45_000) {
    console.warn('[crypto-tracker] Skipped extra rug poll after slow primary refresh');
    return { status, rugPolled: false };
  }
  await sleep(Math.max(0, RUG_CHECK_OFFSET_MS - elapsed));
  const rugStatus = await refreshRugWatch(env, fetcher);
  return { status, rugPolled: true, rugStatus };
}

const WORKER_BUILD = 'rug-30s-v2';

export default {
  async scheduled(controller, env) {
    // These logs distinguish a missing secret, an upstream HTTP failure,
    // and a Cron Trigger that never reaches the scheduled handler.
    console.log('[crypto-tracker] Cron invocation started', {
      schedule: controller?.cron ?? '* * * * *',
      secretConfigured: typeof env?.REFRESH_SECRET === 'string' && env.REFRESH_SECRET.length >= 16,
    });
    try {
      const result = await runScheduledCycle(env);
      console.log('[crypto-tracker] Scheduled refresh succeeded', result);
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
      rugPollInterval: 'approximately 30 seconds (requires current Worker deployment)',
      note: 'Read-only Worker status. HTTP requests do not trigger refresh.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  },
};
