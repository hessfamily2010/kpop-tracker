// RFC 8291 (aes128gcm) decryption as a browser performs it, for verifying what we send.
import assert from 'node:assert/strict';

const enc = (s) => new TextEncoder().encode(s);
export const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
export const unb64u = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

export async function makeSubscriber() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, raw, auth, keys: { p256dh: b64u(raw), auth: b64u(auth) } };
}

const hkdf = async (salt, ikm, info, bytes) => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
};

export async function decryptPush(body, sub) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const senderPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, sub.pair.privateKey, 256));

  const keyInfo = new Uint8Array([...enc('WebPush: info\0'), ...sub.raw, ...senderPublic]);
  const ikm = await hkdf(sub.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'last record delimiter');
  return new TextDecoder().decode(padded.slice(0, end));
}
