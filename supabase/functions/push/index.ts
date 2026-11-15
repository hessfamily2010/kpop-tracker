import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const APP_URL = "https://kpop-tracker.hessfamily2010.com";
const ALLOWED_ORIGINS = new Set([APP_URL, "https://kpop-tracker.pages.dev"]);
const PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
const MAX_ARTISTS = 20;
const MAX_TEXT = 120;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- config (VAPID keys + cron secret live in public.push_config) ----------
async function readConfig(): Promise<Record<string, string>> {
  const { data, error } = await db.from("push_config").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

async function getVapid(): Promise<{ publicKey: string; privateKey: string }> {
  let cfg = await readConfig();
  if (!cfg.vapid_public || !cfg.vapid_private) {
    const keys = webpush.generateVAPIDKeys();
    await db.from("push_config").upsert(
      [
        { key: "vapid_public", value: keys.publicKey },
        { key: "vapid_private", value: keys.privateKey },
      ],
      { onConflict: "key", ignoreDuplicates: true },
    );
    cfg = await readConfig();
  }
  return { publicKey: cfg.vapid_public, privateKey: cfg.vapid_private };
}

// ---------- validation ----------
function parseSubscription(body: any) {
  const s = body?.subscription;
  const endpoint = s?.endpoint;
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (
    typeof endpoint !== "string" || endpoint.length > 2048 ||
    typeof p256dh !== "string" || p256dh.length > 256 ||
    typeof auth !== "string" || auth.length > 256
  ) throw new HttpError(400, "Invalid subscription");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, "Invalid endpoint");
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, "Unsupported push service");
  }
  return { endpoint, p256dh, auth };
}

function parseArtists(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "artists must be an array");
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const name = v.trim().replace(/\s+/g, " ");
    if (name && name.length <= 60) seen.add(name);
    if (seen.size >= MAX_ARTISTS) break;
  }
  return [...seen];
}

// ---------- news ----------
const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").trim();

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

type Item = { title: string; link: string; ts: number };

async function fetchArtist(artist: string): Promise<Item[] | null> {
  const url = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=" +
    encodeURIComponent(`${artist} kpop when:1d`);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map(([, b]) => ({
        title: tag(b, "title"),
        link: tag(b, "link"),
        ts: Date.parse(tag(b, "pubDate")) || 0,
      }))
      .filter((i) => i.title && i.link.startsWith("https://"));
  } catch {
    return null;
  }
}

// ---------- check + send ----------
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s);

function buildPayload(fresh: (Item & { artist: string })[]) {
  if (fresh.length === 1) {
    const [i] = fresh;
    return { title: clip(i.artist), body: clip(i.title), url: i.link, tag: "kpop-news" };
  }
  const names = [...new Set(fresh.map((i) => i.artist))].join(", ");
  return {
    title: "K-Pop Tracker",
    body: clip(`${fresh.length} new updates: ${names}`),
    url: APP_URL,
    tag: "kpop-news",
  };
}

async function runCheck() {
  const started = new Date().toISOString();
  const { data: subs, error } = await db.from("push_subscriptions").select("*");
  if (error) throw error;
  if (!subs?.length) return { subscriptions: 0, sent: 0, removed: 0 };

  const artists = [...new Set(subs.flatMap((s) => s.artists as string[]))];
  const feed = new Map<string, Item[] | null>();
  await Promise.all(artists.map(async (a) => feed.set(a, await fetchArtist(a))));

  const vapid = await getVapid();
  webpush.setVapidDetails(APP_URL, vapid.publicKey, vapid.privateKey);

  let sent = 0;
  let removed = 0;

  for (const sub of subs) {
    const since = Date.parse(sub.last_checked);
    const seen = new Set<string>();
    const fresh: (Item & { artist: string })[] = [];
    let feedFailed = false;

    for (const artist of sub.artists as string[]) {
      const items = feed.get(artist);
      if (items === null || items === undefined) {
        feedFailed = true;
        continue;
      }
      for (const item of items) {
        if (item.ts > since && !seen.has(item.title)) {
          seen.add(item.title);
          fresh.push({ ...item, artist });
        }
      }
    }
    fresh.sort((a, b) => b.ts - a.ts);

    if (fresh.length) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(buildPayload(fresh)),
          { TTL: 3600, urgency: "normal" },
        );
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          removed++;
        } else {
          console.error("push failed", e?.statusCode, e?.body);
        }
        continue; // retry on the next run
      }
    } else if (feedFailed) {
      continue; // don't advance the cursor past articles we couldn't fetch
    }

    await db.from("push_subscriptions").update({ last_checked: started }).eq("endpoint", sub.endpoint);
  }

  return { subscriptions: subs.length, sent, removed };
}

// ---------- http ----------
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : APP_URL,
    "Access-Control-Allow-Headers": "content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const action = new URL(req.url).pathname.split("/").filter(Boolean).pop();

  try {
    switch (`${req.method} ${action}`) {
      case "GET vapid-public-key": {
        const { publicKey } = await getVapid();
        return json({ publicKey });
      }

      case "POST subscribe": {
        const body = await req.json();
        const sub = parseSubscription(body);
        const artists = parseArtists(body.artists);
        const { error } = await db.from("push_subscriptions").upsert(
          { ...sub, artists },
          { onConflict: "endpoint" },
        );
        if (error) throw error;
        return json({ ok: true });
      }

      case "POST unsubscribe": {
        const body = await req.json();
        if (typeof body?.endpoint !== "string") throw new HttpError(400, "endpoint required");
        const { error } = await db.from("push_subscriptions").delete().eq("endpoint", body.endpoint);
        if (error) throw error;
        return json({ ok: true });
      }

      case "POST check": {
        const secret = req.headers.get("x-cron-secret") ?? "";
        const cfg = await readConfig();
        if (!cfg.cron_secret || secret !== cfg.cron_secret) throw new HttpError(401, "Unauthorized");
        return json(await runCheck());
      }

      default:
        throw new HttpError(404, "Not found");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Internal error" }, 500);
  }
});
