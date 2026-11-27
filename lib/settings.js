// Settings + artist-list validation shared by the app and the Worker.

export const MAX_ARTISTS = 12;
export const MAX_NAME_LENGTH = 60;

export const DEFAULT_SETTINGS = Object.freeze({
  safe: true,
  releases: true,
  videos: true,
  muted: [],
  maxPerDay: 5,
  quiet: Object.freeze({ enabled: true, start: '22:00', end: '08:00' }),
  digest: Object.freeze({ enabled: false, at: '17:00' }), // one summary per day instead of instant alerts
  tz: 'UTC',
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function sanitizeArtists(list, max = MAX_ARTISTS) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/\s+/g, ' ');
    const key = name.toLowerCase();
    if (!name || name.length > MAX_NAME_LENGTH || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const q = r.quiet && typeof r.quiet === 'object' ? r.quiet : {};
  const dg = r.digest && typeof r.digest === 'object' ? r.digest : {};
  const d = DEFAULT_SETTINGS;
  return {
    safe: r.safe !== false,
    releases: r.releases !== false,
    videos: r.videos !== false,
    muted: sanitizeArtists(r.muted),
    maxPerDay: clampInt(r.maxPerDay, 1, 20, d.maxPerDay),
    quiet: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : d.quiet.enabled,
      start: HHMM.test(q.start) ? q.start : d.quiet.start,
      end: HHMM.test(q.end) ? q.end : d.quiet.end,
    },
    digest: {
      enabled: typeof dg.enabled === 'boolean' ? dg.enabled : d.digest.enabled,
      at: HHMM.test(dg.at) ? dg.at : d.digest.at,
    },
    tz: isValidTimeZone(r.tz) ? r.tz : d.tz,
  };
}
