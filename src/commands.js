import { CHAIN_CHOICES, MAX_TOKENS, safeText } from './discord.js';
import { normalizeToken, fetchTokenPair } from './dexscreener.js';
import { cleanupStores, createHighAlertEmbed, createRugAlertEmbed, hydrateTokenSymbols, loadStore, publishDashboard, saveStore, selectStorageChannel } from './tracker.js';

const STRING = 3;
const CHANNEL = 7;
const NUMBER = 10;
const INTEGER = 4;
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
    { type: SUBCOMMAND, name: 'list', description: 'Show tracked tokens (12 per page)', options: [
      { type: INTEGER, name: 'page', description: 'Page number (default 1)', required: false, min_value: 1, max_value: 3 },
    ] },
    { type: SUBCOMMAND, name: 'refresh', description: 'Refresh the token dashboard now' },
    { type: SUBCOMMAND, name: 'channel', description: 'Move the price dashboard to a text channel', options: [
      { type: CHANNEL, name: 'target', description: 'Where price updates should appear', required: true, channel_types: [0] },
    ] },
    { type: SUBCOMMAND, name: 'storage', description: 'Choose an existing private text channel for tracker data', options: [
      { type: CHANNEL, name: 'target', description: 'Your private data channel (move it and set role permissions in Discord)', required: true, channel_types: [0] },
    ] },
    { type: SUBCOMMAND, name: 'rug-channel', description: 'Warn about likely liquidity-pull rugs in a text channel', options: [
      { type: CHANNEL, name: 'target', description: 'Channel for suspected rug warnings', required: true, channel_types: [0] },
    ] },
    { type: SUBCOMMAND, name: 'rug-off', description: 'Disable suspected rug warnings' },
    { type: SUBCOMMAND, name: 'rug-status', description: 'Show rug-watch status, thresholds and destination' },
    { type: SUBCOMMAND, name: 'rug-preview', description: 'Send a clearly marked simulated rug warning', options: [
      { type: STRING, name: 'token', description: 'Tracked token symbol or contract address (defaults to first)', required: false },
      { type: CHANNEL, name: 'target', description: 'Preview channel (defaults to rug channel)', required: false, channel_types: [0] },
    ] },
    { type: SUBCOMMAND, name: 'ath-channel', description: 'Send observed market-cap high alerts to a text channel', options: [
      { type: CHANNEL, name: 'target', description: 'Destination for new observed market-cap highs', required: true, channel_types: [0] },
      { type: NUMBER, name: 'min-increase', description: 'Minimum gain (at least 5%, default 5%)', required: false, min_value: 5, max_value: 100 },
    ] },
    { type: SUBCOMMAND, name: 'ath-off', description: 'Disable observed market-cap alerts' },
    { type: SUBCOMMAND, name: 'ath-status', description: 'Show observed highs and alert channel', options: [
      { type: INTEGER, name: 'page', description: 'Page number (default 1)', required: false, min_value: 1, max_value: 3 },
    ] },
    { type: SUBCOMMAND, name: 'ath-set', description: 'Record an externally checked historical MC high', options: [
      { type: STRING, name: 'token', description: 'Tracked symbol or contract address', required: true },
      { type: NUMBER, name: 'market-cap', description: 'Historical high USD value, e.g. 48700', required: true, min_value: 0.01 },
    ] },
    { type: SUBCOMMAND, name: 'ath-preview', description: 'Show exact live-format ATH card without changing high records', options: [
      { type: STRING, name: 'token', description: 'Tracked token symbol or contract (defaults to first token)', required: false },
      { type: CHANNEL, name: 'target', description: 'Preview destination (defaults to ATH channel or current channel)', required: false, channel_types: [0] },
      { type: NUMBER, name: 'increase', description: 'Simulated percentage gain (default 15)', required: false, min_value: 1, max_value: 100 },
    ] },
    { type: SUBCOMMAND, name: 'cleanup', description: 'Safely remove redundant bot-created data channels' },
    { type: SUBCOMMAND, name: 'help', description: 'Show tracker commands and setup instructions' },
  ],
};


const REGISTERED_COMMAND_REVISION = 6;

