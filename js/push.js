// Web Push enrollment against the Worker backend.

import * as api from './api.js';
import { isIos, isStandalone } from './pwa.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyToBytes = (b64url) => {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const sameKey = (buffer, bytes) => {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

export function createPush(store, sync) {
  const status = (s) => store.dispatch({ type: 'NOTIF_STATUS', status: s });
  const registration = () => navigator.serviceWorker.ready;
  const currentSub = async () => (await registration()).pushManager.getSubscription();

  /** Returns a subscription bound to the server's current VAPID key, replacing a stale one. */
  async function freshSubscription(publicKey) {
    const reg = await registration();
    const key = keyToBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }

  async function register() {
    const [publicKey, code] = await Promise.all([api.vapidPublicKey(), sync.ensureCode()]);
    const sub = await freshSubscription(publicKey);
    await api.subscribe(code, sub.toJSON());
  }

  async function enable() {
    status('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return status(permission === 'denied' ? 'denied' : 'off');
      await register();
      store.dispatch({ type: 'NOTIF_WANTED', value: true });
      status('on');
      (await registration()).showNotification('Notifications are on', {
        body: 'We’ll let you know when there’s news for your artists.',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
      });
    } catch {
      status('error');
    }
  }

  async function disable() {
    status('busy');
    try {
      const sub = await currentSub();
      if (sub) {
        await api.unsubscribe(sub.endpoint).catch(() => { /* server prunes dead endpoints */ });
        await sub.unsubscribe();
      }
      store.dispatch({ type: 'NOTIF_WANTED', value: false });
      status('off');
    } catch {
      status('error');
    }
  }

  /** On startup: report state, and silently repair a missing/stale subscription if the user wanted notifications. */
  async function init() {
    if (!api.backendEnabled()) return status('unavailable');
    if (!supported()) return status(isIos() && !isStandalone() ? 'ios-install' : 'unsupported');
    if (Notification.permission === 'denied') return status('denied');

    try {
      const sub = await currentSub();
      const granted = Notification.permission === 'granted';
      if (granted && (sub || store.get().notifyWanted)) {
        status('on');
        if (store.get().online) await register().catch(() => { /* retried on next open */ });
      } else {
        status('off');
      }
    } catch {
      status('off');
    }
  }

  const toggle = () => (store.get().notif === 'on' ? disable() : enable());
  return { init, toggle };
}
