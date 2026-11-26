import { loadArtist, prepareItems } from '../../lib/feed.js';
import { MAX_NAME_LENGTH } from '../../lib/settings.js';

const json = (body, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });

const flag = (params, name) => params.get(name) !== '0'; // on unless explicitly "0"

export async function onRequestGet({ request }) {
  const params = new URL(request.url).searchParams;
  const artist = (params.get('q') ?? '').trim().replace(/\s+/g, ' ');
  if (!artist || artist.length > MAX_NAME_LENGTH) return json({ error: 'Invalid query' }, 400);

  if (params.get('debug') === '1') {
    const out = {};
    const tests = [
      ['news_noua', 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=ive', {}],
      ['news_cf', 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=ive', { cf: { cacheTtl: 900, cacheEverything: true } }],
      ['news_ua', 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=ive', { headers: { 'user-agent': 'kpop-tracker/2.0' } }],
      ['itunes_noua', 'https://itunes.apple.com/search?term=ive&limit=1', {}],
      ['itunes_cf', 'https://itunes.apple.com/search?term=ive&media=music&entity=album&limit=1', { cf: { cacheTtl: 900, cacheEverything: true } }],
    ];
    for (const [k, u, init] of tests) {
      try { out[k] = (await fetch(u, init)).status; } catch (e) { out[k] = String(e); }
    }
    try { out.abort = typeof AbortController + typeof AbortSignal.timeout; } catch (e) { out.abort = String(e); }
    return json(out);
  }
  const { news, releases } = await loadArtist(artist, { windowDays: 14, releases: flag(params, 'releases') });
  if (news === null && releases === null) return json({ error: 'Upstream unavailable' }, 502);

  const items = prepareItems([...(news ?? []), ...(releases ?? [])], { safe: flag(params, 'safe') });
  return json({ artist, items: items.slice(0, 40), partial: news === null || releases === null }, 200, 600);
}
