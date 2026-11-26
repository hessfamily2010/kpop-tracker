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
    const BROWSER = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', accept: 'application/rss+xml, application/xml, text/xml, */*' };
    const G = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=ive+kpop';
    const tests = [
      ['google_browserua', G, { headers: BROWSER }],
      ['bing_rss', 'https://www.bing.com/news/search?q=IVE+kpop&format=rss', { headers: BROWSER }],
      ['bing_rss_noua', 'https://www.bing.com/news/search?q=IVE+kpop&format=rss', {}],
      ['itunes_browserua', 'https://itunes.apple.com/search?term=ive&media=music&entity=album&limit=1', { headers: BROWSER }],
      ['itunes_lookup_host', 'https://itunes.apple.com/lookup?id=1&limit=1', {}],
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
