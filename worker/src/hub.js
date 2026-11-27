// Single Durable Object (SQLite) that owns all state: sync profiles, push subscriptions, VAPID keys.
// Every public method returns plain data; failures are `{ error, status }` objects.

import { DurableObject } from 'cloudflare:workers';
import { APP_URL } from '../../lib/config.js';
import { loadArtist } from '../../lib/feed.js';
import { holdReason, planNotification } from '../../lib/plan.js';
import { sanitizeArtists, sanitizeSettings } from '../../lib/settings.js';
import { normalizeName } from '../../artists.js';
import { generateVapidKeys, isAllowedPushEndpoint, PushGone, sendWebPush } from './push.js';

const MAX_PROFILES = 2000;
const MAX_SUBS = 2000;
const MAX_SUBS_PER_PROFILE = 5;
const MAX_ARTISTS_PER_RUN = 16; // 2 upstream requests per artist; Workers allow 50 subrequests per invocation
const MAX_PUSHES_PER_RUN = 12;
const FETCH_CONCURRENCY = 5;

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

const fail = (status, error) => ({ error, status });

export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.windows = new Map(); // rate-limit buckets (memory only)
    this.testPushes = [];
    ctx.blockConcurrencyWhile(async () => this.#migrate());
  }

  #migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (
        code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subs (
        endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        profile TEXT NOT NULL, cursor INTEGER NOT NULL,
        sent_day TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
        last_run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subs_profile ON subs (profile);
    `);
  }

  // ---------- helpers ----------
  #limited(bucket, limit, windowMs) {
    const now = Date.now();
    const slot = this.windows.get(bucket);
    if (!slot || now - slot.start >= windowMs) {
      if (this.windows.size > 5000) this.windows.clear();
      this.windows.set(bucket, { start: now, count: 1 });
      return false;
    }
    slot.count += 1;
    return slot.count > limit;
  }

  #count(table) {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
  }

  #profileRow(code) {
    return this.sql.exec('SELECT data, updated_at FROM profiles WHERE code = ?', code).toArray()[0];
  }

  #readProfile(code) {
    const row = this.#profileRow(code);
    if (!row) return null;
    const data = JSON.parse(row.data);
    return { artists: data.artists, settings: data.settings, updatedAt: row.updated_at };
  }

  #config(key) {
    return this.sql.exec('SELECT value FROM config WHERE key = ?', key).toArray()[0]?.value;
  }

  async #vapid() {
    let publicKey = this.#config('vapid_public');
    let privateKey = this.#config('vapid_private');
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = await generateVapidKeys());
      this.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES ('vapid_public', ?), ('vapid_private', ?)", publicKey, privateKey);
    }
    return { subject: APP_URL, publicKey, privateKey };
  }

  // ---------- public API ----------
  async vapidPublicKey() {
    return { publicKey: (await this.#vapid()).publicKey };
  }

  createProfile(ip) {
    if (this.#limited(`create:${ip}`, 5, 3_600_000)) return fail(429, 'Too many new sync codes, try again later');
    if (this.#count('profiles') >= MAX_PROFILES) return fail(503, 'Service is full');
    const code = newCode();
    const data = { artists: [], settings: sanitizeSettings({}) };
    const updatedAt = Date.now();
    this.sql.exec('INSERT INTO profiles (code, data, updated_at) VALUES (?, ?, ?)', code, JSON.stringify(data), updatedAt);
    return { code, ...data, updatedAt };
  }

  getProfile(codeInput, ip) {
    if (this.#limited(`api:${ip}`, 90, 60_000)) return fail(429, 'Too many requests');
    const code = normalizeCode(codeInput);
    if (!CODE_PATTERN.test(code)) return fail(400, 'Invalid code');
    const profile = this.#readProfile(code);
    return profile ? { code, ...profile } : fail(404, 'Unknown code');
  }

  putProfile(codeInput, body, ip) {
    if (this.#limited(`api:${ip}`, 90, 60_000)) return fail(429, 'Too many requests');
    const code = normalizeCode(codeInput);
    if (!CODE_PATTERN.test(code)) return fail(400, 'Invalid code');
    if (!this.#profileRow(code)) return fail(404, 'Unknown code');
    const data = { artists: sanitizeArtists(body?.artists), settings: sanitizeSettings(body?.settings) };
    const updatedAt = Date.now();
    this.sql.exec('UPDATE profiles SET data = ?, updated_at = ? WHERE code = ?', JSON.stringify(data), updatedAt, code);
    return { code, ...data, updatedAt };
  }

  subscribe(codeInput, subscription, ip) {
    if (this.#limited(`api:${ip}`, 90, 60_000)) return fail(429, 'Too many requests');
    const code = normalizeCode(codeInput);
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!CODE_PATTERN.test(code)) return fail(400, 'Invalid code');
    if (!isAllowedPushEndpoint(endpoint)) return fail(400, 'Unsupported push service');
    if (typeof p256dh !== 'string' || p256dh.length > 256 || typeof auth !== 'string' || auth.length > 256) {
      return fail(400, 'Invalid subscription keys');
    }
    if (!this.#profileRow(code)) return fail(404, 'Unknown code');

    const existing = this.sql.exec('SELECT profile FROM subs WHERE endpoint = ?', endpoint).toArray()[0];
    if (!existing) {
      if (this.#count('subs') >= MAX_SUBS) return fail(503, 'Service is full');
      const mine = this.sql.exec('SELECT COUNT(*) AS n FROM subs WHERE profile = ?', code).one().n;
      if (mine >= MAX_SUBS_PER_PROFILE) return fail(409, 'Too many devices on this sync code');
    }
    this.sql.exec(
      `INSERT INTO subs (endpoint, p256dh, auth, profile, cursor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, profile = excluded.profile`,
      endpoint, p256dh, auth, code, Date.now(), Date.now(),
    );
    return { ok: true };
  }

  unsubscribe(endpoint, ip) {
    if (this.#limited(`api:${ip}`, 90, 60_000)) return fail(429, 'Too many requests');
    if (typeof endpoint !== 'string') return fail(400, 'endpoint required');
    this.sql.exec('DELETE FROM subs WHERE endpoint = ?', endpoint);
    return { ok: true };
  }

  // ---------- scheduled check ----------
  /**
   * Look for new articles/releases and push them. `options` exists for tests:
   * { now, fetchImpl } (fetchImpl also receives the push requests).
   */
  async check(options = {}) {
    const now = options.now ?? Date.now();
    const fetchImpl = options.fetchImpl ?? (this.env.TEST_MODE === '1' ? this.#testFetch.bind(this) : fetch);
    const summary = { subscriptions: 0, processed: 0, sent: 0, removed: 0, held: 0, failed: 0 };

    const subs = this.sql.exec('SELECT * FROM subs ORDER BY last_run ASC').toArray();
    summary.subscriptions = subs.length;
    if (!subs.length) return summary;

    // Pick whose turn it is, staying inside the per-invocation request budget.
    const chosen = [];
    const artists = new Set();
    for (const sub of subs) {
      const profile = this.#readProfile(sub.profile);
      if (!profile) {
        this.sql.exec('DELETE FROM subs WHERE endpoint = ?', sub.endpoint);
        summary.removed++;
        continue;
      }
      const reason = holdReason(sub, profile.settings, now);
      const muted = new Set(profile.settings.muted.map(normalizeName));
      const wanted = profile.artists.filter((a) => !muted.has(normalizeName(a)));
      if (reason || !wanted.length) {
        summary.held += reason ? 1 : 0;
        continue;
      }
      const next = new Set([...artists, ...wanted]);
      if (next.size > MAX_ARTISTS_PER_RUN || chosen.length >= MAX_PUSHES_PER_RUN) continue;
      next.forEach((a) => artists.add(a));
      chosen.push({ sub, profile });
    }
    if (!chosen.length) return summary;

    const wantsReleases = new Set(
      chosen.filter((c) => c.profile.settings.releases).flatMap((c) => c.profile.artists.map(normalizeName)),
    );
    const itemsBy = {};
    const queue = [...artists];
    const worker = async () => {
      for (let artist = queue.shift(); artist; artist = queue.shift()) {
        itemsBy[artist] = await loadArtist(artist, {
          fetchImpl,
          windowDays: 2,
          releases: wantsReleases.has(normalizeName(artist)),
          newsBase: this.env.NEWS_BASE,
          bingBase: this.env.BING_BASE,
          itunesBase: this.env.ITUNES_BASE,
        });
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

    const vapid = await this.#vapid();
    for (const { sub, profile } of chosen) {
      summary.processed++;
      this.sql.exec('UPDATE subs SET last_run = ? WHERE endpoint = ?', now, sub.endpoint);
      const plan = planNotification({ sub, profile, itemsBy, now, appUrl: APP_URL });
      if (plan.action !== 'send') continue;
      try {
        await sendWebPush(sub, plan.payload, vapid, { fetchImpl });
        this.sql.exec(
          'UPDATE subs SET cursor = ?, sent_day = ?, sent_count = ? WHERE endpoint = ?',
          plan.cursor, plan.sentDay, plan.sentCount, sub.endpoint,
        );
        summary.sent++;
      } catch (err) {
        if (err instanceof PushGone) {
          this.sql.exec('DELETE FROM subs WHERE endpoint = ?', sub.endpoint);
          summary.removed++;
        } else {
          console.error('push failed', sub.endpoint.slice(0, 48), String(err));
          summary.failed++;
        }
      }
    }
    return summary;
  }

  // ---------- test seams (only reachable when TEST_MODE=1) ----------
  async #testFetch(url, init) {
    if (String(url).startsWith('https://') && init?.method === 'post') {
      this.testPushes.push({
        url: String(url),
        headers: init.headers,
        body: btoa(String.fromCharCode(...new Uint8Array(init.body))),
      });
      return new Response(null, { status: 201 });
    }
    return fetch(url, init);
  }

  testState() {
    if (this.env.TEST_MODE !== '1') return fail(404, 'Not found');
    return {
      pushes: this.testPushes,
      subs: this.sql.exec('SELECT endpoint, profile, cursor, sent_day, sent_count FROM subs').toArray(),
    };
  }

  testSetCursor(cursor) {
    if (this.env.TEST_MODE !== '1') return fail(404, 'Not found');
    this.sql.exec('UPDATE subs SET cursor = ?', cursor);
    return { ok: true };
  }
}
