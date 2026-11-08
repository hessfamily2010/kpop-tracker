const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=900',
    },
  });

export async function onRequestGet({ request }) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q || q.length > 80) return json({ error: 'Invalid query' }, 400);

  const feed =
    'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' +
    encodeURIComponent(`${q} kpop when:14d`);

  const res = await fetch(feed, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) return json({ error: `Upstream ${res.status}` }, 502);

  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, 25)
    .map(([, block]) => ({
      title: tag(block, 'title'),
      link: tag(block, 'link'),
      date: tag(block, 'pubDate'),
      source: tag(block, 'source'),
    }))
    .filter((i) => i.title && i.link.startsWith('https://'));

  return json({ artist: q, items });
}
