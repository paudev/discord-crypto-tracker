import { CHAIN_CHOICES, MAX_TOKENS, safeText } from './discord.js';
import { normalizeToken, fetchTokenPair } from './dexscreener.js';
import { ensureStore, loadStore, publishDashboard, saveStore } from './tracker.js';

const STRING = 3;
const CHANNEL = 7;
const SUBCOMMAND = 1;

export const TRACKER_COMMAND = {
  name: 'tracker',
  description: 'Manage and view the server crypto token tracker',
  type: 1,
  dm_permission: false,
  default_member_permissions: '32', // MANAGE_GUILD; server admins only
  options: [
    { type: SUBCOMMAND, name: 'add', description: 'Track a token by contract address', options: [
      { type: STRING, name: 'chain', description: 'Blockchain network', required: true, choices: CHAIN_CHOICES },
      { type: STRING, name: 'address', description: 'Token contract address (not pair address)', required: true },
    ] },
    { type: SUBCOMMAND, name: 'remove', description: 'Stop tracking a token', options: [
      { type: STRING, name: 'address', description: 'Token contract address', required: true },
      { type: STRING, name: 'chain', description: 'Blockchain (if the address is used on multiple networks)', required: false, choices: CHAIN_CHOICES },
    ] },
    { type: SUBCOMMAND, name: 'list', description: 'Show the currently tracked token addresses' },
    { type: SUBCOMMAND, name: 'refresh', description: 'Refresh the token dashboard now' },
    { type: SUBCOMMAND, name: 'channel', description: 'Move the price dashboard to a text channel', options: [
      { type: CHANNEL, name: 'target', description: 'Where price updates should appear', required: true, channel_types: [0] },
    ] },
    { type: SUBCOMMAND, name: 'help', description: 'Show tracker commands and setup instructions' },
  ],
};

export function isServerManager(interaction) {
  if (!interaction.guild_id) return false;
  try {
    const permissions = BigInt(interaction.member?.permissions ?? '0');
    return (permissions & 32n) !== 0n || (permissions & 8n) !== 0n;
  } catch { return false; }
}

const helpText = [
  '**Crypto Token Tracker** — server managers only',
  '• `/tracker add chain:solana address:<CA>` — add a token (this channel is used for the dashboard on first use)',
  '• `/tracker remove address:<CA>` — stop tracking a token',
  '• `/tracker list` — list all tracked tokens',
  '• `/tracker refresh` — fetch the latest prices now',
  '• `/tracker channel target:#crypto-prices` — move the dashboard',
  `Maximum: **${MAX_TOKENS} tokens**. Powered by DEX Screener (no paid API key).`,
].join('\n');

function optionValue(subcommand, name) {
  return subcommand.options?.find(x => x.name === name)?.value;
}

