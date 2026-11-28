import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authorizedBearer, verifyInteraction } from '../src/discord.js';
import { TRACKER_COMMAND, isServerManager } from '../src/commands.js';

test('authenticates valid Ed25519 Discord interactions and rejects tampered bodies', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('{"type":1}');
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
  const headers = { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp };
  assert.equal(verifyInteraction(body, headers, rawPub), true);
  assert.equal(verifyInteraction(Buffer.from('{"type":2}'), headers, rawPub), false);
  assert.equal(verifyInteraction(body, { ...headers, 'x-signature-timestamp': String(Number(timestamp) - 1000) }, rawPub), false);
  assert.equal(verifyInteraction(body, { ...headers, 'x-signature-ed25519': '00' }, rawPub), false);
});

test('requires authentic constant-time bearer token', () => {
  assert.equal(authorizedBearer('Bearer correct-123', 'correct-123'), true);
  assert.equal(authorizedBearer('Bearer wrong-123', 'correct-123'), false);
  assert.equal(authorizedBearer('Bearer correct-123', ''), false);
});

test('commands require server management permission', () => {
  assert.equal(isServerManager({ guild_id: '1', member: { permissions: '32' } }), true);
  assert.equal(isServerManager({ guild_id: '1', member: { permissions: '8' } }), true);
  assert.equal(isServerManager({ guild_id: '1', member: { permissions: '0' } }), false);
  assert.equal(isServerManager({ member: { permissions: '32' } }), false);
  assert.equal(TRACKER_COMMAND.default_member_permissions, '32');
  const names=TRACKER_COMMAND.options.map(x=>x.name);
  for(const required of ['add','remove','list','refresh','channel','storage','ath-channel',
    'ath-preview','ath-set','rug-channel','rug-preview','rug-off','rug-status',
    'selloff-channel','selloff-off','selloff-status','selloff-preview','alert-diagnostics','help']) {
    assert.ok(names.includes(required), 'Missing slash command '+required);
  }
  assert.equal(new Set(names).size,names.length);
  assert.ok(names.length<=25);
});
