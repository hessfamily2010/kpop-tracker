// Official YouTube uploads via the Data API (key required). Pure parsing + small fetch helpers.

import { hashId } from './feed.js';
import { normalizeName } from '../artists.js';

export const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const DAY_MS = 86_400_000;

const decodeEntities = (s) =>
  String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** A channel is accepted only if its title contains the artist's name (guards against fan/unrelated channels). */
export function pickChannel(json, artist) {
  const want = normalizeName(artist);
  const candidates = (json?.items ?? [])
    .map((i) => ({ id: i.id?.channelId ?? i.snippet?.channelId, title: decodeEntities(i.snippet?.title ?? '') }))
    .filter((c) => /^UC[\w-]{22}$/.test(c.id ?? '') && normalizeName(c.title).includes(want));
  // Best match first: the channel named exactly like the artist, then an "official" one, then any match.
  return (
    candidates.find((c) => normalizeName(c.title) === want) ??
    candidates.find((c) => /official/i.test(c.title) && normalizeName(c.title).startsWith(want)) ??
    candidates.find((c) => /official/i.test(c.title)) ??
    candidates[0] ??
    null
  );
}

/** Every channel's uploads playlist id is its channel id with the "UC" prefix swapped for "UU". */
export const uploadsPlaylistId = (channelId) => `UU${channelId.slice(2)}`;

export function parseUploads(json, artist, channelTitle, now = Date.now(), windowDays = 14) {
  const oldest = now - windowDays * DAY_MS;
  return (json?.items ?? [])
    .map((i) => {
      const s = i.snippet ?? {};
      const videoId = s.resourceId?.videoId;
      const thumbs = s.thumbnails ?? {};
      const image = (thumbs.medium ?? thumbs.high ?? thumbs.default)?.url;
      return {
        id: hashId(`yt:${videoId}`),
        type: 'video',
        artist,
        title: decodeEntities(s.title ?? ''),
        link: `https://www.youtube.com/watch?v=${videoId}`,
        source: channelTitle || s.channelTitle || 'YouTube',
        ts: Date.parse(i.contentDetails?.videoPublishedAt ?? s.publishedAt) || 0,
        image: image?.startsWith('https://') ? image : undefined,
      };
    })
    .filter((i) => /^[\w-]{11}$/.test(i.link.slice(-11)) && i.title && i.title !== 'Private video' && i.title !== 'Deleted video' && i.ts >= oldest && i.ts <= now + DAY_MS);
}

async function getJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<{id:string,title:string}|null>} null when nothing suitable exists. Throws on API failure. */
export async function resolveChannel(artist, key, { fetchImpl = fetch, base = YT_BASE } = {}) {
  const params = new URLSearchParams({ part: 'snippet', type: 'channel', maxResults: '5', q: `${artist} official`, key });
  return pickChannel(await getJson(`${base}/search?${params}`, fetchImpl), artist);
}

export async function fetchUploads(channel, artist, key, { fetchImpl = fetch, base = YT_BASE, now = Date.now(), windowDays = 14 } = {}) {
  const params = new URLSearchParams({ part: 'snippet,contentDetails', maxResults: '10', playlistId: uploadsPlaylistId(channel.id), key });
  return parseUploads(await getJson(`${base}/playlistItems?${params}`, fetchImpl), artist, channel.title, now, windowDays);
}