/** Register newly added slash commands once from the existing authenticated refresh. */
export async function syncTrackerCommandsIfNeeded(client, store, applicationId, guildId) {
  if (store.config.cv === REGISTERED_COMMAND_REVISION) return false;
  if (!/^\d{16,22}$/.test(String(applicationId ?? '')) ||
      !/^\d{16,22}$/.test(String(guildId ?? ''))) return false;
  await client.request('/applications/' + applicationId + '/guilds/' + guildId + '/commands', {
    method: 'PUT', body: [TRACKER_COMMAND],
  });
  store.config.cv = REGISTERED_COMMAND_REVISION;
  try {
    await saveStore(client, store);
  } catch (error) {
    delete store.config.cv;
    throw error;
  }
  return true;
}

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
  '• `/tracker ath-channel target:#ath-alerts` — alert for new observed MC highs (optional min-increase)',
  '• `/tracker ath-status` — show sampled highs and ATH reference',
  '• `/tracker ath-set token:DREAD market-cap:48700` — save historical ATH reference',
  '• `/tracker ath-preview` — show the exact live alert card without changing ATH records',
  '• `/tracker ath-off` — disable alerts',
  '• `/tracker rug-channel target:#rug-alerts` — warn on severe liquidity collapse',
  '• `/tracker rug-status` · `/tracker rug-preview` · `/tracker rug-off` — manage and test rug watch',
  '• `/tracker channel target:#crypto-prices` — move the public dashboard',
  '• `/tracker storage target:#my-private-channel` — choose the private storage channel; set roles/categories in Discord',
  '• `/tracker cleanup` — merge watchlists and remove safe duplicate bot-created storage channels',
  `Maximum: **${MAX_TOKENS} tokens**. Powered by DEX Screener (no paid API key).`,
].join('\n');

function optionValue(subcommand, name) {
  return subcommand.options?.find(x => x.name === name)?.value;
}

function findTracked(tokens,value) {
  const term=String(value||'').trim().toLowerCase();
  return term?tokens.filter(t=>String(t.address).toLowerCase()===term||
    String(t.symbol||'').toLowerCase()===term):[];
}

