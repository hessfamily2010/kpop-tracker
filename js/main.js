// Composition root: wires state, I/O modules, and the UI together.

import { backendEnabled, fetchFeed } from './api.js';
import { createPush } from './push.js';
import { initPwa, isIos, isStandalone } from './pwa.js';
import { createLock, isValidPin, verifyPin } from './lock.js';
import { createStore } from './store.js';
import { createSync } from './sync.js';
import { createUi } from './ui.js';
import { initialState, keyOf, persistable, totalUnread } from './state.js';
import { loadSaved, save } from './storage.js';

const REFRESH_MS = 15 * 60 * 1000;
const detectTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const store = createStore(
  initialState(loadSaved(), { tz: detectTimeZone(), online: navigator.onLine }),
  { onPersist: save },
);
const sync = createSync(store);
const push = createPush(store, sync);

// ---------- feed refresh ----------
let inflight = null;
function refresh() {
  if (inflight) return inflight;
  const { artists, settings, feed, online } = store.get();
  if (!online) return Promise.resolve();
  if (!artists.length) {
    store.dispatch({ type: 'FETCH_OK', entries: [], now: Date.now() });
    return Promise.resolve();
  }
  store.dispatch({ type: 'FETCH_START' });
  inflight = fetchFeed(artists, settings, feed)
    .then((entries) => store.dispatch({ type: 'FETCH_OK', entries, now: Date.now() }))
    .catch((err) => store.dispatch({ type: 'FETCH_FAIL', error: err.message }))
    .finally(() => { inflight = null; });
  return inflight;
}

// ---------- PWA ----------
let installFn = null;
const pwa = initPwa({
  onUpdateReady: () => store.dispatch({ type: 'UPDATE_READY' }),
  onInstallable: (install) => { installFn = install; ui.setInstallable(true); },
  onInstalled: () => { installFn = null; ui.setInstallable(false); ui.showIosHint(false); },
});

// ---------- UI ----------
const ui = createUi({
  addArtist: (name) => store.dispatch({ type: 'ADD_ARTIST', name, now: Date.now() }),
  removeArtist: (name) => store.dispatch({ type: 'REMOVE_ARTIST', name }),
  setFilter: (filter) => store.dispatch({ type: 'SET_FILTER', filter }),
  markSeen: () => store.dispatch({ type: 'MARK_SEEN', now: Date.now() }),
  patchSettings: (patch) => store.dispatch({ type: 'PATCH_SETTINGS', patch }),
  toggleSave: (item) => store.dispatch({ type: 'TOGGLE_SAVE', item, now: Date.now() }),
  toggleMute: (name) => store.dispatch({ type: 'TOGGLE_MUTE', name }),
  unlock: async (pin) => {
    const ok = await verifyPin(pin, store.get().lock);
    if (ok) store.dispatch({ type: 'UNLOCK' });
    return ok;
  },
  setPin: async (pin) => {
    if (!isValidPin(pin)) return false;
    store.dispatch({ type: 'SET_LOCK', lock: await createLock(pin) });
    return true;
  },
  removePin: () => store.dispatch({ type: 'SET_LOCK', lock: null }),
  lockNow: () => store.dispatch({ type: 'RELOCK' }),
  refresh,
  toggleNotify: push.toggle,
  install: () => installFn?.().then(() => ui.setInstallable(false)),
  applyUpdate: pwa.applyUpdate,
  createSync: () => sync.ensureCode().catch(() => {}),
  joinSync: async (code) => { if (await sync.join(code)) refresh(); },
  leaveSync: sync.leave,
  copySyncCode: async () => {
    try {
      await navigator.clipboard.writeText(store.get().syncCode ?? '');
      ui.flashCopied();
    } catch { /* clipboard unavailable */ }
  },
});

// ---------- reactions to state changes ----------
const feedInputs = (s) => JSON.stringify([s.artists.map(keyOf), s.settings.safe, s.settings.releases]);

/** Unread count on the installed app's icon (where the browser supports it). */
function updateBadge(s) {
  if (!('setAppBadge' in navigator)) return;
  const n = totalUnread(s);
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

store.subscribe((s, prev, action) => {
  ui.render(s);
  updateBadge(s);
  if (s.dirty && (!prev.dirty || s.artists !== prev.artists || s.settings !== prev.settings)) sync.schedulePush();
  if (feedInputs(s) !== feedInputs(prev)) refresh();
  if (action.type === 'SET_ONLINE' && s.online) { sync.reconcile(); refresh(); }
});

// ---------- boot ----------
window.addEventListener('online', () => store.dispatch({ type: 'SET_ONLINE', online: true }));
window.addEventListener('offline', () => store.dispatch({ type: 'SET_ONLINE', online: false }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  sync.reconcile();
  const { fetchedAt } = store.get();
  if (!fetchedAt || Date.now() - fetchedAt > REFRESH_MS) refresh();
});
setInterval(refresh, REFRESH_MS);

document.getElementById('sync-section').hidden = !backendEnabled();
ui.showIosHint(isIos() && !isStandalone());
ui.render(store.get());
sync.reconcile().finally(refresh);
push.init();
if (!backendEnabled()) console.info('API_BASE is empty: notifications and sync are disabled.');
