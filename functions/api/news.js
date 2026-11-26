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
    const r = await fetch('https://www.bing.com/news/search?q=%22IVE%22+kpop&format=rss&qft=sortbydate%3d%221%22');
    const t = await r.text();
    out.status = r.status;
    out.items = (t.match(/<item>/g) || []).length;
    out.sample = t.slice(t.indexOf('<item>'), t.indexOf('<item>') + 1400);
    try { out.abort = typeof AbortController + typeof AbortSignal.timeout; } catch (e) { out.abort = String(e); }
    return json(out);
  }
  const { news, releases } = await loadArtist(artist, { windowDays: 14, releases: flag(params, 'releases') });
  if (news === null && releases === null) return json({ error: 'Upstream unavailable' }, 502);

  const items = prepareItems([...(news ?? []), ...(releases ?? [])], { safe: flag(params, 'safe') });
  return json({ artist, items: items.slice(0, 40), partial: news === null || releases === null }, 200, 600);
}
