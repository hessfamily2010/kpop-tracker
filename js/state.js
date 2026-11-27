// Pure application state: reducer + selectors. No DOM, no I/O, so it is fully unit-testable.

import { normalizeName, resolveArtist } from '../artists.js';
import { MAX_ARTISTS, sanitizeArtists, sanitizeSettings } from '../lib/settings.js';
import { isUpcoming } from '../lib/text.js';

const DAY_MS = 86_400_000;

export const keyOf = normalizeName;
export const VIEW_SAVED = '@saved';
export const VIEW_UPCOMING = '@upcoming';
export const MAX_SAVED = 100;
const isView = (filter) => filter === VIEW_SAVED || filter === VIEW_UPCOMING;

/** Keep only well-formed saved items (stored in localStorage, so never trust the shape). */
export function sanitizeSaved(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.link === 'string' && i.link.startsWith('https://'))
    .slice(0, MAX_SAVED)
    .map((i) => ({
      id: i.id, type: ['news', 'release', 'video'].includes(i.type) ? i.type : 'news', artist: String(i.artist ?? ''),
      title: i.title.slice(0, 300), link: i.link, source: String(i.source ?? '').slice(0, 80),
      ts: Number(i.ts) || 0, savedAt: Number(i.savedAt) || 0,
      image: typeof i.image === 'string' && i.image.startsWith('https://') ? i.image : undefined,
    }));
}

const isLock = (l) => Boolean(l) && typeof l.salt === 'string' && typeof l.hash === 'string';

export function initialState(saved = {}, { tz = 'UTC', online = true } = {}) {
  return {
    artists: sanitizeArtists(saved.artists),
    settings: sanitizeSettings({ tz, ...(saved.settings ?? {}) }),
    lastSeen: saved.lastSeen && typeof saved.lastSeen === 'object' ? { ...saved.lastSeen } : {},
    syncCode: typeof saved.syncCode === 'string' ? saved.syncCode : null,
    syncedAt: Number(saved.syncedAt) || 0, // server timestamp of the last profile we synced
    dirty: saved.dirty === true,           // local edits not yet pushed to the sync profile
    notifyWanted: saved.notifyWanted === true,
    lock: isLock(saved.lock) ? saved.lock : null, // parent PIN { salt, hash } — per device, never synced
    saved: sanitizeSaved(saved.saved),             // bookmarked items, per device
    unlocked: false,                               // lasts until the page is closed

    feed: {},                // artist key -> items
    filter: 'all',           // 'all' | '@saved' | '@upcoming' | artist key
    status: 'idle',          // 'idle' | 'loading' | 'ready' | 'error'
    error: null,
    fetchedAt: null,
    notif: 'checking',       // 'checking' | 'off' | 'on' | 'busy' | 'denied' | 'ios-install' | 'unsupported' | 'error'
    sync: { status: 'idle', message: '' },
    notice: null,
    online,
    updateReady: false,
  };
}

/** The part of the state worth keeping between visits. */
export const persistable = (s) => ({
  v: 2,
  artists: s.artists,
  settings: s.settings,
  lastSeen: s.lastSeen,
  syncCode: s.syncCode,
  syncedAt: s.syncedAt,
  dirty: s.dirty,
  notifyWanted: s.notifyWanted,
  lock: s.lock,
  saved: s.saved,
});

const withoutKeys = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));

/** Local edits mark the profile dirty so the sync layer knows to push it. */
const edited = (state, patch) => ({ ...state, ...patch, dirty: true });

