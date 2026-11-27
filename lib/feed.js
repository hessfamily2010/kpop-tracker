// Fetch + normalise news (Google News RSS) and new releases (iTunes Search) for one artist.
// Runs in Cloudflare Workers, Pages Functions and Node, so only web-standard APIs are used.

import { cleanTitle, clusterItems, isSafe, looksNonEnglish } from './text.js';
import { normalizeName } from '../artists.js';

export const NEWS_BASE = 'https://news.google.com/rss/search';
export const BING_BASE = 'https://www.bing.com/news/search';
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

export function buildBingQuery(artist) {
  return `"${artist.replace(/"/g, '')}" kpop`;
}

// ---------- parsing ----------
/** Bing wraps article links in a redirect; the real URL is in its `url` parameter. */
export function unwrapBingLink(link) {
  try {
    const target = new URL(link).searchParams.get('url');
    return isHttps(target) ? target : '';
  } catch {
    return '';
  }
}

export function parseBingRss(xml, artist) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, block]) => {
      const source = tag(block, 'News:Source');
      const link = unwrapBingLink(tag(block, 'link'));
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
    .filter((i) => i.title && i.ts && i.link);
}

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
    const res = await fetchImpl(url, { signal: controller.signal, headers: typeof window === 'undefined' ? { 'user-agent': 'kpop-tracker/2.0' } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const inWindow = (items, windowDays, now) => items.filter((i) => i.ts >= now - windowDays * DAY_MS && i.ts <= now + DAY_MS);

async function tryFetch(label, run) {
  try {
    return await run();
  } catch (err) {
    console.error(`${label} fetch failed`, String(err));
    return null;
  }
}

/**
 * Bing News first (it accepts requests from cloud IPs), Google News as a fallback.
 * @returns {Promise<object[]|null>} null when every source failed (so callers can tell "no news" from "unknown").
 */
export async function fetchNews(artist, { fetchImpl = fetch, base, bingBase = BING_BASE, windowDays = 2, now = Date.now() } = {}) {
  const bing = await tryFetch('bing news', async () => {
    const url = `${bingBase}?q=${encodeURIComponent(buildBingQuery(artist))}&format=rss&qft=${encodeURIComponent('sortbydate="1"')}`;
    return inWindow(parseBingRss(await (await getText(url, fetchImpl)).text(), artist), windowDays, now);
  });
  if (bing?.length) return bing;

  const google = await tryFetch('google news', async () => {
    const url = `${base ?? NEWS_BASE}?hl=en-US&gl=US&ceid=US:en&q=${encodeURIComponent(buildNewsQuery(artist, windowDays))}`;
    return parseRss(await (await getText(url, fetchImpl)).text(), artist);
  });
  return google ?? bing; // [] if Bing worked but was empty and Google failed; null if both failed
}

export async function fetchReleases(artist, { fetchImpl = fetch, base = ITUNES_BASE, now = Date.now() } = {}) {
  return tryFetch('releases', async () => {
    const url = `${base}?term=${encodeURIComponent(artist)}&media=music&entity=album&attribute=artistTerm&country=US&limit=25`;
    return parseItunes(await (await getText(url, fetchImpl)).json(), artist, now);
  });
}

/** Raw (unfiltered) items for one artist; `null` for a source that failed. */
export async function loadArtist(artist, opts = {}) {
  const [news, releases] = await Promise.all([
    fetchNews(artist, { ...opts, base: opts.newsBase ?? NEWS_BASE, bingBase: opts.bingBase ?? BING_BASE }),
    opts.releases === false ? Promise.resolve([]) : fetchReleases(artist, { ...opts, base: opts.itunesBase ?? ITUNES_BASE }),
  ]);
  return { news, releases };
}

// ---------- shaping ----------
/** Apply language + kid-safe filters, merge duplicate stories, newest first. */
export function prepareItems(items, { safe = true } = {}) {
  const kept = items.filter(
    (i) => !looksNonEnglish(i.title) && (!safe || i.type === 'release' || isSafe(i.title)),
  );
  return clusterItems(kept).sort((a, b) => b.ts - a.ts);
}
