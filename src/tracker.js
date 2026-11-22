import { CONFIG_MARKER, MAX_TOKENS, safeText } from './discord.js';
import { fetchAllPairs } from './dexscreener.js';

const CONFIG_CHANNEL_NAME = 'crypto-tracker-data';
const VIEW_CHANNEL = 1024n;
const SEND_MESSAGES = 2048n;
const READ_HISTORY = 65536n;
const MANAGE_CHANNELS = 16n;
const EMBED_COLOR = 0x5865f2;

export function parseConfig(content) {
  if (!String(content).startsWith(CONFIG_MARKER)) return null;
  try {
    const data = JSON.parse(String(content).slice(CONFIG_MARKER.length));
    if (data.version !== 1 || !Array.isArray(data.tokens) || data.tokens.length > MAX_TOKENS) return null;
    if (!/^\d{16,22}$/.test(data.dashboardChannelId)) return null;
    if (data.dashboardMessageId && !/^\d{16,22}$/.test(data.dashboardMessageId)) return null;
    return data;
  } catch { return null; }
}

export function serializeConfig(config) {
  const body = CONFIG_MARKER + JSON.stringify(config);
  if (body.length > 2000) throw new Error('Watchlist configuration exceeds Discord message limit.');
  return body;
}

const STORE_TOPIC = 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.';
const STORAGE_MARKER = '[SpicyTracker storage]';

async function inspectStores(client, guildId) {
  const channels = await client.request(`/guilds/${guildId}/channels`);
  if (!Array.isArray(channels)) throw new Error('Discord did not return server channels');
  const stores = [];
  for (const channel of channels.filter(c => c.type === 0 && (c.name === CONFIG_CHANNEL_NAME || String(c.topic || '').includes(STORAGE_MARKER)))) {
    try {
      const messages = await client.request(`/channels/${channel.id}/messages?limit=100`);
      if (!Array.isArray(messages)) throw new Error('Discord returned invalid configuration messages');
      const configs = messages.flatMap(message => {
        const config = parseConfig(message.content);
        return config ? [{ messageId: message.id, config }] : [];
      });
      const invalidConfig = messages.some(m => String(m.content ?? '').startsWith(CONFIG_MARKER) && !parseConfig(m.content));
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
    method: 'PATCH', body: { content: serializeConfig(store.config), allowed_mentions: { parse: [] } },
  });
}

/**
 * Bind storage to an existing text channel, without changing its category or
 * permissions. The user can move the channel and configure role visibility.
 */