export function reducer(state, action) {
  switch (action.type) {
    case 'ADD_ARTIST': {
      const name = resolveArtist(action.name);
      if (!name) return { ...state, notice: 'Enter an artist or group name.' };
      const key = keyOf(name);
      if (state.artists.some((a) => keyOf(a) === key)) return { ...state, notice: `You’re already following ${name}.` };
      if (state.artists.length >= MAX_ARTISTS) return { ...state, notice: `You can follow up to ${MAX_ARTISTS} artists.` };
      return edited(state, {
        artists: [...state.artists, name],
        lastSeen: { ...state.lastSeen, [key]: action.now - DAY_MS },
        notice: null,
      });
    }

    case 'REMOVE_ARTIST': {
      const key = keyOf(action.name);
      const artists = state.artists.filter((a) => keyOf(a) !== key);
      const keep = new Set(artists.map(keyOf));
      return edited(state, {
        artists,
        feed: withoutKeys(state.feed, keep),
        lastSeen: withoutKeys(state.lastSeen, keep),
        settings: { ...state.settings, muted: state.settings.muted.filter((m) => keyOf(m) !== key) },
        filter: state.filter === key ? 'all' : state.filter,
      });
    }

    case 'PATCH_SETTINGS': {
      const { patch } = action;
      const merged = {
        ...state.settings, ...patch,
        quiet: { ...state.settings.quiet, ...(patch.quiet ?? {}) },
        digest: { ...state.settings.digest, ...(patch.digest ?? {}) },
      };
      return edited(state, { settings: sanitizeSettings(merged) });
    }

    case 'TOGGLE_MUTE': {
      const key = keyOf(action.name);
      const muted = state.settings.muted.some((m) => keyOf(m) === key)
        ? state.settings.muted.filter((m) => keyOf(m) !== key)
        : [...state.settings.muted, action.name];
      return edited(state, { settings: sanitizeSettings({ ...state.settings, muted }) });
    }

    case 'ADOPT_REMOTE': {
      const artists = sanitizeArtists(action.artists);
      const keep = new Set(artists.map(keyOf));
      const lastSeen = withoutKeys(state.lastSeen, keep);
      for (const a of artists) lastSeen[keyOf(a)] ??= action.now - DAY_MS;
      return {
        ...state,
        artists,
        settings: sanitizeSettings(action.settings),
        lastSeen,
        feed: withoutKeys(state.feed, keep),
        filter: state.filter === 'all' || isView(state.filter) || keep.has(state.filter) ? state.filter : 'all',
        syncedAt: action.updatedAt,
        dirty: false,
      };
    }

    case 'SET_SYNC_CODE':
      return { ...state, syncCode: action.code, syncedAt: action.code ? state.syncedAt : 0, dirty: action.code ? state.dirty : false };
    case 'SYNC_SYNCED':
      return { ...state, syncedAt: action.updatedAt, dirty: false };
    case 'SYNC_STATUS':
      return { ...state, sync: { status: action.status, message: action.message ?? '' } };

    case 'SET_LOCK':
      return { ...state, lock: isLock(action.lock) ? action.lock : null, unlocked: isLock(action.lock) };
    case 'UNLOCK':
      return state.unlocked ? state : { ...state, unlocked: true };
    case 'RELOCK':
      return state.unlocked ? { ...state, unlocked: false } : state;

    case 'TOGGLE_SAVE': {
      const { item, now } = action;
      if (state.saved.some((i) => i.id === item.id)) return { ...state, saved: state.saved.filter((i) => i.id !== item.id) };
      const [entry] = sanitizeSaved([{ ...item, savedAt: now }]);
      if (!entry) return state;
      if (state.saved.length >= MAX_SAVED) return { ...state, notice: `You can save up to ${MAX_SAVED} items.` };
      return { ...state, saved: [entry, ...state.saved], notice: null };
    }

    case 'SET_FILTER':
      return { ...state, filter: action.filter };
    case 'CLEAR_NOTICE':
      return state.notice ? { ...state, notice: null } : state;

    case 'MARK_SEEN': {
      const targets = state.filter === 'all' || isView(state.filter) ? state.artists : state.artists.filter((a) => keyOf(a) === state.filter);
      const lastSeen = { ...state.lastSeen };
      for (const a of targets) lastSeen[keyOf(a)] = action.now;
      return { ...state, lastSeen };
    }

    case 'FETCH_START':
      return { ...state, status: 'loading', error: null };
    case 'FETCH_OK': {
      const keep = new Set(state.artists.map(keyOf));
      const feed = withoutKeys({ ...state.feed, ...Object.fromEntries(action.entries) }, keep);
      return { ...state, status: 'ready', feed, fetchedAt: action.now, error: null };
    }
    case 'FETCH_FAIL':
      return { ...state, status: 'error', error: action.error };

    case 'NOTIF_STATUS':
      return state.notif === action.status ? state : { ...state, notif: action.status };
    case 'NOTIF_WANTED':
      return state.notifyWanted === action.value ? state : { ...state, notifyWanted: action.value };

    case 'SET_ONLINE':
      return state.online === action.online ? state : { ...state, online: action.online };
    case 'UPDATE_READY':
      return state.updateReady ? state : { ...state, updateReady: true };

    default:
      return state;
  }
}

// ---------- selectors ----------
const allFeedItems = (state) => state.artists.flatMap((a) => state.feed[keyOf(a)] ?? []);

export function visibleItems(state, limit = 60) {
  if (state.filter === VIEW_SAVED) return state.saved.map((i) => ({ ...i, isNew: false }));
  const pool = state.filter === VIEW_UPCOMING
    ? allFeedItems(state).filter((i) => i.type === 'news' && isUpcoming(i.title))
    : (state.filter === 'all' ? state.artists.map(keyOf) : [state.filter]).flatMap((k) => state.feed[k] ?? []);
  const seen = new Set();
  return pool
    .sort((a, b) => b.ts - a.ts)
    .filter((i) => {
      if (seen.has(i.id) || seen.has(i.title)) return false;
      seen.add(i.id);
      seen.add(i.title);
      return true;
    })
    .slice(0, limit)
    .map((i) => ({ ...i, isNew: i.ts > (state.lastSeen[keyOf(i.artist)] ?? 0) }));
}

export function unreadCount(state, artist) {
  const seen = state.lastSeen[keyOf(artist)] ?? 0;
  return (state.feed[keyOf(artist)] ?? []).filter((i) => i.ts > seen).length;
}

/** Settings are visible unless a PIN is set and has not been entered this session. */
export const settingsLocked = (state) => Boolean(state.lock) && !state.unlocked;

export const isMuted = (state, artist) => state.settings.muted.some((m) => keyOf(m) === keyOf(artist));

export const isSaved = (state, id) => state.saved.some((i) => i.id === id);

export const upcomingCount = (state) => allFeedItems(state).filter((i) => i.type === 'news' && isUpcoming(i.title)).length;

/** Everything unread across all followed artists (drives the app-icon badge). */
export const totalUnread = (state) => state.artists.reduce((n, a) => n + unreadCount(state, a), 0);

/** Summary shown above the feed when a single artist is selected. */
export function profileFor(state) {
  if (state.filter === 'all' || isView(state.filter)) return null;
  const name = state.artists.find((a) => keyOf(a) === state.filter);
  if (!name) return null;
  const items = [...(state.feed[state.filter] ?? [])].sort((a, b) => b.ts - a.ts);
  const first = (type) => items.find((i) => i.type === type) ?? null;
  return {
    name,
    latestVideo: first('video'),
    latestRelease: first('release'),
    newsCount: items.filter((i) => i.type === 'news').length,
    unread: unreadCount(state, name),
    muted: isMuted(state, name),
  };
}
