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

export async function loadStore(client, guildId) {
  const channels = await client.request(`/guilds/${guildId}/channels`);
  if (!Array.isArray(channels)) throw new Error('Discord did not return server channels');
  for (const c of channels.filter(x => x.name === CONFIG_CHANNEL_NAME && x.type === 0)) {
    const messages = await client.request(`/channels/${c.id}/messages?limit=30`);
    const found = Array.isArray(messages) ? messages.find(m => parseConfig(m.content)) : null;
    if (found) return { configChannelId: c.id, configMessageId: found.id, config: parseConfig(found.content) };
  }
  return null;
}

export async function createStore(client, { guildId, applicationId, channelId }) {
  if (!/^\d{16,22}$/.test(channelId)) throw new Error('Invalid dashboard channel');
  const configChannel = await client.request(`/guilds/${guildId}/channels`, { method: 'POST', body: {
    name: CONFIG_CHANNEL_NAME,
    type: 0,
    topic: 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.',
    permission_overwrites: [
      { id: guildId, type: 0, deny: VIEW_CHANNEL.toString(), allow: '0' },
      { id: applicationId, type: 1, allow: (VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | MANAGE_CHANNELS).toString(), deny: '0' },
    ],
  } });
  const config = { version: 1, dashboardChannelId: channelId, dashboardMessageId: null, tokens: [] };
  const message = await client.request(`/channels/${configChannel.id}/messages`, { method: 'POST', body: {
    content: serializeConfig(config), allowed_mentions: { parse: [] },
  } });
  return { configChannelId: configChannel.id, configMessageId: message.id, config };
}

export async function ensureStore(client, params) {
  return await loadStore(client, params.guildId) || await createStore(client, params);
}

export async function saveStore(client, store) {
  await client.request(`/channels/${store.configChannelId}/messages/${store.configMessageId}`, {
    method: 'PATCH', body: { content: serializeConfig(store.config), allowed_mentions: { parse: [] } },
  });
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
   const capDisplay=Number.isFinite(marketCap)&&marketCap>0?`MC **${formatCompact(marketCap,{usd:true})}**`:Number.isFinite(fdv)&&fdv>0?`FDV **${formatCompact(fdv,{usd:true})}**`:"MC **N/A**";
   return {name:title,value:[
     `**${formatPrice(pair.priceUsd)}**  ·  5m **${formatChange(pair.priceChange?.m5)}**  ·  24h **${formatChange(pair.priceChange?.h24)}**`,
     `${capDisplay}  ·  Liq **${formatCompact(pair.liquidity?.usd,{usd:true})}**`,
     `CA \`${ca}\`${url?`  ·  [Chart](${url})`:""}`,
   ].join("\n"),inline:false};
 });
 return {title:"📈 SpicyTracker · Crypto Markets",description:entries.length?`${entries.length} token${entries.length===1?"":"s"} tracked · Auto-refresh ~1 min`:"No tracked tokens · Use `/tracker add` to get started",color:dashboardAccent(entries),fields,footer:{text:"DEX Screener · Prices are indicative"},timestamp:clock.toISOString()};
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
