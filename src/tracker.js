import { CONFIG_MARKER, MAX_TOKENS, safeText } from './discord.js';
import { fetchAllPairs, poolKey } from './dexscreener.js';
import { deflateRawSync, inflateRawSync, brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

const CONFIG_CHANNEL_NAME = 'crypto-tracker-data';
const VIEW_CHANNEL = 1024n;
const SEND_MESSAGES = 2048n;
const READ_HISTORY = 65536n;
const MANAGE_CHANNELS = 16n;
const EMBED_COLOR = 0x5865f2;

export function parseConfig(input) {
  const sources = typeof input === 'string' ? [{ text: input, fields: [] }] : [
    { text: input?.content, fields: [] },
    ...(Array.isArray(input?.embeds) ? input.embeds.map(embed =>
      ({ text: embed?.description, fields: embed?.fields || [] })) : []),
  ];
  for (const source of sources) {
    const text = String(source.text ?? '');
    let raw = text.startsWith(CONFIG_MARKER) ? text : null;
    if (!raw) {
      const start = text.indexOf('||' + CONFIG_MARKER);
      if (start >= 0) {
        const end = text.indexOf('||', start + 2);
        if (end >= 0) raw = text.slice(start + 2, end);
      }
    }
    if (!raw) continue;
    try {
      // Large 25-token watchlists append compressed-data chunks in embed fields.
      if ((raw.startsWith(CONFIG_MARKER + 'z:') || raw.startsWith(CONFIG_MARKER + 'b:')) && Array.isArray(source.fields)) {
        const rest = source.fields.filter(f => String(f.name).startsWith('Config continuation '));
        for (const field of rest) {
          const value = String(field.value ?? '');
          if (!value.startsWith('||') || !value.endsWith('||')) throw new Error('Invalid config continuation');
          raw += value.slice(2, -2);
        }
      }
      const encoded = raw.slice(CONFIG_MARKER.length);
      const data = JSON.parse(encoded.startsWith('b:')
        ? brotliDecompressSync(Buffer.from(encoded.slice(2), 'base64'),
          { maxOutputLength: 100_000 }).toString('utf8')
        : encoded.startsWith('z:')
          ? inflateRawSync(Buffer.from(encoded.slice(2), 'base64'),
            { maxOutputLength: 100_000 }).toString('utf8')
          : encoded);
      if (encoded.startsWith('b:')) {
        // Rebuild fields that were deliberately deduplicated in compact
        // storage. Old raw/z: records remain byte-for-byte compatible.
        for (const token of data.tokens || []) {
          const mask = Number(token._c) || 0;
          if (mask & 1) token.p = token.r?.[0];
          if ((mask & 2) && Array.isArray(token.q)) token.q[1] = token.r?.[0];
          delete token._c;
        }
      }
      if (data.version !== 1 || !Array.isArray(data.tokens) || data.tokens.length > MAX_TOKENS) continue;
      if (!/^\d{16,22}$/.test(data.dashboardChannelId)) continue;
      if (data.dashboardMessageId && !/^\d{16,22}$/.test(data.dashboardMessageId)) continue;
      if (data.dashboardMessageIds != null &&
          (!Array.isArray(data.dashboardMessageIds) || data.dashboardMessageIds.length > 5 ||
           !data.dashboardMessageIds.every(id => /^\d{16,22}$/.test(String(id))))) continue;
      if (data.athChannelId != null && !/^\d{16,22}$/.test(data.athChannelId)) continue;
      if (data.rugChannelId != null && !/^\d{16,22}$/.test(data.rugChannelId)) continue;
      if (data.selloffChannelId != null && !/^\d{16,22}$/.test(data.selloffChannelId)) continue;
      if (data.athMinPct != null && (!Number.isFinite(data.athMinPct) || data.athMinPct < 0 || data.athMinPct > 100)) continue;
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

export function serializeConfig(config) {
  const json = JSON.stringify(config);
  const raw = CONFIG_MARKER + json;
  // Keep raw and existing z: records compatible. Only dense watchlists need
  // stronger compression, avoiding a second message or paid external storage.
  let body = config.tokens?.length > 12 || raw.length > 3000
    ? CONFIG_MARKER + 'z:' + deflateRawSync(Buffer.from(json)).toString('base64')
    : raw;
  if (body.length > 5000) {
    const compact = { ...config, tokens: config.tokens.map(token => {
      const item = { ...token };
      let mask = 0;
      if (item.r?.[0] && item.p === item.r[0]) { delete item.p; mask |= 1; }
      if (item.r?.[0] && item.q?.[1] === item.r[0]) {
        item.q = [item.q[0]]; mask |= 2;
      }
      if (mask) item._c = mask;
      return item;
    }) };
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify(compact)), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    });
    body = CONFIG_MARKER + 'b:' + compressed.toString('base64');
  }
  if (body.length > 5500) throw new Error('Watchlist exceeds available private storage space.');
  return body;
}

const STORE_TOPIC = 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.';
const STORAGE_MARKER = '[SpicyTracker storage]';

export function createStorageEmbed(config, maxPreview = null) {
  const tokens = Array.isArray(config.tokens) ? config.tokens : [];
  // For large watchlists keep the private preview short to reserve space for
  // full, lossless compressed configuration and recorded ATH/rug/selloff history.
  // Reduce only the visible private preview if storage approaches Discord's cap.
  const previewCount = maxPreview == null ? (tokens.length > 12 ? 5 : 12) : maxPreview;
  const visible = tokens.slice(0, previewCount);
  const listing = tokens.length
    ? visible.map((token, i) => {
        const address = String(token.address ?? '');
        const short = address.length > 22 ? address.slice(0, 8) + '…' + address.slice(-6) : address;
        return (i + 1) + '. **' + (safeText(token.symbol || token.name, 24) || 'Unknown token') +
          '** · ' + String.fromCharCode(96) + short + String.fromCharCode(96);
      }).join('\n') + (tokens.length > visible.length
        ? '\n*+' + (tokens.length - visible.length) + ' more · Use /tracker list*' : '')
    : '*No tokens are currently saved in this watchlist.*';
  const title = '🔒 SpicyTracker · Private Storage';
  const footer = { text: 'Managed by SpicyTracker · Do not delete or edit this message' };
  const heading = [
    'This message stores your tracker settings. You can move this channel or restrict who can see it.',
    '',
    '**Tracked tokens**  **' + tokens.length + ' / ' + MAX_TOKENS + '**   ·   **Price dashboard**  <#' +
      config.dashboardChannelId + '>',
    '**Observed-high alerts**  ' + (config.athChannelId ? '<#' + config.athChannelId + '>' : 'Off'),
    '**Rug watch**  ' + (config.rugChannelId ? '<#' + config.rugChannelId + '>' : 'Off'),
    '**Large selloff alerts**  ' + (config.selloffChannelId ? '<#' + config.selloffChannelId + '>' : 'Off'),
    '',
    '**Watchlist**',
    listing,
    '',
    '**Internal configuration (click to reveal)**',
    '',
  ].join('\n');
  const configText = serializeConfig(config);
  const firstSize = Math.max(0, 4096 - heading.length - 4);
  const first = configText.slice(0, firstSize);
  const remaining = configText.slice(firstSize);
  const fields = [];
  for (let i = 0; i < remaining.length; i += 1000) {
    fields.push({ name: 'Config continuation ' + (fields.length + 1),
      value: '||' + remaining.slice(i, i + 1000) + '||', inline: false });
  }
  const description = heading + '||' + first + '||';
  const totalChars = title.length + description.length + footer.text.length +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (totalChars > 6000 && visible.length) return createStorageEmbed(config, 0);
  if (totalChars > 6000) throw new Error('Watchlist configuration exceeds Discord storage limits.');
  return { title, color: 0x5865f2, description, ...(fields.length ? { fields } : {}), footer };
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
  if (tokenMap.size > MAX_TOKENS) throw new Error('Combined tracked tokens exceed the ' + MAX_TOKENS + '-token limit; nothing was moved.');
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
    // Discord cannot display ANSI colors inline with normal Markdown. Use
    // native bold values and directional emoji without code-block padding.
    const movement = (value) => {
      const amount = asChange(value);
      if (amount === null) return '—';
      const marker = amount > 0 ? '🟩 ' : amount < 0 ? '🟥 ' : '';
      return marker + '**' + formatChange(amount) + '**';
    };
    return [
      heading,
      '**' + marketCapText(pair) + '** · Liq ' +
        formatCompact(pair.liquidity?.usd, { usd: true }),
      '24h ' + movement(pair.priceChange?.h24) +
        ' · 5m ' + movement(pair.priceChange?.m5),
      'Price **' + formatPrice(pair.priceUsd) + '**',
      links,
    ].join('\n');
  });
  const intro = '**' + entries.length + ' tracked token' +
    (entries.length === 1 ? '' : 's') + '** · Live DEX markets';
  // Every token has its own top and bottom boundary.
  // A blank line separates independent token sections.
  const separator = '────────────────────────────';
  return [{
    description: sections.length
      ? intro + '\n\n' +
        sections.map(section => separator + '\n' + section + '\n' + separator).join('\n\n')
      : 'No tracked tokens. Use /tracker add to begin.',
    color: 0x5865f2,
    footer: { text: 'DEX Screener · Indicative prices · ~1 min refresh' },
    timestamp: clock.toISOString(),
  }];
}