export async function executeTrackerCommand({ interaction, client, applicationId, fetcher }) {
  if (!isServerManager(interaction)) return 'You need the **Manage Server** permission to use tracker commands.';
  const guildId = interaction.guild_id;
  const command = interaction.data?.options?.[0];
  if (!command) return helpText;
  if (command.name === 'help') return helpText;

  if (command.name === 'storage') {
    const targetId = optionValue(command, 'target');
    try {
      const result = await selectStorageChannel(client, {
        guildId, targetId, fallbackDashboardChannelId: interaction.channel_id,
      });
      return `✅ Storage set to <#${result.channelId}>. Preserved **${result.tokens}** tracked tokens. Move that channel to any category and set its permissions in Discord. Keep SpicyTracker able to View Channel, Send Messages, and Read Message History. Use \`/tracker cleanup\` to remove old duplicates.`;
    } catch (error) {
      return `Could not set storage: ${safeText(error.message, 270)}`;
    }
  }
  if (command.name === 'cleanup') {
    const result = await cleanupStores(client, guildId);
    if (result.reason) return result.reason;
    return `✅ Kept storage <#${result.kept}> with **${result.tokens}** tokens. Removed **${result.removed.length}** redundant channels; skipped **${result.skipped.length}** channels with unsafe or unreadable content.`;
  }
  if (command.name === 'add') {
    const token = normalizeToken(optionValue(command, 'chain'), optionValue(command, 'address'));
    const pair = await fetchTokenPair(token, fetcher);
    if (!pair) return 'Could not find a priced base-token pool for this contract on that chain. Check the address and chain in DEX Screener.';
    const store = await loadStore(client, guildId);
    if (!store) return 'No data channel configured. Create a private text channel, then run `/tracker storage target:#your-private-channel` before adding tokens.';
    if (store.config.tokens.some(x => x.chain === token.chain && x.address === token.address)) return 'That token is already being tracked.';
    if (store.config.tokens.length >= MAX_TOKENS) return `This dashboard supports a maximum of ${MAX_TOKENS} tokens.`;
    const initialMc = Number(pair.marketCap);
    const baseline = pair.marketCap != null && Number.isFinite(initialMc) && initialMc > 0 ? initialMc : null;
    store.config.tokens.push({
      ...token, symbol: safeText(pair.baseToken?.symbol, 24) || undefined,
      ...(baseline === null ? {} : { h: baseline, a: baseline }),
    });
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
  if (!store) return 'No watchlist configured. Create a private text channel and run `/tracker storage target:#your-private-channel` to initialize storage.';
  // Upgrade legacy raw JSON storage to a readable embed without posting to the price dashboard.
  if (store.needsMigration) await saveStore(client, store);

  if (command.name === 'rug-channel') {
    const channelId = optionValue(command, 'target');
    if (!/^\d{16,22}$/.test(String(channelId ?? ''))) return 'Select a valid text channel.';
    if (channelId === store.configChannelId) return 'Rug alerts cannot go to the private storage channel.';
    const channels = await client.request('/guilds/' + guildId + '/channels');
    if (!Array.isArray(channels) || !channels.some(c => c.id === channelId && c.type === 0)) {
      return 'Select an existing text channel that SpicyTracker can view.';
    }
    store.config.rugChannelId = channelId;
    await saveStore(client, store);
    return '✅ Rug watch enabled in <#' + channelId +
      '>. It warns about a 95%+ liquidity drop, or 70%+ liquidity and 50%+ price drops within 15 minutes on the same pool. First refresh establishes baselines. These are warnings, not verified rugs.';
  }
  if (command.name === 'rug-off') {
    store.config.rugChannelId = null;
    await saveStore(client, store);
    return '✅ Suspected rug alerts disabled. Stored samples are retained for recovery.';
  }
  if (command.name === 'rug-status') {
    const sampled = store.config.tokens.filter(t => Array.isArray(t.r) && t.r.length >= 4).length;
    return '**Suspected rug watch**\nChannel: ' +
      (store.config.rugChannelId ? '<#' + store.config.rugChannelId + '>' : 'Disabled') +
      '\nTracked tokens: ' + store.config.tokens.length + '/' + MAX_TOKENS +
      '\nSampled pools: ' + sampled +
      '\nTrigger: ≥95% liquidity loss OR ≥70% liquidity loss and ≥50% price loss' +
      '\nOnly the same pool and samples ≤15 minutes apart; starting liquidity ≥$5,000' +
      '\n6-hour per-token cooldown · Data outages and pool switches never trigger a warning.' +
      '\nNot a fraud determination.';
  }
  if (command.name === 'rug-preview') {
    const channelId = optionValue(command, 'target') || store.config.rugChannelId || interaction.channel_id;
    if (!/^\d{16,22}$/.test(String(channelId ?? ''))) return 'Choose a valid text channel.';
    if (channelId === store.configChannelId) return 'Previews cannot go to the private storage channel.';
    const channels = await client.request('/guilds/' + guildId + '/channels');
    if (!Array.isArray(channels) || !channels.some(c => c.id === channelId && c.type === 0)) {
      return 'Choose an existing text channel in this server.';
    }
    if (!store.config.tokens.length) return 'Add a tracked token first.';
    const search = String(optionValue(command, 'token') || '').trim();
    const found = search ? findTracked(store.config.tokens, search) : [store.config.tokens[0]];
    if (!found.length) return 'No matching tracked token.';
    if (found.length > 1) return 'Multiple tokens share this symbol; use the contract address.';
    let pair;
    try { pair = await fetchTokenPair(found[0], fetcher); }
    catch (error) { return 'Cannot retrieve current market data for the rug preview.'; }
    if (!pair || !(Number(pair.priceUsd) > 0) || !(Number(pair.liquidity?.usd) > 0)) {
      return 'A live priced pool with known liquidity is required for a preview.';
    }
    // Simulate a 90% liquidity reduction and a 75% price reduction.
    const embed = createRugAlertEmbed(found[0], pair,
      Number(pair.liquidity.usd) * 10, Number(pair.priceUsd) * 4, new Date(), true);
    try {
      await client.request('/channels/' + channelId + '/messages', {
        method: 'POST', body: { embeds: [embed], allowed_mentions: { parse: [] } },
      });
    } catch (error) {
      return 'Could not send the preview. Grant SpicyTracker Send Messages and Embed Links in that channel.';
    }
    return { embeds: [embed] };
  }
  if (command.name === 'ath-channel') {
    const channelId = optionValue(command, 'target');
    const requested = optionValue(command, 'min-increase');
    const minPct = requested == null ? 5 : Number(requested);
    if (!/^\d{16,22}$/.test(String(channelId ?? ''))) return 'Select a valid text channel.';
    if (channelId === store.configChannelId) return 'Choose a different channel from private storage.';
    if (!Number.isFinite(minPct) || minPct < 5 || minPct > 100) return 'Minimum increase must be 5-100%.';
    const channels = await client.request('/guilds/' + guildId + '/channels');
    if (!Array.isArray(channels) || !channels.some(c => c.id === channelId && c.type === 0)) {
      return 'Select an existing text channel in this server that SpicyTracker can view.';
    }
    store.config.athChannelId = channelId;
    store.config.athMinPct = minPct;
    await saveStore(client, store);
    return '✅ High alerts enabled in <#' + channelId + '> with a ' + minPct + '% minimum gain and a 30-minute cooldown. Historical ATH references can be set with /tracker ath-set.';
  }
  if (command.name === 'ath-off') {
    store.config.athChannelId = null;
    await saveStore(client, store);
    return '✅ Observed market-cap high alerts disabled. Saved high records remain.';
  }
  if (command.name === 'ath-status') {
    const target = store.config.athChannelId ? '<#' + store.config.athChannelId + '>' : 'Disabled';
    const page = Number(optionValue(command, 'page')) || 1;
    const pageCount = Math.max(1, Math.ceil(store.config.tokens.length / 12));
    if (page > pageCount) return 'Page out of range (' + pageCount + ' total).';
    const lines = store.config.tokens.slice((page - 1) * 12, page * 12).map(t => {
      const high = Number(t.h);
      const reference=Number(t.b);
      return (safeText(t.symbol||t.name,24)||'Unknown')+' · '+t.chain.toUpperCase()+
        ': observed '+(Number.isFinite(high)&&high>0?'$'+high.toLocaleString('en-US',{maximumFractionDigits:2}):'not sampled')+
        (Number.isFinite(reference)&&reference>0?' · entered ATH $'+reference.toLocaleString('en-US',{maximumFractionDigits:2}):'');
    });
    return 'Observed market-cap highs\nChannel: ' + target +
      '\nMinimum increase: ' + Math.max(5,store.config.athMinPct??0) + '% · Cooldown: 30 minutes' +
      '\nPage ' + page + '/' + pageCount + '\n' + (lines.join('\n') || 'No tracked tokens') +
      '\nObserved highs are sampled; manually entered ATHs are not independently verified.';
  }


  if (command.name === 'ath-set') {
    const matches=findTracked(store.config.tokens,optionValue(command,'token'));
    if(!matches.length)return 'No matching tracked token. Supply its symbol or contract address.';
    if(matches.length>1)return 'Multiple tracked tokens share that symbol; use the contract address.';
    const value=Number(optionValue(command,'market-cap'));
    if(!Number.isFinite(value)||value<=0||value>1e15)return 'Invalid market cap amount in USD.';
    matches[0].b=value;
    await saveStore(client,store);
    return 'Historical ATH reference saved: $'+value.toLocaleString('en-US')+
      ' for '+(safeText(matches[0].symbol,24)||'token')+
      '. This user-entered value is not independently verified.';
  }

  if (command.name === 'ath-preview') {
    const search = String(optionValue(command, 'token') || '').trim().toLowerCase();
    const targetId = optionValue(command, 'target') || store.config.athChannelId || interaction.channel_id;
    const rawIncrease = optionValue(command, 'increase');
    const increase = rawIncrease == null ? 15 : Number(rawIncrease);
    if (!Number.isFinite(increase) || increase < 1 || increase > 100) return 'Preview increase must be between 1% and 100%.';
    if (!/^\d{16,22}$/.test(String(targetId ?? ''))) return 'Choose a valid text channel.';
    if (targetId === store.configChannelId) return 'Preview alerts cannot be sent to the private storage channel.';
    const channels = await client.request('/guilds/' + guildId + '/channels');
    if (!Array.isArray(channels) || !channels.some(c => c.id === targetId && c.type === 0)) {
      return 'Choose an existing text channel in this server.';
    }
    if (!store.config.tokens.length) return 'Track a token first with /tracker add.';
    const matches=search?findTracked(store.config.tokens,search):[store.config.tokens[0]];
    if (!matches.length) return 'No matching tracked token. Provide a symbol or contract address from /tracker list.';
    if (matches.length > 1) return 'Multiple tracked tokens share that symbol. Specify the contract address.';
    const token = matches[0];
    let pair;
    try {
      pair = await fetchTokenPair(token, fetcher);
    } catch (error) {
      console.error('[tracker:ath-preview] Live price lookup failed', error.message);
      return 'Unable to load a live price for the preview right now. Try again shortly.';
    }
    const liveMc=pair?.marketCap==null?null:Number(pair.marketCap);
    if(!Number.isFinite(liveMc)||liveMc<=0){
      return 'A live market cap is unavailable for this token. Try another tracked token.';
    }
    const previous=Math.max(liveMc,Number(token.h)||0,Number(token.b)||0);
    const simulatedMc=previous*(1+increase/100);
    const livePrice=Number(pair.priceUsd);
    const simulatedPrice=Number.isFinite(livePrice)&&livePrice>0?
      livePrice*simulatedMc/liveMc:pair.priceUsd;
    const scenario={...pair,marketCap:simulatedMc,priceUsd:simulatedPrice};
    const embed=createHighAlertEmbed(token,scenario,previous,simulatedMc,new Date());
    try {
      await client.request('/channels/' + targetId + '/messages', {
        method: 'POST',
        body: { embeds: [embed], allowed_mentions: { parse: [] } },
      });
    } catch (error) {
      console.error('[tracker:ath-preview] Failed to send simulated alert', error.message);
      return 'Could not send the preview. Give SpicyTracker View Channel, Send Messages and Embed Links in the selected channel.';
    }
    // Display the identical alert embed in the ephemeral command response too.
    // Previously Discord showed only a "Preview sent" text confirmation here,
    // making the real card hard to inspect when it posted in another channel.
    return { embeds: [embed] };
  }

  if (command.name === 'list') {
    await hydrateTokenSymbols(client, store, { fetcher });
    if (!store.config.tokens.length) return 'No tokens tracked yet. Dashboard: <#' + store.config.dashboardChannelId + '>.';
    const page = Number(optionValue(command, 'page')) || 1;
    const pageCount = Math.ceil(store.config.tokens.length / 12);
    if (page > pageCount) return 'Page out of range (' + pageCount + ' total).';
    const tick = String.fromCharCode(96);
    const lines = store.config.tokens.slice((page - 1) * 12, page * 12)
      .map((t, i) => ((page - 1) * 12 + i + 1) + '. **' +
        (safeText(t.symbol || t.name, 24) || 'Unknown token') + '** · ' +
        t.chain.toUpperCase() + ' · ' + tick + t.address + tick);
    return '**Tracked tokens (' + store.config.tokens.length + '/' + MAX_TOKENS +
      ') · Page ' + page + '/' + pageCount + ':**\n' + lines.join('\n') +
      '\nDashboard: <#' + store.config.dashboardChannelId + '> · Storage: <#' + store.configChannelId + '>';
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
    if (channelId === store.configChannelId) return 'Storage and dashboard must use different channels.';
    const channels = await client.request(`/guilds/${guildId}/channels`);
    if (!channels.some(x => x.id === channelId && x.type === 0)) return 'The target must be a text channel in this server.';
    const previous = { channelId: store.config.dashboardChannelId, messageId: store.config.dashboardMessageId,
      messageIds: store.config.dashboardMessageIds };
    delete store.config.dashboardMessageIds;
    store.config.dashboardChannelId = channelId;
    store.config.dashboardMessageId = null;
    await saveStore(client, store);
    try {
      await publishDashboard(client, store, { fetcher });
      if (previous.channelId !== channelId) {
        const oldIds = previous.messageIds?.length ? previous.messageIds :
          (previous.messageId ? [previous.messageId] : []);
        for (const oldId of oldIds) {
          try { await client.request('/channels/' + previous.channelId + '/messages/' + oldId, { method: 'DELETE' }); }
          catch (error) { console.warn('[tracker:old-dashboard]', error.message); }
        }
      }
      return `✅ Dashboard moved to <#${channelId}>.`;
    } catch (error) {
      // Restore the previous usable dashboard if a new channel is inaccessible.
      store.config.dashboardChannelId = previous.channelId;
      store.config.dashboardMessageId = previous.messageId;
      if (previous.messageIds?.length) store.config.dashboardMessageIds = previous.messageIds;
      else delete store.config.dashboardMessageIds;
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
