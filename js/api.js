// HTTP clients: feed (same-origin Pages function) and push/sync Worker.

import { API_BASE, NEWS_PATH } from '../config.js';
import { fetchReleases } from '../lib/feed.js';
import { keyOf } from './state.js';

export const backendEnabled = () => Boolean(API_BASE);

async function request(url, init) {
  const res = await fetch(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const jsonInit = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Official YouTube uploads from the Worker; a failure here must never hide the rest of the feed. */
const fetchVideos = (artist) =>
  request(`${API_BASE}/videos?artist=${encodeURIComponent(artist)}`).then((r) => r.items ?? []).catch(() => []);

/**
 * Items for one artist. News comes from our server (safe-mode filtered there); releases come straight from
 * Apple in the browser because Apple rate-limits shared cloud IPs.
 */
export async function fetchArtist(artist, settings) {
  const params = new URLSearchParams({ q: artist, safe: settings.safe ? '1' : '0', releases: '0' });
  const [{ items }, releases, videos] = await Promise.all([
    request(`${NEWS_PATH}?${params}`),
    settings.releases ? fetchReleases(artist) : Promise.resolve([]),
    settings.videos && backendEnabled() ? fetchVideos(artist) : Promise.resolve([]),
  ]);
  return [...items, ...(releases ?? []), ...videos].map((i) => ({ ...i, artist }));
}

/** Loads every artist; partial failures keep the previous items. Rejects only if all fail. */
export async function fetchFeed(artists, settings, previous) {
  const results = await Promise.allSettled(artists.map((a) => fetchArtist(a, settings)));
  if (artists.length && results.every((r) => r.status === 'rejected')) throw new Error('Could not reach the news service');
  return results.map((r, i) => [keyOf(artists[i]), r.status === 'fulfilled' ? r.value : previous[keyOf(artists[i])] ?? []]);
}

const api = (path) => `${API_BASE}${path}`;

export const vapidPublicKey = () => request(api('/vapid-public-key')).then((r) => r.publicKey);
export const createProfile = () => request(api('/profile'), { method: 'POST' });
export const getProfile = (code) => request(api(`/profile/${encodeURIComponent(code)}`));
export const putProfile = (code, { artists, settings }) =>
  request(api(`/profile/${encodeURIComponent(code)}`), jsonInit('PUT', { artists, settings }));
export const subscribe = (code, subscription) => request(api('/subscribe'), jsonInit('POST', { code, subscription }));
export const unsubscribe = (endpoint) => request(api('/unsubscribe'), jsonInit('POST', { endpoint }));
