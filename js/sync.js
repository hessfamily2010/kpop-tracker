// Cross-device sync. Last write wins: local edits (dirty) are pushed; otherwise a newer remote profile is adopted.

import * as api from './api.js';

const PUSH_DEBOUNCE_MS = 800;

export function createSync(store) {
  let timer = null;
  let busy = null;

  const status = (s, message = '') => store.dispatch({ type: 'SYNC_STATUS', status: s, message });
  const errorMessage = (err) => (err.status === 404 ? 'That sync code was not found.' : err.status === 429 ? 'Too many tries, wait a bit.' : 'Could not reach sync. Will retry.');

  async function pushNow() {
    const s = store.get();
    if (!s.syncCode || !api.backendEnabled()) return;
    const remote = await api.putProfile(s.syncCode, { artists: s.artists, settings: s.settings });
    store.dispatch({ type: 'SYNC_SYNCED', updatedAt: remote.updatedAt });
  }

  /** Reconcile with the server (app start / foreground). */
  async function reconcile() {
    if (busy) return busy;
    busy = (async () => {
      const s = store.get();
      if (!s.syncCode || !api.backendEnabled() || !s.online) return;
      try {
        if (s.dirty) {
          await pushNow();
        } else {
          const remote = await api.getProfile(s.syncCode);
          if (remote.updatedAt > s.syncedAt) {
            store.dispatch({ type: 'ADOPT_REMOTE', artists: remote.artists, settings: remote.settings, updatedAt: remote.updatedAt, now: Date.now() });
          }
        }
        status('idle');
      } catch (err) {
        status('error', errorMessage(err));
      }
    })().finally(() => { busy = null; });
    return busy;
  }

  /** Debounced push after a local edit. */
  function schedulePush() {
    const s = store.get();
    if (!s.syncCode || !api.backendEnabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => pushNow().then(() => status('idle')).catch((e) => status('error', errorMessage(e))), PUSH_DEBOUNCE_MS);
  }

  /** Ensure this device has a sync code (creating a profile and uploading local data). */
  async function ensureCode() {
    const s = store.get();
    if (s.syncCode) return s.syncCode;
    status('busy', 'Creating sync code…');
    try {
      const { code } = await api.createProfile();
      store.dispatch({ type: 'SET_SYNC_CODE', code });
      await pushNow();
      status('idle');
      return code;
    } catch (err) {
      status('error', errorMessage(err));
      throw err;
    }
  }

  /** Join an existing profile; its data replaces this device's (or seeds it if the profile is empty). */
  async function join(input) {
    status('busy', 'Connecting…');
    try {
      const remote = await api.getProfile(input);
      store.dispatch({ type: 'SET_SYNC_CODE', code: remote.code });
      if (remote.artists.length || !store.get().artists.length) {
        store.dispatch({ type: 'ADOPT_REMOTE', artists: remote.artists, settings: remote.settings, updatedAt: remote.updatedAt, now: Date.now() });
      } else {
        await pushNow();
      }
      status('idle');
      return true;
    } catch (err) {
      status('error', errorMessage(err));
      return false;
    }
  }

  const leave = () => {
    clearTimeout(timer);
    store.dispatch({ type: 'SET_SYNC_CODE', code: null });
    status('idle');
  };

  return { reconcile, schedulePush, ensureCode, join, leave };
}
