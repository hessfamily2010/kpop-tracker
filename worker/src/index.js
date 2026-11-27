import { APP_ORIGINS } from '../../lib/config.js';
export { Hub } from './hub.js';

const MAX_BODY_BYTES = 8 * 1024;

const hub = (env) => env.HUB.get(env.HUB.idFromName('main'));

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'Payload too large', status: 413 };
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: 'Invalid JSON', status: 400 };
  }
}

async function route(request, env, url, ip) {
  const stub = hub(env);
  const { pathname } = url;
  const method = request.method;
  const profileMatch = pathname.match(/^\/profile\/([^/]+)$/);

  if (method === 'GET' && pathname === '/health') return { ok: true };
  if (method === 'GET' && pathname === '/vapid-public-key') return stub.vapidPublicKey();
  if (method === 'GET' && pathname === '/videos') return stub.videos(url.searchParams.get('artist'), ip);
  if (method === 'POST' && pathname === '/profile') return stub.createProfile(ip);
  if (method === 'GET' && profileMatch) return stub.getProfile(decodeURIComponent(profileMatch[1]), ip);

  if (['PUT', 'POST'].includes(method) && (profileMatch || ['/subscribe', '/unsubscribe'].includes(pathname))) {
    const parsed = await readJson(request);
    if (parsed.error) return parsed;
    const { body } = parsed;
    if (method === 'PUT' && profileMatch) return stub.putProfile(decodeURIComponent(profileMatch[1]), body, ip);
    if (method === 'POST' && pathname === '/subscribe') return stub.subscribe(body.code, body.subscription, ip);
    if (method === 'POST' && pathname === '/unsubscribe') return stub.unsubscribe(body.endpoint, ip);
  }

  // Test-only endpoints (TEST_MODE is never set in production).
  if (env.TEST_MODE === '1') {
    if (method === 'POST' && pathname === '/__test/check') return stub.check(((await readJson(request)).body) ?? {});
    if (method === 'GET' && pathname === '/__test/state') return stub.testState();
    if (method === 'POST' && pathname === '/__test/cursor') return stub.testSetCursor((await readJson(request)).body.cursor);
  }
  return { error: 'Not found', status: 404 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') ?? '';
    const allowed = new Set([...APP_ORIGINS, ...(env.DEV_ORIGIN ? [env.DEV_ORIGIN] : [])]);
    const cors = {
      'Access-Control-Allow-Origin': allowed.has(origin) ? origin : APP_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    try {
      const result = await route(request, env, url, ip);
      const status = result?.error ? result.status ?? 400 : 200;
      return new Response(JSON.stringify(result?.error ? { error: result.error } : result), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(hub(env).check().then((s) => console.log('check', JSON.stringify(s))));
  },
};
