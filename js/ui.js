// DOM rendering. Reads state, never mutates it; user intent leaves through the `actions` callbacks.

import { suggest } from '../artists.js';
import { MAX_ARTISTS } from '../lib/settings.js';
import { isMuted, keyOf, settingsLocked, unreadCount, visibleItems } from './state.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  children.flat().forEach((c) => c && node.append(c));
  return node;
};

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 60) return `${m || 1}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const NOTIF_UI = {
  checking: { button: null, msg: '' },
  off: { button: 'Turn on notifications', msg: '' },
  on: { button: 'Turn off notifications', msg: 'You’ll get an alert when there’s news for your artists.' },
  busy: { button: 'Working…', msg: '' },
  denied: { button: null, msg: 'Notifications are blocked. Allow them in this site’s browser settings, then reload.' },
  'ios-install': { button: null, msg: 'To get notifications on iPhone/iPad, add this app to the Home Screen and open it from there.' },
  unsupported: { button: null, msg: 'Notifications aren’t supported in this browser.' },
  unavailable: { button: null, msg: 'Notifications are not set up yet.' },
  error: { button: 'Try notifications again', msg: 'Couldn’t set up notifications. Check your connection and try again.' },
};

const setValue = (input, value) => {
  if (document.activeElement !== input && input.value !== String(value)) input.value = value;
};
const setChecked = (input, value) => { if (input.checked !== value) input.checked = value; };

export function createUi(actions) {
  const feedEl = $('feed');

  // ----- static bindings -----
  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('artist-input');
    actions.addArtist(input.value);
    input.value = '';
    $('artist-options').replaceChildren();
  });
  $('artist-input').addEventListener('input', (e) => {
    $('artist-options').replaceChildren(
      ...suggest(e.target.value).map((a) => el('option', { value: a.name, label: a.ko ? `${a.name} · ${a.ko}` : a.name })),
    );
  });
  $('refresh').onclick = actions.refresh;
  $('mark-read').onclick = actions.markSeen;
  $('notify').onclick = actions.toggleNotify;
  $('install').onclick = () => actions.install?.();
  $('update-btn').onclick = actions.applyUpdate;

  $('set-safe').onchange = (e) => actions.patchSettings({ safe: e.target.checked });
  $('set-releases').onchange = (e) => actions.patchSettings({ releases: e.target.checked });
  $('set-quiet').onchange = (e) => actions.patchSettings({ quiet: { enabled: e.target.checked } });
  $('set-quiet-start').onchange = (e) => actions.patchSettings({ quiet: { start: e.target.value } });
  $('set-quiet-end').onchange = (e) => actions.patchSettings({ quiet: { end: e.target.value } });
  $('set-digest').onchange = (e) => actions.patchSettings({ digest: { enabled: e.target.checked } });
  $('set-digest-at').onchange = (e) => actions.patchSettings({ digest: { at: e.target.value } });
  $('set-max').onchange = (e) => actions.patchSettings({ maxPerDay: Number(e.target.value) });

  $('lock-gate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await actions.unlock($('unlock-pin').value);
    $('unlock-pin').value = '';
    $('unlock-msg').textContent = ok ? '' : 'Wrong PIN.';
  });
  $('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await actions.setPin($('lock-pin').value);
    $('lock-pin').value = '';
    $('lock-msg').textContent = ok ? 'PIN set.' : 'Use 4 to 8 digits.';
  });
  $('lock-remove').onclick = actions.removePin;
  $('lock-now').onclick = actions.lockNow;
  $('sync-create').onclick = actions.createSync;
  $('sync-leave').onclick = actions.leaveSync;
  $('sync-copy').onclick = actions.copySyncCode;
  $('sync-form').addEventListener('submit', (e) => {
    e.preventDefault();
    actions.joinSync($('sync-input').value);
  });

  // ----- render pieces -----
  function renderChips(s) {
    const chips = [];
    if (s.artists.length) {
      const all = el('button', { className: 'chip', type: 'button', textContent: 'All' });
      all.setAttribute('aria-pressed', String(s.filter === 'all'));
      all.onclick = () => actions.setFilter('all');
      chips.push(all);
    }
    for (const name of s.artists) {
      const k = keyOf(name);
      const chip = el('span', { className: 'chip', role: 'button', tabIndex: 0 }, name);
      chip.setAttribute('aria-pressed', String(s.filter === k));
      if (isMuted(s, name)) chip.append(el('span', { className: 'muted-icon', textContent: '🔕', title: 'Notifications muted' }));
      const n = unreadCount(s, name);
      if (n) chip.append(el('span', { className: 'count', textContent: String(n) }));
      const x = el('span', { className: 'x', textContent: '✕', title: `Remove ${name}` });
      x.onclick = (e) => { e.stopPropagation(); actions.removeArtist(name); };
      chip.append(x);
      const select = () => actions.setFilter(k);
      chip.onclick = select;
      chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } };
      chips.push(chip);
    }
    $('chips').replaceChildren(...chips);
  }

  const skeleton = () => Array.from({ length: 4 }, () => el('li', { className: 'skeleton', ariaHidden: 'true' },
    el('div', { className: 'bar-a' }), el('div', { className: 'bar-b' })));

  function card(i) {
    const link = el('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer', textContent: i.title });
    const meta = el('div', { className: 'meta' },
      el('span', { className: 'tag', textContent: i.artist }),
      i.type === 'release' ? el('span', { className: 'pill', textContent: 'Release' }) : null,
      i.source ? el('span', { textContent: i.source }) : null,
      el('span', { textContent: timeAgo(i.ts) }),
      i.also ? el('span', { textContent: `+${i.also} more ${i.also === 1 ? 'report' : 'reports'}` }) : null,
      i.isNew ? el('span', { className: 'badge', textContent: 'NEW' }) : null);
    const body = el('div', { className: 'body' }, link, meta);
    const art = i.image ? el('img', { src: i.image, alt: '', loading: 'lazy', width: 64, height: 64, className: 'art' }) : null;
    return el('li', { className: art ? 'has-art' : '' }, art, body);
  }

  function renderFeed(s) {
    const items = visibleItems(s);
    const loadingFirst = s.status === 'loading' && !items.length;
    feedEl.setAttribute('aria-busy', String(loadingFirst));
    feedEl.replaceChildren(...(loadingFirst ? skeleton() : items.map(card)));

    const msg = $('message');
    msg.className = '';
    msg.textContent = '';
    if (!s.artists.length) {
      msg.className = 'empty';
      msg.textContent = 'Add your daughter’s favorite artists above to start tracking.';
    } else if (s.status === 'error') {
      msg.className = 'error';
      msg.textContent = `Couldn’t load updates (${s.error}). Try Refresh.`;
    } else if (s.status === 'ready' && !items.length) {
      msg.className = 'empty';
      msg.textContent = 'No recent updates found.';
    }
  }

  function renderSettings(s) {
    const c = s.settings;
    setChecked($('set-safe'), c.safe);
    setChecked($('set-releases'), c.releases);
    setChecked($('set-quiet'), c.quiet.enabled);
    setValue($('set-quiet-start'), c.quiet.start);
    setValue($('set-quiet-end'), c.quiet.end);
    setValue($('set-max'), c.maxPerDay);
    $('quiet-times').hidden = !c.quiet.enabled;
    setChecked($('set-digest'), c.digest.enabled);
    setValue($('set-digest-at'), c.digest.at);
    $('digest-time').hidden = !c.digest.enabled;

    const locked = settingsLocked(s);
    $('lock-gate').hidden = !locked;
    $('settings-body').hidden = locked;
    $('settings-summary').textContent = s.lock ? (locked ? '🔒 Settings' : '🔓 Settings') : 'Settings';
    $('lock-form').hidden = Boolean(s.lock);
    $('lock-remove').hidden = !s.lock;
    $('lock-now').hidden = !s.lock;
    $('lock-hint').textContent = s.lock ? 'A PIN is set on this device.' : 'Require a PIN to open these settings on this device.';

    $('mute-list').replaceChildren(...s.artists.map((name) => {
      const box = el('input', { type: 'checkbox', checked: !isMuted(s, name) });
      box.onchange = () => actions.toggleMute(name);
      return el('label', { className: 'row' }, box, ` Notify for ${name}`);
    }));
    $('mute-section').hidden = !s.artists.length;
    $('artist-count').textContent = `${s.artists.length}/${MAX_ARTISTS} artists`;

    const hasCode = Boolean(s.syncCode);
    $('sync-code').textContent = hasCode ? s.syncCode.replace(/(.{4})(?=.)/g, '$1-') : 'Not syncing';
    $('sync-copy').hidden = !hasCode;
    $('sync-leave').hidden = !hasCode;
    $('sync-create').hidden = hasCode;
    $('sync-status').textContent = s.sync.message;
    $('sync-status').dataset.state = s.sync.status;
  }

  function renderStatus(s) {
    $('status').textContent = !s.online ? 'Offline' : s.status === 'loading' ? 'Updating…' : s.fetchedAt ? `Updated ${timeAgo(s.fetchedAt)}` : '';
    $('refresh').disabled = s.status === 'loading' || !s.online;
    $('offline').hidden = s.online;
    $('update').hidden = !s.updateReady;
    $('notice').textContent = s.notice ?? '';
  }

  function renderNotify(s) {
    const ui = NOTIF_UI[s.notif] ?? NOTIF_UI.checking;
    const btn = $('notify');
    btn.classList.toggle('visible', Boolean(ui.button));
    btn.classList.toggle('on', s.notif === 'on');
    btn.disabled = s.notif === 'busy';
    btn.textContent = ui.button ? `🔔 ${ui.button}` : '';
    $('notify-msg').textContent = ui.msg;
  }

  return {
    render(s) { renderChips(s); renderFeed(s); renderSettings(s); renderStatus(s); renderNotify(s); },
    setInstallable(on) { $('install').classList.toggle('visible', on); },
    showIosHint(on) { $('ios-hint').classList.toggle('visible', on); },
    flashCopied() { const b = $('sync-copy'); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); },
  };
}
