// End-to-end check against `wrangler dev` (TEST_MODE=1, mock feeds). Run: node worker/test/e2e.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { decryptPush, makeSubscriber } from '../../tests/helpers/webpush.js';

const BASE = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const NOW = Date.now();
const rfc = (ms) => new Date(ms).toUTCString();

// ---- mock Google News + iTunes ----
const rss = (items) => `<rss><channel>${items.map(([title, link, ts, src]) =>
  `<item><title>${title} - ${src}</title><link>${link}</link><pubDate>${rfc(ts)}</pubDate><source url="https://x">${src}</source></item>`).join('')}</channel></rss>`;

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/news') {
    const q = url.searchParams.get('q');
    const items = q.includes('"IVE"') ? [
      ['IVE announce world tour dates', 'https://news.example/ive-1', NOW - 3_600_000, 'Billboard'],
      ['IVE announces world tour dates for 2027', 'https://news.example/ive-2', NOW - 3_000_000, 'Allkpop'],
      ['IVE sued over contract dispute', 'https://news.example/ive-3', NOW - 1_800_000, 'Gossip Daily'],
    ] : [];
    res.writeHead(200, { 'content-type': 'application/xml' }).end(rss(items));
  } else if (url.pathname === '/itunes') {
    const term = url.searchParams.get('term');
    const results = term === 'IVE' ? [{
      artistName: 'IVE', collectionName: 'IVE EMPATHY - EP', collectionViewUrl: 'https://music.apple.com/us/album/x',
      artworkUrl100: 'https://is1.mzstatic.com/100x100bb.jpg', releaseDate: new Date(NOW - 7_200_000).toISOString(),
    }] : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resultCount: results.length, results }));
  } else res.writeHead(404).end();
}).listen(9911, '127.0.0.1');

// ---- helpers ----
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const subscriber = async () => (await makeSubscriber()).keys;
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