export async function selectStorageChannel(client, { guildId, targetId, fallbackDashboardChannelId }) {
  const channels = await client.request(`/guilds/${guildId}/channels`);
  const target = Array.isArray(channels) && channels.find(x => x.id === targetId && x.type === 0);
  if (!target) throw new Error('Select an existing text channel in this server.');
  const inspected = await inspectStores(client, guildId);
  if (inspected.some(item => item.readError)) {
    throw new Error('Some existing storage channels are unreadable. Check bot View Channel and Read Message History permissions before moving storage.');
  }
  const targetMessages = await client.request(`/channels/${targetId}/messages?limit=100`);
  if (!Array.isArray(targetMessages)) throw new Error('Cannot read the selected storage channel.');
  if (targetMessages.some(message => !parseConfig(message.content))) {
    throw new Error('Choose an empty dedicated data channel. This channel contains other messages.');
  }
  const targetConfigs = targetMessages.flatMap(message => {
    const config = parseConfig(message.content);
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
  const existingMessage = targetMessages.find(message => parseConfig(message.content));
  const current = existingMessage ? { configChannelId: targetId, configMessageId: existingMessage.id, config } : null;
  if (current) await saveStore(client, current);
  else await client.request(`/channels/${targetId}/messages`, {
    method: 'POST', body: { content: serializeConfig(config), allowed_mentions: { parse: [] } },
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
      item.messages.every(m => Boolean(parseConfig(m.content)));
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
  const number = Number(n);
  if (!Number.isFinite(number)) return 'N/A';
  const absolute = Math.abs(number);
  let result;
  if (absolute >= 1e12) result = `${(number / 1e12).toFixed(2)}T`;
  else if (absolute >= 1e9) result = `${(number / 1e9).toFixed(2)}B`;
  else if (absolute >= 1e6) result = `${(number / 1e6).toFixed(2)}M`;
  else if (absolute >= 1e3) result = `${(number / 1e3).toFixed(2)}K`;
  else result = number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${usd ? '$' : ''}${result}`;
}
export function formatPrice(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return 'N/A';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  if (value >= 0.0001) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toPrecision(5).replace(/e\+?/, 'e')}`;
}

// Compact single-message dashboard. Discord supports one accent color per embed.
// Individual tokens get colored trend icons; the accent reflects the majority 24h trend.
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const NEUTRAL = 0x5865f2;

function asChange(value){if(value==null||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null;}

function formatChange(value){const n=asChange(value);return n===null?"—":`${n>0?"+":""}${n.toFixed(2)}%`;}

function trendIcon(value){const n=asChange(value);return n===null||n===0?"⚪":n>0?"🟢":"🔴";}

function shortAddress(address){const value=String(address??"");return value.length>20?`${value.slice(0,8)}…${value.slice(-6)}`:value;}

function dashboardAccent(entries){const changes=entries.map(({pair})=>asChange(pair?.priceChange?.h24)).filter(x=>x!==null);const positive=changes.filter(n=>n>0).length;const negative=changes.filter(n=>n<0).length;return positive>negative?GREEN:negative>positive?RED:NEUTRAL;}

export function createDashboardEmbed(entries,clock=new Date()){
 const fields=entries.map(({token,pair,error})=>{
   const symbol=safeText(pair?.baseToken?.symbol,18)||"Token";
   const ca=shortAddress(token.address);
   const title=`${trendIcon(pair?.priceChange?.h24)} ${symbol} · ${token.chain.toUpperCase()}`;
   if(!pair) return {name:`⚠️ ${symbol} · ${token.chain.toUpperCase()}`,value:[`**Price unavailable** · ${error?"API issue":"No qualifying pool"}`,`CA \`${ca}\``].join("\n"),inline:false};
   const rawUrl=String(pair.url||"");
   const url=/^https:\/\/dexscreener\.com\/[a-z0-9/_-]+$/i.test(rawUrl)?rawUrl:null;
   const marketCap=Number(pair.marketCap),fdv=Number(pair.fdv);
   const capDisplay=Number.isFinite(marketCap)&&marketCap>0
     ? formatCompact(marketCap,{usd:true}) : Number.isFinite(fdv)&&fdv>0
       ? formatCompact(fdv,{usd:true}) : 'N/A';
   const capLabel=Number.isFinite(marketCap)&&marketCap>0 ? 'MARKET CAP' : Number.isFinite(fdv)&&fdv>0 ? 'FULLY DILUTED VALUE' : 'MARKET CAP';
   return {name:title,value:[
     `💰 **${capLabel}**`,
     `**${capDisplay}**`,
     "",
     `**Price**  ${formatPrice(pair.priceUsd)}`,
     `**24h** ${trendIcon(pair.priceChange?.h24)} **${formatChange(pair.priceChange?.h24)}**  ·  **5m** ${formatChange(pair.priceChange?.m5)}`,
     `💧 **Liquidity**  ${formatCompact(pair.liquidity?.usd,{usd:true})}`,
     "",
     `${url ? `[View chart](${url})  ·  ` : ''}CA \`${ca}\``,
   ].join("\n"),inline:false};
 });
 return {title:"📈 SpicyTracker · Crypto Markets",description:entries.length?`${entries.length} token${entries.length===1?"":"s"} tracked · Updates the same message every minute`:"No tracked tokens · Use `/tracker add` to get started",color:dashboardAccent(entries),fields,footer:{text:"DEX Screener · Prices are indicative"},timestamp:clock.toISOString()};
}

export async function publishDashboard(client, store, { fetcher, now } = {}) {
  const tokens = store.config.tokens;
  const entries = await fetchAllPairs(tokens, fetcher);
  const embed = createDashboardEmbed(entries, now ? now() : new Date());
  const channelId = store.config.dashboardChannelId;
  let messageId = store.config.dashboardMessageId;
  if (messageId) {
    const response = await client.request(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH', body: { embeds: [embed], allowed_mentions: { parse: [] } }, allow404: true,
    });
    if (response) return { updated: true, count: tokens.length, messageId };
  }
  const created = await client.request(`/channels/${channelId}/messages`, { method: 'POST', body: {
    embeds: [embed], allowed_mentions: { parse: [] },
  } });
  messageId = created.id;
  store.config.dashboardMessageId = messageId;
  await saveStore(client, store);
  return { created: true, count: tokens.length, messageId };
}
