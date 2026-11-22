import { authorizedBearer, discordClient } from '../src/discord.js';
import { TRACKER_COMMAND } from '../src/commands.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.REFRESH_SECRET) return res.status(503).json({ error: 'REFRESH_SECRET is missing' });
  if (!authorizedBearer(req.headers.authorization || '', process.env.REFRESH_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  const appId = process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!appId || !guildId || !process.env.DISCORD_BOT_TOKEN) return res.status(503).json({ error: 'Discord credentials missing' });
  if (!/^\d{16,22}$/.test(appId) || !/^\d{16,22}$/.test(guildId)) return res.status(503).json({ error: 'Invalid configured IDs' });
  try {
    const client = discordClient(process.env.DISCORD_BOT_TOKEN);
    const commands = await client.request(`/applications/${appId}/guilds/${guildId}/commands`, { method: 'PUT', body: [TRACKER_COMMAND] });
    return res.status(200).json({ ok: true, registered: commands.map(c => c.name), guildId });
  } catch (error) {
    console.error('[crypto:register]', error.message);
    return res.status(502).json({ error: 'Could not register Discord commands; check Vercel logs' });
  }
}
