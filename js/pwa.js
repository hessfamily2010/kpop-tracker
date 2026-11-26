// Install prompt, service-worker registration and the "new version" flow.

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * @param {{onUpdateReady: () => void, onInstallable: (install: () => Promise<void>) => void, onInstalled: () => void}} hooks
 * @returns {{applyUpdate: () => void}}
 */
export function initPwa({ onUpdateReady, onInstallable, onInstalled }) {
  let waiting = null;

  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return; // first install: nothing to refresh
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const flag = (worker) => { waiting = worker; onUpdateReady(); };
      if (reg.waiting && navigator.serviceWorker.controller) flag(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        next?.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) flag(next);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => { /* offline support unavailable */ });
  }

  if (!isStandalone()) {
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      onInstallable(async () => {
        if (!deferred) return;
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
      });
    });
    window.addEventListener('appinstalled', () => { deferred = null; onInstalled(); });
  }

  return { applyUpdate: () => waiting?.postMessage({ type: 'SKIP_WAITING' }) };
}
