import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStores, createStorageEmbed, loadStore, publishDashboard, saveStore, selectStorageChannel, serializeConfig } from '../src/tracker.js';
import { executeTrackerCommand } from '../src/commands.js';

const GUILD = '123456789012345678';
const APP = '223456789012345678';
const GENERAL = '323456789012345678';
const PRIVATE = '423456789012345678';
const SOL = 'So11111111111111111111111111111111111111112';
let nextId = 100000000000000000n;
function createFakeDiscord() {
  const channels = [{ id: GENERAL, name: 'prices', type: 0 },
    { id: PRIVATE, name: 'crypto-tracker-data', type: 0, topic: '', permission_overwrites: [{ id: GUILD, type: 0, deny: '1024', allow: '0' }] }];
  const messages = new Map();
  const log = [];
  function messagesFor(channelId) { return messages.get(channelId) || []; }
  function id() { nextId += 1n; return String(nextId); }
  return {
    channels, messages, log,
    async request(path, options = {}) {
      const method = options.method ?? 'GET';
      log.push({ path, method, body: options.body });
      if (path === `/guilds/${GUILD}/channels` && method === 'GET') return channels;
      if (path === `/guilds/${GUILD}/channels` && method === 'POST') throw Error('Auto-creating data channels is forbidden');
      let m = path.match(/^\/channels\/(\d+)\/messages\?limit=100$/);
      if (m && method === 'GET') return messagesFor(m[1]);
      m = path.match(/^\/channels\/(\d+)$/);
      if (m && method === 'PATCH') {
        const channel = channels.find(x => x.id === m[1]);
        if (!channel) throw Error('Missing channel');
        Object.assign(channel, options.body);
        return channel;
      }
      if (m && method === 'DELETE') {
        const index = channels.findIndex(x => x.id === m[1]);
        if (index !== -1) channels.splice(index, 1);
        return {};
      }
      m = path.match(/^\/channels\/(\d+)\/messages$/);
      if (m && method === 'POST') {
        const item = { ...options.body, id: id() };
        messages.set(m[1], [item, ...messagesFor(m[1])]);
        return item;
      }
      m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/);
      if (m && method === 'PATCH') {
        const old = messagesFor(m[1]).find(x => x.id === m[2]);
        if (!old) return null;
        Object.assign(old, options.body);
        return old;
      }
      if (m && method === 'DELETE') return {};
      throw Error(`Unsupported Discord request: ${method} ${path}`);
    },
  };
}
function pairResponse(url) {
  const u = String(url);
  assert.match(u, /api\.dexscreener\.com/);
  return { ok: true, json: async () => [{ chainId: 'solana', baseToken: { address: SOL, symbol: 'SOL' }, priceUsd: '125', liquidity: { usd: 90000 }, priceChange: { m5: 1, h24: 2 } }] };
}
function interaction(sub, options = []) {
  return { guild_id: GUILD, channel_id: GENERAL, member: { permissions: '32' }, data: { options: [{ name: sub, options }] } };
}
function opt(name, value) { return { name, value }; }

test('storage selection uses existing channel without creating duplicates and preserves dashboard', async () => {
  const client = createFakeDiscord();
  const missing = await executeTrackerCommand({ interaction: interaction('add', [opt('chain', 'solana'), opt('address', SOL)]), client, applicationId: APP, fetcher: pairResponse });
  assert.match(missing, /No data channel configured/);
  const chosen = await executeTrackerCommand({ interaction: interaction('storage', [opt('target', PRIVATE)]), client, applicationId: APP });
  assert.match(chosen, /Storage set/);
  const add = await executeTrackerCommand({ interaction: interaction('add', [opt('chain', 'solana'), opt('address', SOL)]), client, applicationId: APP, fetcher: pairResponse });
  assert.match(add, /Added/);
  const configChannel = client.channels.find(x => x.id === PRIVATE);
  assert.equal(configChannel.permission_overwrites[0].deny, '1024');
  assert.equal(configChannel.permission_overwrites.length, 1);
  assert.equal(client.log.filter(x => x.path === `/guilds/${GUILD}/channels` && x.method === 'POST').length, 0);
  let state = await loadStore(client, GUILD);
  assert.equal(state.config.tokens.length, 1);
  assert.equal(state.config.tokens[0].address, SOL);
  assert.equal(client.messages.get(GENERAL).length, 1);
  const duplicate = await executeTrackerCommand({ interaction: interaction('add', [opt('chain', 'solana'), opt('address', SOL)]), client, applicationId: APP, fetcher: pairResponse });
  assert.match(duplicate, /already/);
  const listing = await executeTrackerCommand({ interaction: interaction('list'), client, applicationId: APP });
  assert.match(listing, /1\/12/);
  const removed = await executeTrackerCommand({ interaction: interaction('remove', [opt('address', SOL)]), client, applicationId: APP });
  assert.match(removed, /Removed/);
  state = await loadStore(client, GUILD);
  assert.equal(state.config.tokens.length, 0);
  assert.equal(client.messages.get(GENERAL).length, 1);
});

