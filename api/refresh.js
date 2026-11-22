import { authorizedBearer, discordClient } from '../src/discord.js';
import { loadStore, publishDashboard, saveStore } from '../src/tracker.js';
import { syncTrackerCommandsIfNeeded } from '../src/commands.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.REFRESH_SECRET) return res.status(503).json({ error: 'REFRESH_SECRET is missing' });
  if (!authorizedBearer(req.headers.authorization || '', process.env.REFRESH_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return res.status(503).json({ error: 'Discord is not configured' });
  try {
    const client = discordClient(process.env.DISCORD_BOT_TOKEN);
    const store = await loadStore(client, process.env.DISCORD_GUILD_ID);
    if (store?.needsMigration) await saveStore(client, store);
    if (!store) return res.status(200).json({ ok: true, initialized: false, message: 'Use /tracker add or /tracker channel first' });
    // The authenticated minute refresh auto-registers new Discord slash commands
    // exactly once per stored schema revision; failures must not block prices.
    try {
      const registered = await syncTrackerCommandsIfNeeded(
        client, store, process.env.DISCORD_APPLICATION_ID, process.env.DISCORD_GUILD_ID,
      );
      if (registered) console.log('[crypto:commands] Updated guild slash commands');
    } catch (error) {
      console.warn('[crypto:commands] Auto-registration failed; refresh will retry', error.message);
    }
    if (!store.config.tokens.length) return res.status(200).json({ ok: true, initialized: true, tokens: 0, skipped: true });
    const published = await publishDashboard(client, store);
    return res.status(200).json({ ok: true, initialized: true, ...published });
  } catch (error) {
    console.error('[crypto:refresh]', error.message);
    return res.status(502).json({ error: 'Refresh failed; check Vercel logs' });
  }
}
