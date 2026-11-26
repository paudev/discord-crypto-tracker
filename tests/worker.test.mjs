import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { refreshCryptoTracker, refreshRugWatch, runScheduledCycle, RUG_CHECK_OFFSET_MS } from '../worker/index.js';

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
  assert.equal(status.workerBuild, 'rug-30s-v2');
  assert.match(status.rugPollInterval, /30 seconds/);
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

test('authenticates the new rug-only endpoint without starting dashboard refresh', async () => {
  let url, method, auth;
  const status = await refreshRugWatch({ REFRESH_SECRET: 'example-super-secret-value-12345' },
    async (request, options) => {
      url=request;method=options.method;auth=options.headers.Authorization;
      return {ok:true,status:200};
    });
  assert.equal(status,200);
  assert.equal(url,'https://discord-crypto-tracker.vercel.app/api/rug-refresh');
  assert.equal(method,'POST');
  assert.equal(auth,'Bearer example-super-secret-value-12345');
  await assert.rejects(refreshRugWatch({REFRESH_SECRET:'invalid'}),/REFRESH_SECRET/);
  await assert.rejects(refreshRugWatch({REFRESH_SECRET:'example-super-secret-value-12345'},
    async()=>({ok:false,status:502})),/HTTP 502/);
});

test('one scheduled invocation runs standard refresh and rug-only refresh 30 seconds apart',async()=>{
  const urls=[],waits=[];
  let clock=1000;
  const result=await runScheduledCycle({REFRESH_SECRET:'example-super-secret-value-12345'},{
    fetcher:async url=>{urls.push(url);return {ok:true,status:200,json:async()=>({rugEnabled:true})};},
    sleep:async ms=>{waits.push(ms);clock+=ms;},
    now:()=>clock,
  });
  assert.deepEqual(urls,[
    'https://discord-crypto-tracker.vercel.app/api/refresh',
    'https://discord-crypto-tracker.vercel.app/api/rug-refresh',
  ]);
  assert.deepEqual(waits,[RUG_CHECK_OFFSET_MS]);
  assert.equal(result.rugPolled,true);
  assert.equal(result.rugStatus,200);
});

test('slow primary refresh safely skips mid-minute poll before next cron',async()=>{
  const urls=[],waits=[];
  let clock=1000;
  const result=await runScheduledCycle({REFRESH_SECRET:'example-super-secret-value-12345'},{
    fetcher:async url=>{urls.push(url);clock+=46000;return {ok:true,status:200,json:async()=>({rugEnabled:true})};},
    sleep:async ms=>waits.push(ms),
    now:()=>clock,
  });
  assert.equal(result.rugPolled,false);
  assert.equal(urls.length,1);
  assert.deepEqual(waits,[]);
});

test('a slow but successful primary refresh sleeps only the remaining time',async()=>{
  const waits=[];
  let clock=1000;
  const result=await runScheduledCycle({REFRESH_SECRET:'example-super-secret-value-12345'},{
    fetcher:async url=>{
      if(url.endsWith('/api/refresh'))clock+=12000;
      return {ok:true,status:200,json:async()=>({rugEnabled:true})};
    },
    sleep:async ms=>{waits.push(ms);clock+=ms;},
    now:()=>clock,
  });
  assert.deepEqual(waits,[18000]);
  assert.equal(result.rugPolled,true);
});

test('disabled rug watch never makes an extra Vercel invocation',async()=>{
  const urls=[],waits=[];
  const result=await runScheduledCycle({REFRESH_SECRET:'example-super-secret-value-12345'},{
    fetcher:async url=>{urls.push(url);return {ok:true,status:200,json:async()=>({rugEnabled:false})};},
    sleep:async ms=>waits.push(ms),
    now:()=>1000,
  });
  assert.equal(result.rugPolled,false);
  assert.equal(result.reason,'rug-disabled');
  assert.deepEqual(urls,['https://discord-crypto-tracker.vercel.app/api/refresh']);
  assert.deepEqual(waits,[]);
});