test('refresh edits existing dashboard instead of spamming channels', async () => {
  const client = createFakeDiscord();
  const state = await selectStorageChannel(client, { guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL });
  const stored = await loadStore(client, GUILD);
  stored.config.tokens = [{ chain: 'solana', address: SOL }];
  await publishDashboard(client, stored, { fetcher: pairResponse });
  await publishDashboard(client, stored, { fetcher: pairResponse });
  assert.equal(client.messages.get(GENERAL).length, 1);
  assert.equal(client.log.filter(x => x.method === 'PATCH' && x.path.startsWith(`/channels/${GENERAL}`)).length, 1);
});


test('selecting a private storage channel does not overwrite categories or role permissions', async () => {
  const client = createFakeDiscord();
  const storage = client.channels.find(c => c.id === PRIVATE);
  storage.parent_id = '523456789012345678';
  const perms = JSON.stringify(storage.permission_overwrites);
  const chosen = await executeTrackerCommand({ interaction: interaction('storage', [opt('target', PRIVATE)]),
    client, applicationId: APP });
  assert.match(chosen, /Storage set/);
  assert.equal(storage.parent_id, '523456789012345678');
  assert.equal(JSON.stringify(storage.permission_overwrites), perms);
  storage.name = 'my-secret-storage';
  const afterRename = await loadStore(client, GUILD);
  assert.equal(afterRename.configChannelId, PRIVATE);
});

