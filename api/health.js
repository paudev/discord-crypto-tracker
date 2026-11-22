export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_GUILD_ID', 'REFRESH_SECRET'];
  return res.status(200).json({ ok: true, service: 'Discord Crypto Tracker', configured: required.every(k => Boolean(process.env[k])) });
}