export async function executeTrackerCommand({ interaction, client, applicationId, fetcher }) {
  if (!isServerManager(interaction)) return 'You need the **Manage Server** permission to use tracker commands.';
  const guildId = interaction.guild_id;
  const command = interaction.data?.options?.[0];
  if (!command) return helpText;
  if (command.name === 'help') return helpText;

  if (command.name === 'add') {
    const token = normalizeToken(optionValue(command, 'chain'), optionValue(command, 'address'));
    const pair = await fetchTokenPair(token, fetcher);
    if (!pair) return 'Could not find a priced base-token pool for this contract on that chain. Check the address and chain in DEX Screener.';
    const store = await ensureStore(client, { guildId, applicationId, channelId: interaction.channel_id });
    if (store.config.tokens.some(x => x.chain === token.chain && x.address === token.address)) return 'That token is already being tracked.';
    if (store.config.tokens.length >= MAX_TOKENS) return `This dashboard supports a maximum of ${MAX_TOKENS} tokens.`;
    store.config.tokens.push(token);
    await saveStore(client, store);
    try {
      await publishDashboard(client, store, { fetcher });
      return `✅ Added **${safeText(pair.baseToken?.symbol) || 'token'}** on **${token.chain}**. Price dashboard: <#${store.config.dashboardChannelId}>.`;
    } catch (error) {
      console.error('[tracker:dashboard]', error.message);
      return '✅ Token saved, but I could not publish the dashboard. Check my Send Messages / Embed Links permissions, then use `/tracker refresh`.';
    }
  }

  const store = await loadStore(client, guildId);
  if (!store) {
    if (command.name === 'channel') {
      const channelId = optionValue(command, 'target');
      const created = await ensureStore(client, { guildId, applicationId, channelId });
      try { await publishDashboard(client, created, { fetcher }); }
      catch (error) { console.error('[tracker:channel]', error.message); return '✅ Dashboard channel saved, but I could not post there. Check the bot’s permissions.'; }
      return `✅ Dashboard initialized in <#${channelId}>. Add tokens using "/tracker add".`;
    }
    return 'No watchlist configured yet. Run `/tracker add` or `/tracker channel` to initialize one.';
  }
  if (command.name === 'list') {
    if (!store.config.tokens.length) return `No tokens tracked yet. Dashboard: <#${store.config.dashboardChannelId}>.`;
    return `**Tracked tokens (${store.config.tokens.length}/${MAX_TOKENS}):**\n` + store.config.tokens
      .map((x, i) => `${i + 1}. **${x.chain}** · \`${x.address}\``).join('\n')
      + `\nDashboard: <#${store.config.dashboardChannelId}>`;
  }
  if (command.name === 'remove') {
    const address = String(optionValue(command, 'address') || '').trim();
    const chain = optionValue(command, 'chain');
    const matching = store.config.tokens.filter(x => x.address.toLowerCase() === address.toLowerCase() && (!chain || x.chain === chain));
    if (!matching.length) return 'That token is not in the watchlist.';
    if (matching.length > 1) return 'That address is tracked on multiple chains. Specify the chain as well.';
    store.config.tokens = store.config.tokens.filter(x => x !== matching[0]);
    await saveStore(client, store);
    try { await publishDashboard(client, store, { fetcher }); }
    catch (error) { console.error('[tracker:dashboard]', error.message); return '✅ Token removed. Dashboard update failed; check permissions and use `/tracker refresh`.'; }
    return `✅ Removed **${matching[0].chain}** token \`${matching[0].address}\`.`;
  }
  if (command.name === 'channel') {
    const channelId = optionValue(command, 'target');
    if (!channelId || !/^\d{16,22}$/.test(channelId)) return 'Select a valid text channel.';
    const channels = await client.request(`/guilds/${guildId}/channels`);
    if (!channels.some(x => x.id === channelId && x.type === 0)) return 'The target must be a text channel in this server.';
    const previous = { channelId: store.config.dashboardChannelId, messageId: store.config.dashboardMessageId };
    store.config.dashboardChannelId = channelId;
    store.config.dashboardMessageId = null;
    await saveStore(client, store);
    try {
      await publishDashboard(client, store, { fetcher });
      if (previous.messageId && previous.channelId !== channelId) {
        try { await client.request(`/channels/${previous.channelId}/messages/${previous.messageId}`, { method: 'DELETE' }); }
        catch (error) { console.warn('[tracker:old-dashboard]', error.message); }
      }
      return `✅ Dashboard moved to <#${channelId}>.`;
    } catch (error) {
      // Restore the previous usable dashboard if a new channel is inaccessible.
      store.config.dashboardChannelId = previous.channelId;
      store.config.dashboardMessageId = previous.messageId;
      await saveStore(client, store);
      console.error('[tracker:channel]', error.message);
      return 'Could not post in that channel. The old dashboard is unchanged. Grant the bot Send Messages and Embed Links.';
    }
  }
  if (command.name === 'refresh') {
    await publishDashboard(client, store, { fetcher });
    return `✅ Refreshed **${store.config.tokens.length}** tokens in <#${store.config.dashboardChannelId}>.`;
  }
  return helpText;
}