try {
  await step('health + CORS preflight', async () => {
    assert.equal((await call('GET', '/health')).body.ok, true);
    const pre = await fetch(BASE + '/subscribe', { method: 'OPTIONS', headers: { origin: 'https://kpop-tracker.hessfamily2010.com' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://kpop-tracker.hessfamily2010.com');
    const evil = await fetch(BASE + '/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), 'https://kpop-tracker.hessfamily2010.com');
  });

  await step('VAPID key is generated once and stable', async () => {
    const a = (await call('GET', '/vapid-public-key')).body.publicKey;
    const b = (await call('GET', '/vapid-public-key')).body.publicKey;
    assert.equal(a, b);
    assert.equal(Buffer.from(a, 'base64url').length, 65);
  });

  let code;
  await step('profile create / read / update / validation', async () => {
    const created = await call('POST', '/profile');
    assert.equal(created.status, 200);
    code = created.body.code;
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{16}$/);
    const put = await call('PUT', `/profile/${code}`, {
      artists: ['IVE', 'TWICE', 'ive', 5],
      settings: { tz: 'UTC', quiet: { enabled: false }, maxPerDay: 2, bogus: true },
    });
    assert.deepEqual(put.body.artists, ['IVE', 'TWICE']);
    assert.equal(put.body.settings.maxPerDay, 2);
    assert.equal('bogus' in put.body.settings, false);
    const pretty = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`.toLowerCase();
    assert.deepEqual((await call('GET', `/profile/${pretty}`)).body.artists, ['IVE', 'TWICE']);
    assert.equal((await call('GET', '/profile/short')).status, 400);
    assert.equal((await call('GET', '/profile/0000000000000000')).status, 404);
    assert.equal((await call('PUT', '/profile/0000000000000000', {})).status, 404);
  });

  const endpoint = 'https://fcm.googleapis.com/fcm/send/e2e-device-1';
  const device = await makeSubscriber();
  await step('subscribe validation and device limit', async () => {
    const keys = device.keys;
    assert.equal((await call('POST', '/subscribe', { code, subscription: { endpoint: 'https://evil.example/x', keys } })).status, 400);
    assert.equal((await call('POST', '/subscribe', { code, subscription: { endpoint: 'http://fcm.googleapis.com/x', keys } })).status, 400);
    assert.equal((await call('POST', '/subscribe', { code: '0000000000000000', subscription: { endpoint, keys } })).status, 404);
    assert.equal((await call('POST', '/subscribe', { code, subscription: { endpoint, keys } })).status, 200);
    // idempotent for the same endpoint
    assert.equal((await call('POST', '/subscribe', { code, subscription: { endpoint, keys } })).status, 200);
    for (let i = 2; i <= 5; i++) {
      const r = await call('POST', '/subscribe', { code, subscription: { endpoint: `${endpoint}-${i}`, keys: await subscriber() } });
      assert.equal(r.status, 200, `device ${i}`);
    }
    const sixth = await call('POST', '/subscribe', { code, subscription: { endpoint: `${endpoint}-6`, keys: await subscriber() } });
    assert.equal(sixth.status, 409);
    for (let i = 2; i <= 5; i++) await call('POST', '/unsubscribe', { endpoint: `${endpoint}-${i}` });
    assert.equal((await call('GET', '/__test/state')).body.subs.length, 1);
  });

  await step('check: nothing is sent for items older than the subscription', async () => {
    const r = await call('POST', '/__test/check', {});
    assert.equal(r.body.sent, 0);
  });

  await step('check: sends one batched, kid-safe, de-duplicated push', async () => {
    await call('POST', '/__test/cursor', { cursor: NOW - 4 * 3_600_000 });
    const r = await call('POST', '/__test/check', {});
    assert.equal(r.body.sent, 1, JSON.stringify(r.body));
    const state = (await call('GET', '/__test/state')).body;
    assert.equal(state.pushes.length, 1);
    assert.equal(state.pushes[0].url, endpoint);
    assert.equal(state.pushes[0].headers['content-encoding'], 'aes128gcm');
    assert.equal(state.subs[0].sent_count, 1);
    assert.ok(state.subs[0].cursor >= NOW);
    // What the browser would actually receive: the release + ONE merged tour story, no lawsuit headline.
    const payload = JSON.parse(await decryptPush(new Uint8Array(Buffer.from(state.pushes[0].body, 'base64')), device));
    assert.deepEqual(payload, { title: 'K-Pop Tracker', body: '2 updates: IVE', url: 'https://kpop-tracker.hessfamily2010.com', tag: 'kpop-news' });
  });

  await step('check: cursor advanced, so nothing is re-sent', async () => {
    const r = await call('POST', '/__test/check', {});
    assert.equal(r.body.sent, 0);
    assert.equal((await call('GET', '/__test/state')).body.pushes.length, 1);
  });

  await step('daily cap holds notifications', async () => {
    await call('PUT', `/profile/${code}`, { artists: ['IVE'], settings: { tz: 'UTC', quiet: { enabled: false }, maxPerDay: 1 } });
    await call('POST', '/__test/cursor', { cursor: NOW - 4 * 3_600_000 });
    const r = await call('POST', '/__test/check', {});
    assert.equal(r.body.sent, 0);
    assert.equal(r.body.held, 1);
  });

  await step('quiet hours hold notifications', async () => {
    await call('PUT', `/profile/${code}`, { artists: ['IVE'], settings: { tz: 'UTC', maxPerDay: 20, quiet: { enabled: true, start: '00:00', end: '23:59' } } });
    const r = await call('POST', '/__test/check', {});
    assert.equal(r.body.sent, 0);
    assert.equal(r.body.held, 1);
  });

  await step('muting every artist sends nothing; unmuting resumes', async () => {
    await call('PUT', `/profile/${code}`, { artists: ['IVE'], settings: { tz: 'UTC', maxPerDay: 20, muted: ['IVE'], quiet: { enabled: false } } });
    assert.equal((await call('POST', '/__test/check', {})).body.sent, 0);
    await call('PUT', `/profile/${code}`, { artists: ['IVE'], settings: { tz: 'UTC', maxPerDay: 20, releases: true, quiet: { enabled: false } } });
    assert.equal((await call('POST', '/__test/check', {})).body.sent, 1);
  });

  await step('unsubscribe removes the device', async () => {
    await call('POST', '/unsubscribe', { endpoint });
    assert.equal((await call('GET', '/__test/state')).body.subs.length, 0);
  });

  await step('rate limiting kicks in', async () => {
    let limited = 0;
    for (let i = 0; i < 120; i++) if ((await call('GET', `/profile/${code}`)).status === 429) limited++;
    assert.ok(limited > 0, 'expected some 429s');
  });

  await step('payload size limit and bad JSON', async () => {
    const big = await fetch(BASE + '/subscribe', { method: 'POST', body: 'x'.repeat(9000) });
    assert.equal(big.status, 413);
    const bad = await fetch(BASE + '/subscribe', { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400);
  });

  console.log(`\n${passed} steps passed`);
} catch (err) {
  console.error('\nFAILED after', passed, 'steps\n', err);
  process.exitCode = 1;
} finally {
  mock.close();
}
