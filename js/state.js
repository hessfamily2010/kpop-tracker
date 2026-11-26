// Pure application state: reducer + selectors. No DOM, no I/O, so it is fully unit-testable.

import { normalizeName, resolveArtist } from '../artists.js';
import { MAX_ARTISTS, sanitizeArtists, sanitizeSettings } from '../lib/settings.js';

const DAY_MS = 86_400_000;

export const keyOf = normalizeName;

export function initialState(saved = {}, { tz = 'UTC', online = true } = {}) {
  return {
    artists: sanitizeArtists(saved.artists),
    settings: sanitizeSettings({ tz, ...(saved.settings ?? {}) }),
    lastSeen: saved.lastSeen && typeof saved.lastSeen === 'object' ? { ...saved.lastSeen } : {},
    syncCode: typeof saved.syncCode === 'string' ? saved.syncCode : null,
    syncedAt: Number(saved.syncedAt) || 0, // server timestamp of the last profile we synced
    dirty: saved.dirty === true,           // local edits not yet pushed to the sync profile
    notifyWanted: saved.notifyWanted === true,

    feed: {},                // artist key -> items
    filter: 'all',           // 'all' | artist key
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
      const merged = { ...state.settings, ...patch, quiet: { ...state.settings.quiet, ...(patch.quiet ?? {}) } };
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
        filter: state.filter === 'all' || keep.has(state.filter) ? state.filter : 'all',
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

    case 'SET_FILTER':
      return { ...state, filter: action.filter };
    case 'CLEAR_NOTICE':
      return state.notice ? { ...state, notice: null } : state;

    case 'MARK_SEEN': {
      const targets = state.filter === 'all' ? state.artists : state.artists.filter((a) => keyOf(a) === state.filter);
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
export function visibleItems(state, limit = 60) {
  const keys = state.filter === 'all' ? state.artists.map(keyOf) : [state.filter];
  const seen = new Set();
  return keys
    .flatMap((k) => state.feed[k] ?? [])
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

export const isMuted = (state, artist) => state.settings.muted.some((m) => keyOf(m) === keyOf(artist));
