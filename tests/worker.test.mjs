import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { refreshCryptoTracker } from '../worker/index.js';

test('calls authenticated Vercel refresh every invocation', async () => {
  let called = null;
  const status = await refreshCryptoTracker({ REFRESH_SECRET: 'example-super-secret-value-12345' }, async (url, options) => {
    called = { url, options };
    return { ok: true, status: 200 };
  });
  assert.equal(status, 200);
  assert.equal(called.url, 'https://discord-crypto-tracker.vercel.app/api/refresh');
  assert.equal(called.options.headers.Authorization, 'Bearer example-super-secret-value-12345');
  assert.equal(called.options.method, 'POST');
});

test('rejects missing/short secret and upstream errors', async () => {
  await assert.rejects(refreshCryptoTracker({}), /REFRESH_SECRET/);
  await assert.rejects(refreshCryptoTracker({ REFRESH_SECRET: 'short' }), /REFRESH_SECRET/);
  await assert.rejects(refreshCryptoTracker({ REFRESH_SECRET: 'example-super-secret-value-12345' }, async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('public Worker URL is informational and never triggers a refresh', async () => {
  const response = worker.fetch();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /HTTP requests do not trigger/);
});
