import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, loadStore, publishDashboard } from '../src/tracker.js';
import { executeTrackerCommand } from '../src/commands.js';

const GUILD = '123456789012345678';
const APP = '223456789012345678';
const GENERAL = '323456789012345678';
const PRIVATE = '423456789012345678';
const SOL = 'So11111111111111111111111111111111111111112';
let nextId = 100000000000000000n;
function createFakeDiscord() {
  const channels = [{ id: GENERAL, name: 'prices', type: 0 }];
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
      if (path === `/guilds/${GUILD}/channels` && method === 'POST') {
        const channel = { ...options.body, id: PRIVATE };
        channels.push(channel);
        return channel;
      }
      let m = path.match(/^\/channels\/(\d+)\/messages\?limit=30$/);
      if (m && method === 'GET') return messagesFor(m[1]);
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

test('first add creates private config channel and dashboard message, then remove persists', async () => {
  const client = createFakeDiscord();
  const add = await executeTrackerCommand({ interaction: interaction('add', [opt('chain', 'solana'), opt('address', SOL)]), client, applicationId: APP, fetcher: pairResponse });
  assert.match(add, /Added/);
  const configChannel = client.channels.find(x => x.id === PRIVATE);
  assert.equal(configChannel.permission_overwrites[0].deny, '1024');
  assert.equal(configChannel.permission_overwrites[1].id, APP);
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
  const state = await createStore(client, { guildId: GUILD, applicationId: APP, channelId: GENERAL });
  state.config.tokens = [{ chain: 'solana', address: SOL }];
  await publishDashboard(client, state, { fetcher: pairResponse });
  await publishDashboard(client, state, { fetcher: pairResponse });
  assert.equal(client.messages.get(GENERAL).length, 1);
  assert.equal(client.log.filter(x => x.method === 'PATCH' && x.path.startsWith(`/channels/${GENERAL}`)).length, 1);
});
