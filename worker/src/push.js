// Web Push helpers: VAPID key generation, endpoint allow-list, and sending.

import { buildPushPayload } from '@block65/webcrypto-web-push';

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** @returns {{publicKey: string, privateKey: string}} base64url: 65-byte uncompressed point / raw 32-byte `d`. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(fromBase64Url(jwk.x), 1);
  point.set(fromBase64Url(jwk.y), 33);
  return { publicKey: toBase64Url(point), privateKey: jwk.d };
}

// Only real browser push services may be stored as endpoints (prevents using us to POST anywhere).
const PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

/** The subscription no longer exists (404/410): the caller should delete it. */
export class PushGone extends Error {}

export async function sendWebPush(sub, payload, vapid, { fetchImpl = fetch, ttl = 3600 } = {}) {
  const request = await buildPushPayload(
    { data: payload, options: { ttl, urgency: 'normal' } },
    { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    vapid,
  );
  const res = await fetchImpl(sub.endpoint, request);
  if (res.status === 404 || res.status === 410) throw new PushGone(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Push service responded ${res.status}`);
}
