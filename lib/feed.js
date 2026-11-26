// Fetch + normalise news (Google News RSS) and new releases (iTunes Search) for one artist.
// Runs in Cloudflare Workers, Pages Functions and Node, so only web-standard APIs are used.

import { cleanTitle, clusterItems, isSafe, looksKorean } from './text.js';
import { normalizeName } from '../artists.js';

export const NEWS_BASE = 'https://news.google.com/rss/search';
export const ITUNES_BASE = 'https://itunes.apple.com/search';
const TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;
export const RELEASE_WINDOW_DAYS = 30;

// ---------- helpers ----------
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

/** Short stable id (FNV-1a) so the app can key and de-duplicate items. */
export function hashId(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const isHttps = (url) => typeof url === 'string' && url.startsWith('https://');

// ---------- queries ----------
export function buildNewsQuery(artist, windowDays) {
  return `"${artist.replace(/"/g, '')}" (kpop OR k-pop) when:${windowDays}d`;
}

// ---------- parsing ----------
export function parseRss(xml, artist) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, block]) => {
      const source = tag(block, 'source');
      const link = tag(block, 'link');
      return {
        id: hashId(link),
        type: 'news',
        artist,
        title: cleanTitle(tag(block, 'title'), source),
        link,
        source,
        ts: Date.parse(tag(block, 'pubDate')) || 0,
      };
    })
    .filter((i) => i.title && i.ts && isHttps(i.link));
}

function artistMatches(artistName, wanted) {
  const a = normalizeName(artistName);
  const w = normalizeName(wanted);
  return a === w || (w.length >= 5 && a.includes(w));
}

export function parseItunes(json, artist, now = Date.now()) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const oldest = now - RELEASE_WINDOW_DAYS * DAY_MS;
  return results
    .filter((r) => r.collectionName && isHttps(r.collectionViewUrl) && artistMatches(r.artistName ?? '', artist))
    .map((r) => ({
      id: hashId(r.collectionViewUrl),
      type: 'release',
      artist,
      title: `New release: ${r.collectionName.replace(/ - (Single|EP)$/i, '')}`,
      link: r.collectionViewUrl,
      source: 'Apple Music',
      ts: Date.parse(r.releaseDate) || 0,
      image: isHttps(r.artworkUrl100) ? r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : undefined,
    }))
    .filter((i) => i.ts && i.ts <= now && i.ts >= oldest);
}

// ---------- network ----------
async function getText(url, fetchImpl) {
  // AbortController + timer instead of AbortSignal.timeout: Pages Functions may run an older compatibility date.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'kpop-tracker/2.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<object[]|null>} null when the request failed (so callers can tell "no news" from "unknown"). */
export async function fetchNews(artist, { fetchImpl = fetch, base = NEWS_BASE, windowDays = 2 } = {}) {
  const url = `${base}?hl=en-US&gl=US&ceid=US:en&q=${encodeURIComponent(buildNewsQuery(artist, windowDays))}`;
  try {
    return parseRss(await (await getText(url, fetchImpl)).text(), artist);
  } catch (err) {
    console.error('news fetch failed', String(err));
    return null;
  }
}

export async function fetchReleases(artist, { fetchImpl = fetch, base = ITUNES_BASE, now = Date.now() } = {}) {
  const url = `${base}?term=${encodeURIComponent(artist)}&media=music&entity=album&attribute=artistTerm&country=US&limit=25`;
  try {
    return parseItunes(await (await getText(url, fetchImpl)).json(), artist, now);
  } catch (err) {
    console.error('releases fetch failed', String(err));
    return null;
  }
}

/** Raw (unfiltered) items for one artist; `null` for a source that failed. */
export async function loadArtist(artist, opts = {}) {
  const [news, releases] = await Promise.all([
    fetchNews(artist, { ...opts, base: opts.newsBase ?? NEWS_BASE }),
    opts.releases === false ? Promise.resolve([]) : fetchReleases(artist, { ...opts, base: opts.itunesBase ?? ITUNES_BASE }),
  ]);
  return { news, releases };
}

// ---------- shaping ----------
/** Apply language + kid-safe filters, merge duplicate stories, newest first. */
export function prepareItems(items, { safe = true } = {}) {
  const kept = items.filter(
    (i) => !looksKorean(i.title) && (!safe || i.type === 'release' || isSafe(i.title)),
  );
  return clusterItems(kept).sort((a, b) => b.ts - a.ts);
}
