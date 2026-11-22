import { waitUntil } from '@vercel/functions';
import { discordClient, editInteractionResponse, rawRequestBody, verifyInteraction } from '../src/discord.js';
import { executeTrackerCommand, isServerManager } from '../src/commands.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.DISCORD_PUBLIC_KEY || !process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_APPLICATION_ID || !process.env.DISCORD_GUILD_ID) {
    return res.status(503).json({ error: 'Discord application is not fully configured' });
  }
  let raw;
  try { raw = await rawRequestBody(req); }
  catch { return res.status(413).json({ error: 'Request too large' }); }
  if (!verifyInteraction(raw, req.headers, process.env.DISCORD_PUBLIC_KEY)) {
    return res.status(401).json({ error: 'Invalid Discord request signature' });
  }
  let interaction;
  try { interaction = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (interaction.type === 1) return res.status(200).json({ type: 1 }); // Discord PING/PONG verification
  if (interaction.type !== 2 || interaction.data?.name !== 'tracker') {
    return res.status(200).json({ type: 4, data: { flags: 64, content: 'Unsupported command.' } });
  }
  if (interaction.guild_id !== process.env.DISCORD_GUILD_ID || !isServerManager(interaction)) {
    return res.status(200).json({ type: 4, data: { flags: 64, content: 'This command is restricted to authorized server managers.' } });
  }
  const task = (async () => {
    let message;
    try {
      message = await executeTrackerCommand({
        interaction,
        client: discordClient(process.env.DISCORD_BOT_TOKEN),
        applicationId: process.env.DISCORD_APPLICATION_ID,
      });
    } catch (error) {
      console.error('[crypto:interaction]', error.message);
      message = `Could not complete that command. ${error.status === 403 ? 'Check the bot’s Discord channel permissions.' : 'See Vercel logs for details.'}`;
    }
    try { await editInteractionResponse(process.env.DISCORD_APPLICATION_ID, interaction.token, message); }
    catch (error) { console.error('[crypto:followup]', error.message); }
  })();
  waitUntil(task);
  return res.status(200).json({ type: 5, data: { flags: 64 } }); // Deferred ephemeral response within 3s
}
