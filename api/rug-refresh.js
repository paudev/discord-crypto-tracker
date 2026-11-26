import { authorizedBearer, discordClient } from '../src/discord.js';
import { fetchAllPairs } from '../src/dexscreener.js';
import { loadStore, updateRugWatch } from '../src/tracker.js';

// Called only by the authenticated Cloudflare scheduler midway between the
// normal minute refreshes. Does NOT edit price dashboard or ATH records.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.REFRESH_SECRET) return res.status(503).json({ error: 'REFRESH_SECRET is missing' });
  if (!authorizedBearer(req.headers.authorization || '', process.env.REFRESH_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return res.status(503).json({ error: 'Discord is not configured' });
  }
  try {
    const client = discordClient(process.env.DISCORD_BOT_TOKEN);
    const store = await loadStore(client, process.env.DISCORD_GUILD_ID);
    if (!store?.config.rugChannelId || !store.config.tokens.length) {
      return res.status(200).json({ ok: true, rugEnabled: false, skipped: true });
    }
    const entries = await fetchAllPairs(store.config.tokens);
    const results = await updateRugWatch(client, store, entries);
    return res.status(200).json({ ok: true, tokens: entries.length, ...results });
  } catch (error) {
    console.error('[crypto:rug-refresh]', error.message);
    return res.status(502).json({ error: 'Rug refresh failed; check Vercel logs' });
  }
}
