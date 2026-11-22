import { CONFIG_MARKER, MAX_TOKENS, safeText } from './discord.js';
import { fetchAllPairs } from './dexscreener.js';

const CONFIG_CHANNEL_NAME = 'crypto-tracker-data';
const VIEW_CHANNEL = 1024n;
const SEND_MESSAGES = 2048n;
const READ_HISTORY = 65536n;
const MANAGE_CHANNELS = 16n;
const EMBED_COLOR = 0x5865f2;

export function parseConfig(input) {
  const sources = typeof input === "string" ? [input] : [
    input?.content,
    ...(Array.isArray(input?.embeds) ? input.embeds.map(embed => embed?.description) : []),
  ];
  for (const candidate of sources) {
    const text = String(candidate ?? "");
    let raw = text.startsWith(CONFIG_MARKER) ? text : null;
    if (!raw) {
      const start = text.indexOf("||" + CONFIG_MARKER);
      if (start >= 0) {
        const end = text.indexOf("||", start + 2);
        if (end >= 0) raw = text.slice(start + 2, end);
      }
    }
    if (!raw) continue;
    try {
      const data = JSON.parse(raw.slice(CONFIG_MARKER.length));
      if (data.version !== 1 || !Array.isArray(data.tokens) || data.tokens.length > MAX_TOKENS) continue;
      if (!/^\d{16,22}$/.test(data.dashboardChannelId)) continue;
      if (data.dashboardMessageId && !/^\d{16,22}$/.test(data.dashboardMessageId)) continue;
      if (data.athChannelId != null && !/^\d{16,22}$/.test(data.athChannelId)) continue;
      if (data.athMinPct != null && (!Number.isFinite(data.athMinPct) || data.athMinPct < 0 || data.athMinPct > 100)) continue;
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

export function serializeConfig(config) {
  const body = CONFIG_MARKER + JSON.stringify(config);
  // The configuration is stored inside an embed spoiler (description limit
  // 4096), not plain message content (2000). Leave room for watchlist labels.
  if (body.length > 3000) throw new Error('Watchlist configuration exceeds private storage embed limit.');
  return body;
}

const STORE_TOPIC = 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.';
const STORAGE_MARKER = '[SpicyTracker storage]';

export function createStorageEmbed(config) {
  const tokens = Array.isArray(config.tokens) ? config.tokens : [];
  const listing = tokens.length
    ? tokens.map((token, i) => {
        const address = String(token.address ?? "");
        const short = address.length > 22 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
        return `${i + 1}. **${safeText(token.symbol || token.name, 24) || 'Unknown token'}** · \`${short}\``;
      }).join("\n")
    : "*No tokens are currently saved in this watchlist.*";
  return {
    title: "🔒 SpicyTracker · Private Storage",
    color: 0x5865f2,
    // Discord always renders description before fields, so keep all visible
    // settings above the private JSON spoiler in the description itself.
    description: [
      "This message stores your tracker settings. You can move this channel or restrict who can see it.",
      "",
      `**Tracked tokens**  **${tokens.length} / ${MAX_TOKENS}**   ·   **Price dashboard**  <#${config.dashboardChannelId}>`,
      `**Observed-high alerts**  ${config.athChannelId ? `<#${config.athChannelId}>` : 'Off'}`,
      "",
      "**Watchlist**",
      listing,
      "",
      "**Internal configuration (click to reveal)**",
      `||${serializeConfig(config)}||`,
    ].join("\n"),
    footer: { text: "Managed by SpicyTracker · Do not delete or edit this message" },
  };
}

function isFormattedStorageMessage(message) {
  return Array.isArray(message?.embeds) && message.embeds.some(embed => {
    const description = embed?.description;
    if (typeof description !== "string") return false;
    const watchlist = description.indexOf("**Watchlist**");
    const internalConfig = description.indexOf("**Internal configuration (click to reveal)**");
    // Detect the new bottom-aligned spoiler; old embeds with the spoiler
    // above the fields are migrated in place on the next /tracker list.
    return watchlist >= 0 && internalConfig > watchlist
      && description.includes("||" + CONFIG_MARKER);
  });
}

function hasConfigMarker(message) {
  return String(message?.content ?? "").startsWith(CONFIG_MARKER)
    || (Array.isArray(message?.embeds) && message.embeds.some(embed =>
      String(embed?.description ?? "").includes(CONFIG_MARKER)
    ));
}

async function inspectStores(client, guildId) {
  const channels = await client.request(`/guilds/${guildId}/channels`);
  if (!Array.isArray(channels)) throw new Error('Discord did not return server channels');
  const stores = [];
  for (const channel of channels.filter(c => c.type === 0 && (c.name === CONFIG_CHANNEL_NAME || String(c.topic || '').includes(STORAGE_MARKER)))) {
    try {
      const messages = await client.request(`/channels/${channel.id}/messages?limit=100`);
      if (!Array.isArray(messages)) throw new Error('Discord returned invalid configuration messages');
      const configs = messages.flatMap(message => {
        const config = parseConfig(message);
        return config ? [{ messageId: message.id, config, needsMigration: !isFormattedStorageMessage(message) }] : [];
      });
      const invalidConfig = messages.some(m => hasConfigMarker(m) && !parseConfig(m));
      stores.push({ channel, messages, configs, invalidConfig });
    } catch (readError) {
      stores.push({ channel, readError, configs: [], invalidConfig: false, messages: [] });
    }
  }
  return stores;
}

function preferredStore(inspections) {
  const choices = inspections.flatMap(item => item.configs.map(entry => ({
    configChannelId: item.channel.id,
    configMessageId: entry.messageId,
    config: entry.config,
    needsMigration: entry.needsMigration,
  })));
  const topics = new Map(inspections.map(x => [x.channel.id, String(x.channel.topic || '')]));
  choices.sort((a, b) =>
    Number(topics.get(b.configChannelId)?.includes(STORAGE_MARKER)) - Number(topics.get(a.configChannelId)?.includes(STORAGE_MARKER))
    || (BigInt(b.configMessageId) > BigInt(a.configMessageId) ? 1 : BigInt(b.configMessageId) < BigInt(a.configMessageId) ? -1 : 0)
    || b.config.tokens.length - a.config.tokens.length);
  return choices[0] || null;
}

export async function loadStore(client, guildId) {
  return preferredStore(await inspectStores(client, guildId));
}

export async function createStore(client, { guildId }) {
  // Storage channel creation is user-controlled. Never create a duplicate channel.
  const existing = await loadStore(client, guildId);
  if (existing) return existing;
  throw new Error('Choose a private storage channel with /tracker storage before adding tokens.');
}

export async function ensureStore(client, params) {
  return await loadStore(client, params.guildId) || await createStore(client, params);
}

export async function saveStore(client, store) {
  await client.request(`/channels/${store.configChannelId}/messages/${store.configMessageId}`, {
    method: 'PATCH', body: { content: '', embeds: [createStorageEmbed(store.config)], allowed_mentions: { parse: [] } },
  });
  store.needsMigration = false;
}

/**
 * Bind storage to an existing text channel, without changing its category or
 * permissions. The user can move the channel and configure role visibility.
 */
export async function selectStorageChannel(client, { guildId, targetId, fallbackDashboardChannelId }) {
  if (!/^\d{16,22}$/.test(String(targetId ?? ''))) {
    throw new Error('No channel selected. Run /tracker storage and choose a text channel in the required target field.');
  }
  const channels = await client.request(`/guilds/${guildId}/channels`);
  if (!Array.isArray(channels)) throw new Error('Could not retrieve the server channel list.');
  let target = channels.find(channel => channel.id === targetId);
  if (!target) {
    // Discord may omit permission-restricted channels from guild listings.
    // Check the selected ID directly before claiming that it does not exist.
    try {
      target = await client.request(`/channels/${targetId}`);
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        throw new Error('SpicyTracker cannot access that channel. In Edit Channel > Permissions, explicitly allow SpicyTracker View Channel, Read Message History, Send Messages and Manage Channels, then retry.');
      }
      throw error;
    }
  }
  if (target?.guild_id && target.guild_id !== guildId) {
    throw new Error('The selected channel belongs to a different Discord server.');
  }
  if (target?.type !== 0) {
    throw new Error('Select a standard text channel. Categories, threads, forums and voice channels cannot store tracker data.');
  }
  const inspected = await inspectStores(client, guildId);
  if (inspected.some(item => item.readError)) {
    throw new Error('Some existing storage channels are unreadable. Check bot View Channel and Read Message History permissions before moving storage.');
  }
  let targetMessages;
  try {
    targetMessages = await client.request(`/channels/${targetId}/messages?limit=100`);
  } catch (error) {
    if (error.status === 403) {
      throw new Error('SpicyTracker can find the selected channel but cannot read its messages. Allow Read Message History and View Channel for the bot.');
    }
    throw error;
  }
  if (!Array.isArray(targetMessages)) throw new Error('Cannot read the selected storage channel.');
  if (targetMessages.some(message => !parseConfig(message))) {
    throw new Error('Choose an empty dedicated data channel. This channel contains other messages.');
  }
  const targetConfigs = targetMessages.flatMap(message => {
    const config = parseConfig(message);
    return config ? [{ messageId: message.id, config }] : [];
  });
  const configs = [...inspected.flatMap(x => x.configs), ...targetConfigs];
  const active = preferredStore(inspected) || (targetConfigs[0]
    ? { configChannelId: targetId, configMessageId: targetConfigs[0].messageId, config: targetConfigs[0].config } : null);
  const tokenMap = new Map();
  for (const entry of configs) for (const token of entry.config.tokens) {
    tokenMap.set(`${token.chain}:${token.address}`, token);
  }
  if (tokenMap.size > MAX_TOKENS) throw new Error('Combined tracked tokens exceed the 12-token limit; nothing was moved.');
  const base = active?.config || { version: 1, dashboardChannelId: fallbackDashboardChannelId, dashboardMessageId: null, tokens: [] };
  if (!/^\d{16,22}$/.test(base.dashboardChannelId)) throw new Error('No valid dashboard channel configured.');
  if (base.dashboardChannelId === targetId) {
    throw new Error('The private data channel cannot also be the public dashboard channel. Choose another text channel.');
  }
  const config = { ...base, tokens: [...tokenMap.values()] };
  const existingMessage = targetMessages.find(message => parseConfig(message));
  const current = existingMessage ? { configChannelId: targetId, configMessageId: existingMessage.id, config } : null;
  if (current) await saveStore(client, current);
  else await client.request(`/channels/${targetId}/messages`, {
    method: 'POST', body: { content: '', embeds: [createStorageEmbed(config)], allowed_mentions: { parse: [] } },
  });
  const newTopic = [String(target.topic || '').replace(STORAGE_MARKER, '').trim(), STORAGE_MARKER].filter(Boolean).join(' · ').slice(0, 1024);
  await client.request(`/channels/${targetId}`, { method: 'PATCH', body: { topic: newTopic } });
  for (const previous of inspected) {
    if (previous.channel.id === targetId || !String(previous.channel.topic || '').includes(STORAGE_MARKER)) continue;
    const oldTopic = String(previous.channel.topic || '').replace(STORAGE_MARKER, '').replace(/ · $/, '').trim();
    try {
      await client.request(`/channels/${previous.channel.id}`, { method: 'PATCH', body: { topic: oldTopic } });
    } catch (error) {
      console.warn('[tracker:storage] Could not clear old channel marker:', previous.channel.id, error.message);
    }
  }
  return { channelId: targetId, tokens: config.tokens.length, reused: Boolean(existingMessage) };
}

export async function cleanupStores(client, guildId) {
  const inspected = await inspectStores(client, guildId);
  const primary = preferredStore(inspected);
  if (!primary) return { kept: null, removed: [], skipped: inspected.map(x => x.channel.id), tokens: 0, reason: 'No readable tracker configuration found; nothing was deleted.' };
  const unique = new Map();
  for (const entry of inspected.flatMap(x => x.configs)) {
    for (const token of entry.config.tokens) {
      if (!token || typeof token.chain !== 'string' || typeof token.address !== 'string') {
        return { kept: primary.configChannelId, removed: [], skipped: [], tokens: 0, reason: 'Invalid stored token; cleanup aborted without deleting anything.' };
      }
      unique.set(`${token.chain}:${token.address}`, token);
    }
  }
  if (unique.size > MAX_TOKENS) return { kept: primary.configChannelId, removed: [], skipped: [], tokens: unique.size, reason: `Combined watchlists contain ${unique.size} tokens (limit ${MAX_TOKENS}). Nothing was deleted.` };
  const newConfig = { ...primary.config, tokens: [...unique.values()] };
  await saveStore(client, { ...primary, config: newConfig });
  const removed = [];
  const skipped = [];
  for (const item of inspected) {
    if (item.channel.id === primary.configChannelId) continue;
    const botOwned = item.channel.topic === STORE_TOPIC || item.channel.topic === `${STORE_TOPIC} · ${STORAGE_MARKER}` || String(item.channel.topic || '').includes(STORAGE_MARKER);
    const onlyConfigMessages = !item.readError && !item.invalidConfig &&
      item.messages.every(m => Boolean(parseConfig(m)));
    if (!botOwned || !onlyConfigMessages) {
      skipped.push(item.channel.id);
      continue;
    }
    try {
      await client.request(`/channels/${item.channel.id}`, { method: 'DELETE' });
      removed.push(item.channel.id);
    } catch (error) {
      console.warn('[tracker:cleanup] Could not delete redundant channel:', item.channel.id, error.message);
      skipped.push(item.channel.id);
    }
  }
  return { kept: primary.configChannelId, removed, skipped, tokens: unique.size };
}

export function formatCompact(n, { usd = false } = {}) {
  if (n === null || n === undefined || n === '') return 'N/A';
  const number = Number(n);
  if (!Number.isFinite(number)) return 'N/A';
  const absolute = Math.abs(number);
  let result;
  // Avoid floating-point half-ties (56,005 -> 56.00K) on USD displays.
  const fixedCompact = (divisor) => (Math.round(number / divisor * 100 + Math.sign(number) * 1e-8) / 100).toFixed(2);
  if (absolute >= 1e12) result = `${fixedCompact(1e12)}T`;
  else if (absolute >= 1e9) result = `${fixedCompact(1e9)}B`;
  else if (absolute >= 1e6) result = `${fixedCompact(1e6)}M`;
  else if (absolute >= 1e3) result = `${fixedCompact(1e3)}K`;
  else result = number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${usd ? '$' : ''}${result}`;
}
export function formatPrice(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return 'N/A';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  if (value >= 0.0001) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return '$' + value.toPrecision(5).replace(/e\+?/, 'e')
    .replace(/(\.\d*?[1-9])0+(?=e|$)/, '$1')
    .replace(/\.0+(?=e|$)/, '');
}

// Readable multi-token sections with a separator, edited in one Discord message.
function asChange(value) {if(value==null||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null;}

function formatChange(value) {const n=asChange(value);return n===null?"—":(n>0?"+":"")+n.toFixed(2)+"%";}


// DESIGN CONTRACT: one edited message, one native embed, vivid brand border,

// dynamic token identities, market-cap-first layout and directional emojis only.

// Discord does not support per-word text colors; price-action emojis carry

// green/red cues while the embed border remains a constant Discord blurple.

function shortAddress(address){const value=String(address??"");return value.length>20?value.slice(0,8)+"…"+value.slice(-6):value;}

function dexChartUrl(pair){const value=String(pair?.url??"");return value.length<=104&&/^https:\/\/dexscreener\.com\/[a-z0-9/_-]+$/i.test(value)?value:null;}

function marketCapText(pair){const mc=Number(pair?.marketCap),fdv=Number(pair?.fdv);if(Number.isFinite(mc)&&mc>0)return "MC "+formatCompact(mc,{usd:true});if(Number.isFinite(fdv)&&fdv>0)return "FDV "+formatCompact(fdv,{usd:true});return "MC N/A";}


// The leading colored square is the entire movement indicator. Adding ▲/▼
// beside it caused wrapped glyphs and made the Discord dashboard hard to scan.
function priceAction(value) {
  const change = asChange(value);
  if (change === null) return '—';
  if (change > 0) return '🟩 ' + formatChange(change);
  if (change < 0) return '🟥 ' + formatChange(change);
  return formatChange(change);
}

// Colorize market data with ANSI in code fences; native headings and links stay outside.
const ANSI={off:'\x1b[0m',green:'\x1b[1;32m',red:'\x1b[1;31m',cyan:'\x1b[1;36m',white:'\x1b[1;37m'};
function color(v,tone=ANSI.white){return tone+v+ANSI.off;}
function code(lines){const ticks=String.fromCharCode(96).repeat(3);return ticks+'ansi\n'+lines.join('\n')+'\n'+ticks;}
function percentChange(v){const n=asChange(v);return n===null?'—':n>0?color('↑ +'+n.toFixed(2)+'%',ANSI.green):n<0?color('↓ '+n.toFixed(2)+'%',ANSI.red):'0.00%';}
export const ATH_ALERT_COOLDOWN_MS=30*60*1000;
export const ATH_ALERT_MIN_INCREASE_PCT=5;

// Preserve the compact dashboard layout. Each standalone separator has one blank
// line above it, including the starting and ending separator.
export function createDashboardEmbeds(entries, clock = new Date()) {
  const tick = String.fromCharCode(96);
  const sections = entries.map(({ token, pair, error }) => {
    const symbol = safeText(pair?.baseToken?.symbol || token.symbol || token.name, 24) || 'Unknown token';
    const chain = safeText(token.chain, 16).toUpperCase();
    const heading = '**' + symbol + '** · ' + chain;
    const chart = dexChartUrl(pair);
    const links = (chart ? '[View chart](' + chart + ') · ' : '') +
      'CA ' + tick + shortAddress(token.address) + tick;
    if (!pair) return [
      heading,
      '*Market data unavailable' + (error ? ' · API error' : ' · No priced pool') + '*',
      links,
    ].join('\n');
    return [
      heading,
      '**' + marketCapText(pair) + '** · Liq **' +
        formatCompact(pair.liquidity?.usd, { usd: true }) + '**',
      '24h **' + priceAction(pair.priceChange?.h24) +
        '** · 5m **' + priceAction(pair.priceChange?.m5) + '**',
      'Price **' + formatPrice(pair.priceUsd) + '**',
      links,
    ].join('\n');
  });
  const intro = '**' + entries.length + ' tracked token' +
    (entries.length === 1 ? '' : 's') + '** · Live DEX markets';
  const separator = '────────────';
  return [{
    description: sections.length
      ? intro + '\n\n' + separator + '\n' +
        sections.join('\n\n' + separator + '\n') +
        '\n\n' + separator
      : 'No tracked tokens. Use /tracker add to begin.',
    color: 0x5865f2,
    footer: { text: 'DEX Screener · Indicative prices · ~1 min refresh' },
    timestamp: clock.toISOString(),
  }];
}

function dashboardMessageContent(){return "";}

export async function hydrateTokenSymbols(client,store,{fetcher,entries}={}){
 const missing=store.config.tokens.filter(x=>!safeText(x.symbol,24));
 const pairs=entries||(missing.length?await fetchAllPairs(missing,fetcher):[]);
 let changed=false;
 for(const {token,pair} of pairs){
  const symbol=safeText(pair?.baseToken?.symbol,24);
  if(symbol&&symbol!==token.symbol){token.symbol=symbol;changed=true;}
 }
 if(changed)await saveStore(client,store);
 return changed;
}


/** DEX Screener's free endpoint provides current MC, not verified historical ATH. */
function observedMarketCap(pair) {
  if (pair?.marketCap == null || pair.marketCap === '') return null;
  const mc = Number(pair.marketCap);
  return Number.isFinite(mc) && mc > 0 ? mc : null;
}
export function createHighAlertEmbed(token,pair,previous,current,clock=new Date()){
  const symbol=safeText(pair?.baseToken?.symbol||token.symbol,24)||'Unknown token';
  const chain=safeText(token.chain,16).toUpperCase();
  const gain=(current/previous-1)*100;
  const chart=dexChartUrl(pair);
  const tick=String.fromCharCode(96);
  const manual=Number(token.b);
  return {
    title:'New market-cap high',
    description:[
      '**'+symbol+'** · '+chain,
      code([
        'NEW HIGH '+color(formatCompact(current,{usd:true}),ANSI.green),
        'PREVIOUS '+color(formatCompact(previous,{usd:true})),
        'GAIN     '+color('↑ +'+gain.toFixed(2)+'%',ANSI.green),
        'PRICE    '+color(formatPrice(pair?.priceUsd),ANSI.cyan),
      ]),
      (chart?'[View chart ↗]('+chart+') · ':'')+'CA '+tick+shortAddress(token.address)+tick,
    ].join('\n'),
    color:0x22c55e,
    footer:{text:Number.isFinite(manual)&&manual>0&&previous>=manual?
      'Manually recorded historical ATH · Not independently verified · DEX Screener':
      'Highest observed since tracking began · Not verified lifetime ATH · DEX Screener'},
    timestamp:clock.toISOString(),
  };
}

export async function updateObservedHighs(client, store, entries, { now } = {}) {
  let changed = false, alerts = 0;
  const configured = Number(store.config.athMinPct);
  const minimumPct = Math.max(ATH_ALERT_MIN_INCREASE_PCT, Number.isFinite(configured) && configured >= 0 ? configured : 0);
  const channelId = store.config.athChannelId;
  const clock = typeof now === 'function' ? now() : new Date();
  for (const { token, pair } of entries) {
    const marketCap = observedMarketCap(pair);
    if (marketCap === null) continue;
    const previous = Number(token.h);
    if (!Number.isFinite(previous) || previous <= 0) {
      token.h = marketCap;
      token.a = marketCap;
      changed = true;
      continue;
    }
    const lastNotified = Number(token.a);
    if (!Number.isFinite(lastNotified) || lastNotified <= 0) {
      token.a = previous;
      changed = true;
    }
    if (marketCap <= previous) continue;
    const manual=Number(token.b);
    const manualHigh=Number.isFinite(manual)&&manual>0?manual:0;
    const baseline=Math.max(Number(token.a)||previous,manualHigh);
    const alertedAt=Number(token.t)||0;
    const cooldownEnded=!alertedAt||clock.getTime()-alertedAt*1000>=ATH_ALERT_COOLDOWN_MS;
    const eligible=Boolean(channelId)&&cooldownEnded&&marketCap>Math.max(previous,manualHigh)
      &&marketCap>baseline&&((marketCap/baseline-1)*100+1e-9)>=minimumPct;
    token.h = marketCap;
    changed = true;
    if (!eligible) continue;
    try {
      await client.request('/channels/' + channelId + '/messages', {
        method: 'POST',
        body: { embeds: [createHighAlertEmbed(token, pair, baseline, marketCap, clock)], allowed_mentions: { parse: [] } },
      });
      token.a = marketCap;
      token.t = Math.floor(clock.getTime()/1000);
      alerts++;
    } catch (error) {
      token.h = previous;
      console.error('[tracker:ath] Alert could not be posted for', token.chain, error.message);
    }
  }
  if (changed) await saveStore(client, store);
  return { alerts, athEnabled: Boolean(channelId) };
}

export async function publishDashboard(client, store, { fetcher, now } = {}) {
  const tokens = store.config.tokens;
  const entries = await fetchAllPairs(tokens, fetcher);
  await hydrateTokenSymbols(client, store, { entries });
  const highs = await updateObservedHighs(client, store, entries, { now });
  const embeds = createDashboardEmbeds(entries, now ? now() : new Date());
  const content = dashboardMessageContent(tokens.length);
  const channelId = store.config.dashboardChannelId;
  let messageId = store.config.dashboardMessageId;
  if (messageId) {
    const response = await client.request(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH', body: { content, embeds, allowed_mentions: { parse: [] } }, allow404: true,
    });
    if (response) return { updated: true, count: tokens.length, messageId, ...highs };
  }
  const created = await client.request(`/channels/${channelId}/messages`, { method: 'POST', body: {
    content, embeds, allowed_mentions: { parse: [] },
  } });
  messageId = created.id;
  store.config.dashboardMessageId = messageId;
  await saveStore(client, store);
  return { created: true, count: tokens.length, messageId, ...highs };
}
