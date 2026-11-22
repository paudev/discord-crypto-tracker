import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStores, loadStore, publishDashboard, selectStorageChannel, serializeConfig } from '../src/tracker.js';
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
