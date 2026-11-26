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
    for (const [k, u] of [['news', 'https://news.google.com/rss/search?q=ive'], ['itunes', 'https://itunes.apple.com/search?term=ive&limit=1']]) {
      try { const r = await fetch(u, { headers: { 'user-agent': 'kpop-tracker/2.0' } }); out[k] = r.status; } catch (e) { out[k] = String(e); }
    }
    try { out.abort = typeof AbortController + typeof AbortSignal.timeout; } catch (e) { out.abort = String(e); }
    return json(out);
  }
  const { news, releases } = await loadArtist(artist, { windowDays: 14, releases: flag(params, 'releases') });
  if (news === null && releases === null) return json({ error: 'Upstream unavailable' }, 502);

  const items = prepareItems([...(news ?? []), ...(releases ?? [])], { safe: flag(params, 'safe') });
  return json({ artist, items: items.slice(0, 40), partial: news === null || releases === null }, 200, 600);
}