test('cleanup preserves tracked tokens and only deletes safe redundant channels on explicit command', async () => {
  const client = createFakeDiscord();
  const duplicateId = '623456789012345678';
  const duplicate = { id: duplicateId, name: 'crypto-tracker-data', type: 0,
    topic: 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.' };
  client.channels.push(duplicate);
  const oldConfig = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  client.messages.set(duplicateId, [{ id: '723456789012345678', content: serializeConfig(oldConfig) }]);
  const chosen = await selectStorageChannel(client, { guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL });
  assert.equal(chosen.tokens, 1);
  assert.equal(client.channels.length, 3);
  const result = await cleanupStores(client, GUILD);
  assert.deepEqual(result.removed, [duplicateId]);
  assert.equal(client.channels.length, 2);
  assert.equal((await loadStore(client, GUILD)).config.tokens.length, 1);
  assert.equal(client.log.filter(x => x.path === `/channels/${duplicateId}` && x.method === 'DELETE').length, 1);
});

test('storage selection rejects channels with unrelated messages, preserving existing configuration', async () => {
  const client = createFakeDiscord();
  client.messages.set(PRIVATE, [{ id: '823456789012345678', content: 'A normal human message' }]);
  await assert.rejects(selectStorageChannel(client, {
    guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL,
  }), /contains other messages/);
  assert.equal(client.log.filter(x => x.method === 'DELETE').length, 0);
});

test('storage command explains when required target channel was not selected', async () => {
  const client = createFakeDiscord();
  const result = await executeTrackerCommand({ interaction: interaction('storage', []), client, applicationId: APP });
  assert.match(result, /No channel selected/);
  assert.equal(client.log.some(x => x.method === 'POST'), false);
});

test('storage falls back to a direct Discord channel lookup when guild listing omits it', async () => {
  const client = createFakeDiscord();
  const original = client.request.bind(client);
  const proxy = {
    ...client,
    async request(path, options) {
      if (path === `/guilds/${GUILD}/channels`) return client.channels.filter(x => x.id !== PRIVATE);
      if (path === `/channels/${PRIVATE}` && (options?.method || 'GET') === 'GET') {
        return { ...client.channels.find(x => x.id === PRIVATE), guild_id: GUILD };
      }
      return original(path, options);
    },
  };
  const result = await selectStorageChannel(proxy, {
    guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL,
  });
  assert.equal(result.channelId, PRIVATE);
  assert.equal(client.messages.get(PRIVATE).length, 1);
  assert.equal(client.channels.length, 2);
});

test('private channel without bot access gives an actionable permission error', async () => {
  const client = createFakeDiscord();
  const original = client.request.bind(client);
  const proxy = {
    ...client,
    async request(path, options) {
      if (path === `/guilds/${GUILD}/channels`) return client.channels.filter(x => x.id !== PRIVATE);
      if (path === `/channels/${PRIVATE}`) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return original(path, options);
    },
  };
  await assert.rejects(selectStorageChannel(proxy, {
    guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL,
  }), /cannot access that channel.*View Channel/);
  assert.equal(client.messages.has(PRIVATE), false);
});

test('storage rejects channels belonging to another guild', async () => {
  const client = createFakeDiscord();
  const original = client.request.bind(client);
  const proxy = {
    ...client,
    async request(path, options) {
      if (path === `/guilds/${GUILD}/channels`) return client.channels.filter(x => x.id !== PRIVATE);
      if (path === `/channels/${PRIVATE}`) {
        return { ...client.channels.find(x => x.id === PRIVATE), guild_id: '999999999999999999' };
      }
      return original(path, options);
    },
  };
  await assert.rejects(selectStorageChannel(proxy, {
    guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL,
  }), /different Discord server/);
});


test('new storage displays a readable embed and hides machine data in spoiler', async () => {
  const client = createFakeDiscord();
  await selectStorageChannel(client, { guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL });
  const message = client.messages.get(PRIVATE)[0];
  assert.equal(message.content, '');
  assert.equal(message.embeds.length, 1);
  assert.match(message.embeds[0].title, /SpicyTracker · Private Storage/);
  assert.match(message.embeds[0].description, /\|\|CRYPTO_TRACKER_CONFIG_V1/);
  assert.match(message.embeds[0].description, /\*\*Tracked tokens\*\*  \*\*0 \/ 12\*\*/);
  const loaded = await loadStore(client, GUILD);
  assert.equal(loaded.config.dashboardChannelId, GENERAL);
  assert.equal(loaded.needsMigration, false);
});

test('legacy JSON storage remains readable and becomes formatted when saved', async () => {
  const client = createFakeDiscord();
  const legacy = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  const id = '923456789012345678';
  client.messages.set(PRIVATE, [{ id, content: serializeConfig(legacy) }]);
  const store = await loadStore(client, GUILD);
  assert.equal(store.needsMigration, true);
  assert.equal(store.config.tokens.length, 1);
  await saveStore(client, store);
  const message = client.messages.get(PRIVATE)[0];
  assert.equal(message.content, '');
  assert.match(message.embeds[0].description, /\*\*Tracked tokens\*\*  \*\*1 \/ 12\*\*/);
  const reloaded = await loadStore(client, GUILD);
  assert.equal(reloaded.needsMigration, false);
  assert.deepEqual(reloaded.config.tokens, legacy.tokens);
});

test('storage conversion preserves previously tracked token when switching channels', async () => {
  const client = createFakeDiscord();
  const other = '623456789012345678';
  const originalConfig = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  client.channels.push({ id: other, type: 0, name: 'crypto-tracker-data',
    topic: 'Private machine-readable watchlist for the Discord Crypto Tracker bot. Do not remove this channel.' });
  client.messages.set(other, [{ id: '723456789012345678', content: serializeConfig(originalConfig) }]);
  const result = await selectStorageChannel(client, { guildId: GUILD, targetId: PRIVATE,
    fallbackDashboardChannelId: GENERAL });
  assert.equal(result.tokens, 1);
  const message = client.messages.get(PRIVATE)[0];
  assert.equal(message.content, '');
  const storage = await loadStore(client, GUILD);
  assert.equal(storage.config.tokens.length, 1);
  assert.equal(storage.config.tokens[0].address, SOL);
});

test('formatted storage embeds preserve configuration on save and through cleanup', async () => {
  const client = createFakeDiscord();
  const config = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  const item = createStorageEmbed(config);
  assert.ok(item.description.includes('||CRYPTO_TRACKER_CONFIG_V1'));
  assert.match(item.description, /SOLANA/);
  await selectStorageChannel(client, { guildId: GUILD, targetId: PRIVATE, fallbackDashboardChannelId: GENERAL });
  const result = await cleanupStores(client, GUILD);
  assert.equal(result.kept, PRIVATE);
  assert.deepEqual(result.removed, []);
});

test('the private configuration spoiler appears strictly after the watchlist', () => {
  const cfg = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  const embed = createStorageEmbed(cfg);
  const description = embed.description;
  assert.equal(embed.fields, undefined);
  assert.ok(description.indexOf('**Tracked tokens**') < description.indexOf('**Watchlist**'));
  assert.ok(description.indexOf('**Watchlist**') < description.indexOf('**Internal configuration'));
  assert.ok(description.indexOf('**Internal configuration') < description.indexOf('||CRYPTO_TRACKER_CONFIG_V1'));
  assert.ok(description.length <= 4096);
});

test('old formatted storage embeds are migrated to bottom spoiler in the same message', async () => {
  const client = createFakeDiscord();
  const existingConfig = { version: 1, dashboardChannelId: GENERAL, dashboardMessageId: null,
    tokens: [{ chain: 'solana', address: SOL }] };
  const legacyEmbed = {
    description: 'This message stores your tracker settings.\\n\\n**Internal configuration (click to reveal)**\\n||' +
      serializeConfig(existingConfig) + '||',
    fields: [{ name: 'Tracked tokens', value: '**1 / 12**' }],
  };
  client.messages.set(PRIVATE, [{
    id: '923456789012345678', content: '', embeds: [legacyEmbed],
  }]);
  const store = await loadStore(client, GUILD);
  assert.equal(store.needsMigration, true);
  await saveStore(client, store);
  const updated = client.messages.get(PRIVATE)[0];
  assert.equal(updated.id, '923456789012345678');
  assert.ok(updated.embeds[0].description.indexOf('**Watchlist**') <
    updated.embeds[0].description.indexOf('**Internal configuration'));
  assert.equal((await loadStore(client, GUILD)).needsMigration, false);
  assert.deepEqual((await loadStore(client, GUILD)).config.tokens, existingConfig.tokens);
});
