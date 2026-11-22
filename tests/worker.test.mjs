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

test('public Worker status reports deployed code and secret presence without leaking it', async () => {
  const response = worker.fetch(new Request('https://worker.example/status'), {
    REFRESH_SECRET: 'example-super-secret-value-12345',
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.service, 'discord-crypto-tracker');
  assert.equal(status.workerBuild, 'cron-diagnostics-v1');
  assert.equal(status.cronSchedule, '* * * * *');
  assert.equal(status.secretConfigured, true);
  assert.doesNotMatch(JSON.stringify(status), /example-super-secret-value/);
  assert.match(status.note, /HTTP requests do not trigger/);
  const missing = await worker.fetch(null, {}).json();
  assert.equal(missing.secretConfigured, false);
});

test('scheduled handler logs the invocation and refresh errors', async () => {
  const oldFetch = globalThis.fetch, oldLog = console.log, oldError = console.error;
  const logs = [], errors = [];
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    console.log = (...items) => logs.push(items);
    console.error = (...items) => errors.push(items);
    await assert.rejects(worker.scheduled({ cron: '* * * * *' }, {
      REFRESH_SECRET: 'example-super-secret-value-12345',
    }), /HTTP 401/);
    assert.match(logs[0][0], /Cron invocation started/);
    assert.match(errors[0][0], /Scheduled refresh failed/);
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
    console.error = oldError;
  }
});
