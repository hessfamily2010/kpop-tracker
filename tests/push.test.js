import test from 'node:test';
import assert from 'node:assert/strict';

import { generateVapidKeys, isAllowedPushEndpoint, PushGone, sendWebPush } from '../worker/src/push.js';
import { decryptPush, makeSubscriber, unb64u } from './helpers/webpush.js';

const enc = (s) => new TextEncoder().encode(s);
const subscriber = makeSubscriber;
const decrypt = decryptPush;

test('generateVapidKeys yields an uncompressed P-256 point and a 32-byte private scalar', async () => {
  const { publicKey, privateKey } = await generateVapidKeys();
  const point = unb64u(publicKey);
  assert.equal(point.length, 65);
  assert.equal(point[0], 4);
  assert.equal(unb64u(privateKey).length, 32);
});

test('sendWebPush produces a VAPID-signed request the subscriber can decrypt', async () => {
  const vapid = { ...(await generateVapidKeys()), subject: 'https://app.example' };
  const sub = await subscriber();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const payload = { title: 'IVE', body: 'Tour dates announced', url: 'https://news.example/a', tag: 'kpop-news' };

  let captured;
  await sendWebPush({ endpoint, ...sub.keys }, payload, vapid, {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(null, { status: 201 });
    },
  });

  assert.equal(captured.url, endpoint);
  assert.equal(captured.init.method, 'post');
  const h = captured.init.headers;
  assert.equal(h['content-encoding'], 'aes128gcm');
  assert.equal(h.ttl, '3600');
  assert.equal(h.urgency, 'normal');

  // VAPID header: signature verifies with our public key and targets the endpoint's origin
  const [, jwt, key] = h.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, vapid.publicKey);
  const [head, claims, sig] = jwt.split('.');
  const verifyKey = await crypto.subtle.importKey('raw', unb64u(vapid.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, unb64u(sig), enc(`${head}.${claims}`)));
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(parsed.aud, 'https://fcm.googleapis.com');
  assert.equal(parsed.sub, 'https://app.example');

  // Encrypted body round-trips
  assert.deepEqual(JSON.parse(await decrypt(captured.init.body, sub)), payload);
});

test('sendWebPush maps 404/410 to PushGone and other failures to errors', async () => {
  const vapid = { ...(await generateVapidKeys()), subject: 'https://app.example' };
  const sub = await subscriber();
  const target = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', ...sub.keys };
  const respond = (status) => ({ fetchImpl: async () => new Response(null, { status }) });
  await assert.rejects(sendWebPush(target, { a: 1 }, vapid, respond(410)), PushGone);
  await assert.rejects(sendWebPush(target, { a: 1 }, vapid, respond(404)), PushGone);
  await assert.rejects(sendWebPush(target, { a: 1 }, vapid, respond(500)), (e) => !(e instanceof PushGone) && /500/.test(e.message));
});

test('isAllowedPushEndpoint only accepts https endpoints of real push services', () => {
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/?token=x'), true);
  assert.equal(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/x'), false);
  assert.equal(isAllowedPushEndpoint('https://evil.example.com/googleapis.com'), false);
  assert.equal(isAllowedPushEndpoint('https://googleapis.com.evil.example/x'), false);
  assert.equal(isAllowedPushEndpoint('not a url'), false);
  assert.equal(isAllowedPushEndpoint(null), false);
  assert.equal(isAllowedPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2100)}`), false);
});