// Preserve the original single-message display for <=12 tokens. Larger
// dashboards use multiple independently edited messages (Discord 4096 limit).
export function createDashboardPages(entries, clock = new Date()) {
  const whole = createDashboardEmbeds(entries, clock);
  if (entries.length <= 12 && whole[0].description.length <= 3900) return [whole];
  const size = 10, pages = [], count = Math.ceil(entries.length / size);
  for (let i = 0; i < count; i++) {
    const embeds = createDashboardEmbeds(entries.slice(i * size, (i + 1) * size), clock);
    embeds[0].description = embeds[0].description.replace(
      /^\*\*\d+ tracked tokens?\*\* · Live DEX markets/,
      '**' + entries.length + ' tracked tokens** · Live DEX markets · ' + (i + 1) + '/' + count);
    if (embeds[0].description.length > 4096) throw new Error('Dashboard page exceeds Discord embed limit');
    pages.push(embeds);
  }
  return pages;
}

function dashboardMessageContent(){return "";}

export async function hydrateTokenSymbols(client,store,{fetcher,entries,persist=true}={}){
 const missing=store.config.tokens.filter(x=>!safeText(x.symbol,24));
 const pairs=entries||(missing.length?await fetchAllPairs(missing,fetcher):[]);
 let changed=false;
 for(const {token,pair} of pairs){
  const symbol=safeText(pair?.baseToken?.symbol,24);
  if(symbol&&symbol!==token.symbol){token.symbol=symbol;changed=true;}
 }
 if(changed&&persist)await saveStore(client,store);
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

export async function updateObservedHighs(client, store, entries, { now, persist = true } = {}) {
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
    // Exceptionally large one-minute jumps can reflect bad data from a DEX
    // pool. Require another consecutive reading before recording/announcing
    // an increase of >150% and at least $10k.
    const isSpike = marketCap > previous * 2.5 && marketCap - previous > 10_000;
    if (isSpike) {
      const ts = Math.floor(clock.getTime() / 1000);
      const key = poolKey(pair);
      const pending = Array.isArray(token.q) ? token.q : null;
      const elapsed = ts - (Number(pending?.[0]) || 0);
      if (!pending || pending[1] !== key || elapsed < 30 || elapsed > 300) {
        token.q = [ts, key];
        changed = true;
        continue;
      }
      delete token.q;
      changed = true;
    } else if (token.q) {
      delete token.q;
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
  if (changed && persist) await saveStore(client, store);
  return { alerts, athEnabled: Boolean(channelId) };
}

// DEX market data can flag a possible liquidity pull; it cannot prove fraud.
// Trigger only on fresh samples from the SAME pool (not a pool migration).
export const RUG_MIN_BASE_LIQUIDITY_USD = 5000;
export const RUG_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RUG_MAX_SAMPLE_GAP_MS = 15 * 60 * 1000;
const RUG_MAX_ALERTS_PER_REFRESH = 5;

export function createRugAlertEmbed(token, pair, beforeLiquidity, beforePrice, clock = new Date()) {
  const nowLiquidity = Number(pair.liquidity?.usd);
  const nowPrice = Number(pair.priceUsd);
  const liqDrop = (1 - nowLiquidity / beforeLiquidity) * 100;
  const priceDrop = (1 - nowPrice / beforePrice) * 100;
  const symbol = safeText(pair.baseToken?.symbol || token.symbol, 24) || 'Unknown token';
  const chart = dexChartUrl(pair);
  const tick = String.fromCharCode(96);
  return {
    title: '⚠️ Suspected rug · Liquidity collapse',
    description: [
      '**' + symbol + '** · ' + safeText(token.chain, 16).toUpperCase(),
      'Liquidity: **' + formatCompact(beforeLiquidity, { usd: true }) + '** → **' +
        formatCompact(nowLiquidity, { usd: true }) + '** (🟥 -' + liqDrop.toFixed(1) + '%)',
      'Price: **' + formatPrice(beforePrice) + '** → **' + formatPrice(nowPrice) +
        '** (' + (priceDrop > 0 ? '🟥 -' : '+') + Math.abs(priceDrop).toFixed(1) + '%)',
      (chart ? '[View chart](' + chart + ') · ' : '') +
        'CA ' + tick + shortAddress(token.address) + tick,
    ].join('\n'),
    color: 0xef4444,
    footer: { text: 'Suspicious market activity only · Not proof of fraud · DEX Screener sampled data' },
    timestamp: clock.toISOString(),
  };
}

export const EARLY_LIQUIDITY_DROP_PCT = 60;
export const EARLY_LIQUIDITY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const EARLY_LIQUIDITY_CONFIRM_MAX_SECONDS = 150;

export function createEarlyLiquidityAlertEmbed(token, pair, beforeLiquidity, clock = new Date()) {
  const nowLiquidity = Number(pair.liquidity?.usd);
  const dropPct = (1 - nowLiquidity / beforeLiquidity) * 100;
  const symbol = safeText(pair.baseToken?.symbol || token.symbol, 24) || 'Unknown token';
  const chart = dexChartUrl(pair);
  const tick = String.fromCharCode(96);
  return {
    title: '⚠️ Early Liquidity Warning',
    description: [
      '**' + symbol + '** · ' + safeText(token.chain, 16).toUpperCase(),
      'Liquidity (USD): **' + formatCompact(beforeLiquidity, { usd: true }) +
        '** → **' + formatCompact(nowLiquidity, { usd: true }) +
        '** (🟥 -' + dropPct.toFixed(1) + '%)',
      'Price: **' + formatPrice(pair.priceUsd) + '**',
      'Confirmed in two consecutive valid market readings from the same pool.',
      (chart ? '[View chart](' + chart + ') · ' : '') +
        'CA ' + tick + shortAddress(token.address) + tick,
    ].join('\n'),
    color: 0xf59e0b,
    footer: { text: 'Early warning · USD liquidity also changes with market prices · Not proof of LP withdrawal or rug' },
    timestamp: clock.toISOString(),
  };
}

export async function updateRugWatch(client, store, entries, { now, persist = true } = {}) {
  const channelId = store.config.rugChannelId;
  if (!channelId) return { rugAlerts: 0, earlyLiquidityAlerts: 0, rugEnabled: false };
  const clock = typeof now === 'function' ? now() : new Date();
  const ts = Math.floor(clock.getTime() / 1000);
  let rugAlerts = 0, earlyLiquidityAlerts = 0, changed = false;
  for (const { token, pair } of entries) {
    const prior = Array.isArray(token.r) ? token.r : null;
    if (!pair) {
      // A missing/API-failed reading must break an early-warning confirmation.
      if (Number(prior?.[5]) > 0) {
        token.r = [...prior.slice(0, 5), 0, Number(prior?.[6]) || 0];
        changed = true;
      }
      continue;
    }
    const liquidity = pair.liquidity?.usd == null ? NaN : Number(pair.liquidity.usd);
    const price = pair.priceUsd == null ? NaN : Number(pair.priceUsd);
    const key = poolKey(pair);
    if (!key || !Number.isFinite(liquidity) || liquidity < 0 ||
        !Number.isFinite(price) || price <= 0) continue;
    // Compact persisted sample:
    // [pool, baselineLiquidity, baselinePrice, sampledAt, rugAlertAt,
    //  pendingEarlyWarningAt, lastEarlyWarningAt].
    const lastRugAt = Number(prior?.[4]) || 0;
    const earlyAt = Number(prior?.[6]) || 0;
    const oldLiquidity = Number(prior?.[1]);
    const oldPrice = Number(prior?.[2]);
    const age = ts - (Number(prior?.[3]) || 0);
    const recent = prior?.[0] === key && age > 0 && age <= RUG_MAX_SAMPLE_GAP_MS / 1000;
    const healthy = oldLiquidity >= RUG_MIN_BASE_LIQUIDITY_USD &&
      Number.isFinite(oldPrice) && oldPrice > 0;
    const candidate = [key, Math.round(liquidity * 100) / 100,
      Number(price.toPrecision(9)), ts, lastRugAt, 0, earlyAt];
    if (!recent) {
      token.r = candidate;
      changed = true;
      continue;
    }
    if (!healthy) {
      if (liquidity >= RUG_MIN_BASE_LIQUIDITY_USD && liquidity > oldLiquidity * 1.25) {
        token.r = candidate;
        changed = true;
      } else if (Number(prior?.[5]) > 0) {
        token.r = [...prior.slice(0, 5), 0, earlyAt];
        changed = true;
      }
      continue;
    }
    const liquidityDrop = 1 - liquidity / oldLiquidity;
    const priceDrop = 1 - price / oldPrice;
    const critical = liquidityDrop >= 0.95 ||
      (liquidityDrop >= 0.70 && priceDrop >= 0.50);
    const rugCooldown = lastRugAt > 0 && clock.getTime() - lastRugAt * 1000 < RUG_ALERT_COOLDOWN_MS;
    let confirmedRugAt = lastRugAt;
    if (critical && !rugCooldown) {
      if (rugAlerts >= RUG_MAX_ALERTS_PER_REFRESH) continue;
      try {
        await client.request('/channels/' + channelId + '/messages', {
          method: 'POST', body: {
            embeds: [createRugAlertEmbed(token, pair, oldLiquidity, oldPrice, clock)],
            allowed_mentions: { parse: [] },
          },
        });
        confirmedRugAt = ts;
        rugAlerts++;
      } catch (error) {
        console.error('[tracker:rug] Could not alert for', token.chain, error.message);
        continue; // keep old baseline so the next refresh can retry
      }
    }
    // Critical conditions always take precedence over an early warning.
    let pendingAt = critical ? 0 : Number(prior?.[5]) || 0;
    let notifiedEarlyAt = earlyAt;
    const earlyCondition = !critical && liquidityDrop >= EARLY_LIQUIDITY_DROP_PCT / 100;
    const earlyCooldown = earlyAt > 0 && clock.getTime() - earlyAt * 1000 < EARLY_LIQUIDITY_COOLDOWN_MS;
    if (earlyCondition && !earlyCooldown) {
      const elapsed = ts - pendingAt;
      if (pendingAt > 0 && elapsed >= 30 && elapsed <= EARLY_LIQUIDITY_CONFIRM_MAX_SECONDS) {
        if (rugAlerts + earlyLiquidityAlerts < RUG_MAX_ALERTS_PER_REFRESH) {
          try {
            await client.request('/channels/' + channelId + '/messages', {
              method: 'POST', body: {
                embeds: [createEarlyLiquidityAlertEmbed(token, pair, oldLiquidity, clock)],
                allowed_mentions: { parse: [] },
              },
            });
            earlyLiquidityAlerts++;
            notifiedEarlyAt = ts;
            pendingAt = 0;
          } catch (error) {
            console.error('[tracker:liquidity] Could not post early warning for', token.chain, error.message);
            // Hold the baseline; a further valid reading can retry.
          }
        }
      } else if (!pendingAt || elapsed > EARLY_LIQUIDITY_CONFIRM_MAX_SECONDS) {
        pendingAt = ts;
      }
    } else {
      pendingAt = 0;
    }
    if (critical || liquidity > oldLiquidity * 1.25) {
      token.r = [candidate[0], candidate[1], candidate[2], candidate[3],
        confirmedRugAt, 0, notifiedEarlyAt];
      changed = true;
    } else if (pendingAt !== (Number(prior?.[5]) || 0) ||
               notifiedEarlyAt !== earlyAt) {
      token.r = [...prior.slice(0, 4), confirmedRugAt, pendingAt, notifiedEarlyAt];
      changed = true;
    }
  }
  if (changed && persist) await saveStore(client, store);
  return { rugAlerts, earlyLiquidityAlerts, rugEnabled: true };
}

// DEX Screener reports rolling price changes and buy/sell transaction counts.
// A selloff means bearish trading pressure, NOT a proven rug or liquidity pull.
// Reuse the market data already fetched for the once-per-minute dashboard.
export const SELLOFF_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const SELLOFF_MAX_ALERTS_PER_REFRESH = 5;
export const SELLOFF_RULES = Object.freeze({
  m5: { minPriceDropPct: 20, minTransactions: 20, minSellBuyRatio: 2 },
  h1: { minPriceDropPct: 35, minTransactions: 50, minSellBuyRatio: 2 },
  h6: { minPriceDropPct: 45, minTransactions: 100, minSellBuyRatio: 1.5 },
});

export function detectLargeSelloff(pair) {
  if (!pair) return null;
  for (const window of ['m5','h1','h6']) {
    const rule = SELLOFF_RULES[window];
    const change = pair.priceChange?.[window];
    const buysRaw = pair.txns?.[window]?.buys;
    const sellsRaw = pair.txns?.[window]?.sells;
    // No detection when market/transaction data is missing or malformed.
    if (change === null || change === undefined ||
        buysRaw === null || buysRaw === undefined ||
        sellsRaw === null || sellsRaw === undefined) continue;
    const priceChange = Number(change), buys = Number(buysRaw), sells = Number(sellsRaw);
    if (!Number.isFinite(priceChange) || !Number.isSafeInteger(buys) ||
        !Number.isSafeInteger(sells) || buys < 0 || sells < 0) continue;
    if (priceChange > -rule.minPriceDropPct || buys + sells < rule.minTransactions ||
        sells < rule.minSellBuyRatio * buys || sells === 0) continue;
    return { window, priceChange, buys, sells };
  }
  return null;
}

export function createSelloffAlertEmbed(token, pair, signal, clock = new Date()) {
  const symbol = safeText(pair?.baseToken?.symbol || token.symbol || token.name, 24) || 'Unknown token';
  const chain = safeText(token.chain, 16).toUpperCase();
  const chart = dexChartUrl(pair);
  const tick = String.fromCharCode(96);
  const period = signal.window === 'm5' ? '5 minutes' : signal.window === 'h1' ? '1 hour' : '6 hours';
  const ratio = signal.buys > 0 ? (signal.sells / signal.buys).toFixed(2) + '×' : 'No buys';
  return {
    title: signal.window === 'h6' ? '🟥 Slow Bleed Detected' : '🟥 Large Selloff Detected',
    description: [
      '**' + symbol + '** · ' + chain,
      'Price change (' + period + '): **' + signal.priceChange.toFixed(2) + '%**',
      'Buys: **' + signal.buys.toLocaleString('en-US') +
        '** · Sells: **' + signal.sells.toLocaleString('en-US') + '**',
      'Sell-to-buy transaction ratio: **' + ratio + '**',
      'Price: **' + formatPrice(pair?.priceUsd) + '** · Liq ' +
        formatCompact(pair?.liquidity?.usd, { usd: true }),
      (chart ? '[View chart](' + chart + ') · ' : '') +
        'CA ' + tick + shortAddress(token.address) + tick,
    ].join('\n'),
    color: 0xef4444,
    footer: { text: 'Trading-pressure warning · Sell/buy counts are transactions, not USD volume · Not proof of a rug' },
    timestamp: clock.toISOString(),
  };
}

export async function updateLargeSelloffs(client, store, entries, { now, persist = true } = {}) {
  const channelId = store.config.selloffChannelId;
  if (!channelId) return { selloffAlerts: 0, selloffEnabled: false };
  const clock = typeof now === 'function' ? now() : new Date();
  const timestamp = Math.floor(clock.getTime() / 1000);
  let alerts = 0, changed = false;
  for (const { token, pair } of entries) {
    const signal = detectLargeSelloff(pair);
    if (!signal) continue;
    const lastAlert = Number(token.s) || 0;
    if (lastAlert && clock.getTime() - lastAlert * 1000 < SELLOFF_ALERT_COOLDOWN_MS) continue;
    if (alerts >= SELLOFF_MAX_ALERTS_PER_REFRESH) break;
    try {
      await client.request('/channels/' + channelId + '/messages', {
        method: 'POST',
        body: { embeds: [createSelloffAlertEmbed(token, pair, signal, clock)],
          allowed_mentions: { parse: [] } },
      });
      token.s = timestamp; // Compact per-token cooldown; persists in private store.
      changed = true;
      alerts++;
    } catch (error) {
      console.error('[tracker:selloff] Could not post warning for', token.chain, error.message);
      // No cooldown after failure: retry on next refresh.
    }
  }
  if (changed && persist) await saveStore(client, store);
  return { selloffAlerts: alerts, selloffEnabled: true };
}

// Keep a compact per-token record of the most recent attempted market check:
// [checkedAtSeconds, 0=OK/1=no pool/2=API failure, poolSwitchedFlag].
// This enables diagnostics even when a later manual DEX lookup fails.
export function captureMarketDiagnostics(entries, clock = new Date()) {
  const ts = Math.floor(clock.getTime() / 1000);
  for (const { token, pair, error } of entries) {
    const current = poolKey(pair);
    const previous = token.p || token.r?.[0] || '';
    const switched = Boolean(current && previous && current !== previous);
    if (current) token.p = current;
    if (switched) delete token.q; // never confirm an ATH across distinct pools
    token.d = [ts, pair ? 0 : error ? 2 : 1, switched ? 1 : 0];
  }
}

// Read current stored state once before committing refreshed observations.
// Preserve channel configuration and token removals made during this refresh,
// and merge monotonic ATH/cooldown history. This lowers stale-write risk; since
// Discord does not offer conditional edits, it isn't a distributed CAS lock.
export async function saveRefreshState(client, store) {
  const url = '/channels/' + store.configChannelId + '/messages/' + store.configMessageId;
  try {
    const remoteMessage = await client.request(url, { allow404: true });
    const latest = parseConfig(remoteMessage);
    if (latest) {
      const localByKey = new Map(store.config.tokens.map(t => [t.chain + ':' + t.address, t]));
      const mergeMax = (a,b) => Math.max(Number(a) || 0, Number(b) || 0);
      const tokens = latest.tokens.map(remote => {
        const local = localByKey.get(remote.chain + ':' + remote.address);
        if (!local) return remote; // do not resurrect tokens removed by a command
        const merged = { ...remote };
        for (const property of ['h','a','t','s']) {
          const value = mergeMax(local[property], remote[property]);
          if (value) merged[property] = value;
        }
        if (!merged.b && local.b) merged.b = local.b;
        const older = Array.isArray(remote.r) ? remote.r : null;
        const newer = Array.isArray(local.r) ? local.r : null;
        if (newer || older) {
          const preferred = !older ? newer : !newer ? older :
            Number(newer[3] || 0) >= Number(older[3] || 0) ? newer : older;
          if (preferred) {
            merged.r = [...preferred];
            merged.r[4] = mergeMax(newer?.[4], older?.[4]);
            if (newer?.[5] || older?.[5]) merged.r[5] = Number(preferred?.[5]) || 0;
            merged.r[6] = mergeMax(newer?.[6], older?.[6]);
          }
        }
        const remoteAt = Number(remote.d?.[0]) || 0;
        const localAt = Number(local.d?.[0]) || 0;
        if (localAt >= remoteAt && Array.isArray(local.d)) {
          merged.d = local.d;
          if (local.p) merged.p = local.p;
          if (local.q) merged.q = local.q;
          else delete merged.q;
          if (local.symbol) merged.symbol = local.symbol;
        }
        return merged;
      });
      store.config = { ...latest, tokens };
    }
  } catch (error) {
    // Some test clients and transient Discord requests cannot read by message
    // ID. The regular save remains available, but a concurrent writer may race.
    console.warn('[tracker:reconcile] Could not reload latest storage', error.message);
  }
  await saveStore(client, store);
}

export function buildAlertDiagnostics(token, pair, config, clock = new Date(), lookupError = null) {
  const symbol = safeText(token.symbol || pair?.baseToken?.symbol || token.address, 24) || 'Unknown token';
  const d = Array.isArray(token.d) ? token.d : [];
  const lastAt = Number(d[0]) || 0;
  const status = d[1] === 0 ? 'Market data OK' : d[1] === 1 ? 'No priced pool' :
    d[1] === 2 ? 'DEX API error' : 'No saved sample yet';
  const pool = poolKey(pair) || token.p || token.r?.[0] || 'Unknown';
  const sell = detectLargeSelloff(pair);
  const sellCooldown = token.s && clock.getTime() - Number(token.s) * 1000 < SELLOFF_ALERT_COOLDOWN_MS;
  const mc = observedMarketCap(pair);
  const athBase = Math.max(Number(token.h) || 0, Number(token.b) || 0);
  const athCooldown = token.t && clock.getTime() - Number(token.t) * 1000 < ATH_ALERT_COOLDOWN_MS;
  const before = Array.isArray(token.r) ? token.r : [];
  const age = clock.getTime() / 1000 - (Number(before[3]) || 0);
  const samePool = Boolean(pair && before[0] && before[0] === pool);
  const baseline = Number(before[1]);
  const liquidity = pair?.liquidity?.usd == null ? NaN : Number(pair.liquidity.usd);
  const drop = samePool && age > 0 && age <= 900 && baseline >= RUG_MIN_BASE_LIQUIDITY_USD &&
    Number.isFinite(liquidity) ? (1 - liquidity / baseline) * 100 : null;
  const historicalPrice = Number(before[2]);
  const livePrice = Number(pair?.priceUsd);
  const priceDrop = drop != null && historicalPrice > 0 && Number.isFinite(livePrice)
    ? (1 - livePrice / historicalPrice) * 100 : null;
  const meetsCritical = drop !== null && (drop >= 95 ||
    (drop >= 70 && priceDrop !== null && priceDrop >= 50));
  const meetsEarly = drop !== null && !meetsCritical && drop >= EARLY_LIQUIDITY_DROP_PCT;
  const athNotificationBaseline = Math.max(Number(token.a) || Number(token.h) || 0,
    Number(token.b) || 0);
  const minAthPercent = Math.max(ATH_ALERT_MIN_INCREASE_PCT,
    Number(config.athMinPct) || 0);
  const athGain = athNotificationBaseline > 0 && mc !== null
    ? (mc / athNotificationBaseline - 1) * 100 : null;
  const athEligible = mc !== null && mc > (Number(token.h) || 0) &&
    athGain !== null && athGain >= minAthPercent;
  const criticalCooldown = before[4] && clock.getTime() - Number(before[4]) * 1000 < RUG_ALERT_COOLDOWN_MS;
  const earlyCooldown = before[6] && clock.getTime() - Number(before[6]) * 1000 < EARLY_LIQUIDITY_COOLDOWN_MS;
  const parts = [
    '**Alert Diagnostics · ' + symbol + '**',
    'Last scheduled check: ' + (lastAt ? '<t:' + lastAt + ':R> · ' + status : 'Not yet sampled'),
    'Selected pool: ' + String.fromCharCode(96) + safeText(pool, 24) + String.fromCharCode(96) +
      (d[2] ? ' · changed on latest check' : ''),
    'Live lookup: ' + (lookupError ? 'API error: ' + safeText(lookupError, 75) :
      pair ? 'Market data available' : 'No priced pool'),
    '**Selloff:** ' + (!config.selloffChannelId ? 'Disabled' : !pair ? 'Unavailable · market data missing' :
      sell ? (sell.window + ' conditions met' + (sellCooldown ? ' · cooldown active' : ' · eligible now')) :
      'No 5m, 1h or 6h condition met') +
      (token.s ? ' · last alert <t:' + Number(token.s) + ':R>' : ''),
    '**Rug/Liquidity:** ' + (!config.rugChannelId ? 'Disabled' :
      drop === null ? 'No recent same-pool baseline; waiting for samples' :
      drop.toFixed(1) + '% USD liquidity drop from baseline' +
        (meetsCritical ? ' · CRITICAL threshold met' :
          meetsEarly ? ' · early-warning threshold met' : ' · below warning thresholds') +
        (criticalCooldown ? ' · critical cooldown' : '') +
        (earlyCooldown ? ' · early-warning cooldown' : '') +
        (before[5] ? ' · confirmation pending' : '')),
    '**ATH:** ' + (!config.athChannelId ? 'Notifications off' :
      mc == null ? 'No live market cap' :
      'MC ' + formatCompact(mc, {usd:true}) + ' · recorded high ' +
        formatCompact(athBase, {usd:true}) +
        (athEligible ? ' · gain threshold met' : ' · no qualifying new high') +
        (athCooldown ? ' · cooldown active' : '') +
        (token.q ? ' · spike confirmation pending' : '')),
    '_Live market conditions may differ from the previous refresh; this is not a historical audit._',
  ];
  return parts.join('\n').slice(0, 1850);
}

// Coalesce overlapping refresh calls within one Node instance. Across
// separate serverless instances the pre-save reconciliation below reduces
// (but cannot eliminate) races without a transactional external database.
const inFlightDashboards = new Map();
export async function publishDashboard(client, store, options = {}) {
  const key = store.configChannelId + ':' + store.configMessageId;
  if (inFlightDashboards.has(key)) {
    return { ...(await inFlightDashboards.get(key)), coalesced: true };
  }
  const task = publishDashboardCore(client, store, options);
  inFlightDashboards.set(key, task);
  try { return await task; }
  finally { if (inFlightDashboards.get(key) === task) inFlightDashboards.delete(key); }
}

async function publishDashboardCore(client, store, { fetcher, now } = {}) {
  const tokens = store.config.tokens;
  const clock = typeof now === 'function' ? now() : new Date();
  const entries = await fetchAllPairs(tokens, fetcher);
  // Establish pool identity and check status before evaluating alert rules.
  captureMarketDiagnostics(entries, clock);
  // One state write instead of a separate edit for each alert family.
  await hydrateTokenSymbols(client, store, { entries, persist: false });
  const highs = await updateObservedHighs(client, store, entries, { now, persist: false });
  const rugs = await updateRugWatch(client, store, entries, { now, persist: false });
  const selloffs = await updateLargeSelloffs(client, store, entries, { now, persist: false });
  await saveRefreshState(client, store);
  const originalKeys = tokens.map(t => t.chain + ':' + t.address);
  const storedKeys = store.config.tokens.map(t => t.chain + ':' + t.address);
  if (originalKeys.join('|') !== storedKeys.join('|')) {
    // Avoid restoring deleted tokens or publishing a stale watchlist. The next
    // cron refresh will fetch the latest token selection.
    return { deferred: true, count: store.config.tokens.length, ...highs, ...rugs, ...selloffs };
  }
  const pages = createDashboardPages(entries, clock);
  const content = dashboardMessageContent(tokens.length);
  const channelId = store.config.dashboardChannelId;
  const previousIds = Array.isArray(store.config.dashboardMessageIds) && store.config.dashboardMessageIds.length
    ? store.config.dashboardMessageIds : (store.config.dashboardMessageId ? [store.config.dashboardMessageId] : []);
  const ids = [];
  let created = false;
  for (let i = 0; i < pages.length; i++) {
    const embeds = pages[i], oldId = previousIds[i];
    if (oldId) {
      const edited = await client.request('/channels/' + channelId + '/messages/' + oldId, {
        method: 'PATCH', body: { content, embeds, allowed_mentions: { parse: [] } }, allow404: true,
      });
      if (edited) { ids.push(oldId); continue; }
    }
    const posted = await client.request('/channels/' + channelId + '/messages', {
      method: 'POST', body: { content, embeds, allowed_mentions: { parse: [] } },
    });
    ids.push(posted.id);
    created = true;
  }
  const changed = ids.length !== previousIds.length || ids.some((id, i) => id !== previousIds[i]);
  if (changed) {
    store.config.dashboardMessageId = ids[0];
    if (ids.length > 1) store.config.dashboardMessageIds = ids;
    else delete store.config.dashboardMessageIds;
    await saveStore(client, store);
  }
  // Never delete old pages until the new identifiers have been persisted.
  for (const stale of previousIds.slice(pages.length)) {
    try { await client.request('/channels/' + channelId + '/messages/' + stale, { method: 'DELETE', allow404: true }); }
    catch (error) { console.warn('[tracker:pages] Could not remove old page:', error.message); }
  }
  return { created, updated: !created, count: tokens.length, messageId: ids[0], pages: ids.length, ...highs, ...rugs, ...selloffs };
}
