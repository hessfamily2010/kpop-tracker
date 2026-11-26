import test from 'node:test';
import assert from 'node:assert/strict';

import { initialState, isMuted, persistable, reducer, unreadCount, visibleItems } from '../js/state.js';
import { MAX_ARTISTS } from '../lib/settings.js';

const NOW = 1_700_000_000_000;
const run = (state, ...actions) => actions.reduce(reducer, state);
const fresh = (saved) => initialState(saved, { tz: 'Asia/Seoul' });
const item = (id, artist, ts, title = id) => ({ id, artist, ts, title, type: 'news', link: '#', source: 's' });

test('ADD_ARTIST resolves aliases, marks dirty, and seeds lastSeen', () => {
  const s = run(fresh(), { type: 'ADD_ARTIST', name: '  ive ', now: NOW });
  assert.equal(s.artists.length, 1);
  assert.equal(s.dirty, true);
  assert.equal(s.lastSeen[Object.keys(s.lastSeen)[0]], NOW - 86_400_000);
});

test('ADD_ARTIST rejects blanks, duplicates, and overflow with a notice', () => {
  assert.match(run(fresh(), { type: 'ADD_ARTIST', name: '  ', now: NOW }).notice, /Enter/);
  const once = run(fresh(), { type: 'ADD_ARTIST', name: 'IVE', now: NOW });
  const dup = run(once, { type: 'ADD_ARTIST', name: 'ive', now: NOW });
  assert.equal(dup.artists.length, 1);
  assert.match(dup.notice, /already/);

  let s = fresh();
  for (let i = 0; i < MAX_ARTISTS; i++) s = run(s, { type: 'ADD_ARTIST', name: `Group ${i}`, now: NOW });
  assert.equal(s.artists.length, MAX_ARTISTS);
  assert.match(run(s, { type: 'ADD_ARTIST', name: 'One More', now: NOW }).notice, /up to/);
});

test('REMOVE_ARTIST cleans feed, lastSeen, mute list, and filter', () => {
  let s = run(fresh(), { type: 'ADD_ARTIST', name: 'IVE', now: NOW }, { type: 'ADD_ARTIST', name: 'aespa', now: NOW });
  const [ive, aespa] = s.artists;
  s = run(s, { type: 'TOGGLE_MUTE', name: ive }, { type: 'FETCH_OK', now: NOW, entries: [[ive.toLowerCase(), [item('a', ive, NOW)]], [aespa.toLowerCase(), [item('b', aespa, NOW)]]] }, { type: 'SET_FILTER', filter: ive.toLowerCase() });
  s = run(s, { type: 'REMOVE_ARTIST', name: ive });
  assert.deepEqual(s.artists, [aespa]);
  assert.equal(s.filter, 'all');
  assert.deepEqual(s.settings.muted, []);
  assert.deepEqual(Object.keys(s.feed), [aespa.toLowerCase()]);
  assert.deepEqual(Object.keys(s.lastSeen), [aespa.toLowerCase()]);
});

test('PATCH_SETTINGS merges quiet hours and sanitizes values', () => {
  const s = run(fresh(), { type: 'PATCH_SETTINGS', patch: { quiet: { start: '21:30' }, maxPerDay: 9999 } });
  assert.equal(s.settings.quiet.start, '21:30');
  assert.equal(s.settings.quiet.end, '08:00');
  assert.ok(s.settings.maxPerDay <= 50);
  assert.equal(s.dirty, true);
});

test('TOGGLE_MUTE flips and isMuted reflects it', () => {
  let s = run(fresh(), { type: 'ADD_ARTIST', name: 'IVE', now: NOW });
  const [ive] = s.artists;
  s = run(s, { type: 'TOGGLE_MUTE', name: ive });
  assert.equal(isMuted(s, ive), true);
  s = run(s, { type: 'TOGGLE_MUTE', name: ive });
  assert.equal(isMuted(s, ive), false);
});

test('ADOPT_REMOTE replaces profile data and clears dirty without touching notifyWanted', () => {
  let s = run(fresh({ notifyWanted: true }), { type: 'ADD_ARTIST', name: 'IVE', now: NOW });
  s = run(s, { type: 'ADOPT_REMOTE', artists: ['aespa', 'NewJeans'], settings: { safe: false, muted: ['aespa'] }, updatedAt: 42, now: NOW });
  assert.deepEqual(s.artists, ['aespa', 'NewJeans']);
  assert.equal(s.settings.safe, false);
  assert.equal(s.syncedAt, 42);
  assert.equal(s.dirty, false);
  assert.equal(s.notifyWanted, true);
  assert.ok(s.lastSeen.aespa && s.lastSeen.newjeans);
});

test('SET_SYNC_CODE null resets sync bookkeeping', () => {
  let s = run(fresh({ syncCode: 'X', syncedAt: 5, dirty: true }), { type: 'SET_SYNC_CODE', code: null });
  assert.equal(s.syncCode, null);
  assert.equal(s.syncedAt, 0);
  assert.equal(s.dirty, false);
});

test('visibleItems merges, dedupes, sorts newest first, flags new items, respects filter', () => {
  let s = run(fresh(), { type: 'ADD_ARTIST', name: 'IVE', now: NOW }, { type: 'ADD_ARTIST', name: 'aespa', now: NOW });
  const [ive, aespa] = s.artists;
  s = run(s, {
    type: 'FETCH_OK', now: NOW,
    entries: [
      [ive.toLowerCase(), [item('1', ive, NOW - 1000), item('2', ive, NOW - 5000, 'same')]],
      [aespa.toLowerCase(), [item('3', aespa, NOW - 2000), item('4', aespa, NOW - 6000, 'same')]],
    ],
  });
  const all = visibleItems(s);
  assert.deepEqual(all.map((i) => i.id), ['1', '3', '2']); // '4' dropped: same title as '2'
  assert.ok(all.every((i) => i.isNew)); // lastSeen is a day before NOW

  s = run(s, { type: 'SET_FILTER', filter: aespa.toLowerCase() });
  assert.deepEqual(visibleItems(s).map((i) => i.id), ['3', '4']);
  assert.equal(unreadCount(s, ive), 2);

  s = run(s, { type: 'MARK_SEEN', now: NOW });
  assert.equal(unreadCount(s, aespa), 0);
  assert.equal(unreadCount(s, ive), 2); // filter limited MARK_SEEN to aespa
});

test('fetch lifecycle and status actions are idempotent', () => {
  let s = run(fresh(), { type: 'FETCH_START' });
  assert.equal(s.status, 'loading');
  s = run(s, { type: 'FETCH_FAIL', error: 'boom' });
  assert.deepEqual([s.status, s.error], ['error', 'boom']);
  const same = run(s, { type: 'NOTIF_STATUS', status: 'on' });
  assert.equal(run(same, { type: 'NOTIF_STATUS', status: 'on' }), same);
  assert.equal(run(same, { type: 'UNKNOWN' }), same);
});

test('persistable excludes transient state and round-trips through initialState', () => {
  const s = run(fresh(), { type: 'ADD_ARTIST', name: 'IVE', now: NOW }, { type: 'NOTIF_WANTED', value: true });
  const saved = JSON.parse(JSON.stringify(persistable(s)));
  assert.equal('feed' in saved, false);
  const back = fresh(saved);
  assert.deepEqual(back.artists, s.artists);
  assert.equal(back.notifyWanted, true);
  assert.equal(back.dirty, true);
});
