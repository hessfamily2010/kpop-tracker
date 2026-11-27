import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitle, clusterItems, isSafe, jaccard, looksKorean, looksNonEnglish, tokens } from '../lib/text.js';
import { dayKey, inQuietHours, localParts } from '../lib/schedule.js';
import { DEFAULT_SETTINGS, sanitizeArtists, sanitizeSettings } from '../lib/settings.js';
import { resolveArtist, suggest } from '../artists.js';
import {
  buildNewsQuery, fetchNews, parseBingRss, unwrapBingLink, fetchReleases, hashId, parseItunes, parseRss, prepareItems,
} from '../lib/feed.js';
import { buildDigestPayload, buildPayload, holdReason, planNotification } from '../lib/plan.js';

const NOW = Date.parse('2026-11-26T15:00:00Z');
const HOUR = 3_600_000;

// ---------- text ----------
test('cleanTitle strips only the matching source suffix', () => {
  assert.equal(cleanTitle('NewJeans drop teaser - Billboard', 'Billboard'), 'NewJeans drop teaser');
  assert.equal(cleanTitle('A - B subtitle', 'Billboard'), 'A - B subtitle');
});

test('tokens ignore stop words and plural s', () => {
  assert.deepEqual([...tokens('The new contracts of IVE')].sort(), ['contr', 'ive']);
  assert.deepEqual([...tokens('IVE announces tour', tokens('IVE'))].sort(), ['annou', 'tour']);
  assert.deepEqual(tokens('announce announced announces announcing'), new Set(['annou']));
});

test('jaccard handles empty sets', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('clusterItems merges the same story and keeps the earliest report', () => {
  const mk = (title, ts, artist = 'IVE', type = 'news') => ({ id: title, title, ts, artist, type });
  const out = clusterItems([
    mk('IVE announces world tour dates', 300),
    mk('IVE announces world tour dates for 2027', 100),
    mk('IVE world tour announced', 200),
    mk('LE SSERAFIM comeback teaser released', 150, 'LE SSERAFIM'),
  ]);
  assert.equal(out.length, 2);
  const ive = out.find((i) => i.artist === 'IVE');
  assert.equal(ive.ts, 100);
  assert.equal(ive.also, 2);
});

test('clusterItems keeps different stories about the same artist apart', () => {
  const mk = (title, ts) => ({ id: title, title, ts, artist: 'IVE', type: 'news' });
  assert.equal(clusterItems([mk('IVE announces tour', 1), mk('IVE announces comeback', 2)]).length, 2);
});

test('clusterItems never merges different artists or types', () => {
  const a = { id: 1, title: 'New album out now', ts: 1, artist: 'A', type: 'news' };
  const b = { ...a, id: 2, artist: 'B' };
  const c = { ...a, id: 3, type: 'release' };
  assert.equal(clusterItems([a, b, c]).length, 3);
});

test('isSafe blocks controversy headlines and allows music news', () => {
  assert.equal(isSafe('NewJeans contract omitted protections for minors'), false);
  assert.equal(isSafe('Group sued by former label'), false);
  assert.equal(isSafe('Idol dating rumors denied'), false);
  assert.equal(isSafe('TWICE announces comeback with new mini album'), true);
  assert.equal(isSafe('BLACKPINK to headline festival'), true);
  assert.equal(isSafe('Exposure of new teaser'), true);
});

test('looksKorean drops Hangul headlines only', () => {
  assert.equal(looksKorean('뉴진스 컴백 확정'), true);
  assert.equal(looksKorean('NewJeans comeback confirmed'), false);
  assert.equal(looksKorean('IVE (아이브) announce world tour dates'), false);
  assert.equal(looksKorean(''), false);
});

// ---------- schedule ----------
test('localParts and dayKey respect the time zone', () => {
  const ms = Date.parse('2026-11-26T03:30:00Z');
  assert.deepEqual(localParts(ms, 'UTC'), { date: '2026-11-26', minutes: 210 });
  assert.equal(dayKey(ms, 'America/New_York'), '2026-11-25'); // 22:30 previous evening
  assert.equal(dayKey(ms, 'Not/AZone'), '2026-11-26'); // falls back to UTC
});

test('inQuietHours handles overnight, same-day, disabled and empty windows', () => {
  const at = (iso) => Date.parse(iso);
  const night = { enabled: true, start: '22:00', end: '08:00' };
  assert.equal(inQuietHours(at('2026-11-26T23:00:00Z'), night, 'UTC'), true);
  assert.equal(inQuietHours(at('2026-11-26T07:59:00Z'), night, 'UTC'), true);
  assert.equal(inQuietHours(at('2026-11-26T08:00:00Z'), night, 'UTC'), false);
  assert.equal(inQuietHours(at('2026-11-26T15:00:00Z'), night, 'UTC'), false);
  assert.equal(inQuietHours(at('2026-11-26T12:30:00Z'), { enabled: true, start: '12:00', end: '13:00' }, 'UTC'), true);
  assert.equal(inQuietHours(at('2026-11-26T23:00:00Z'), { ...night, enabled: false }, 'UTC'), false);
  assert.equal(inQuietHours(at('2026-11-26T23:00:00Z'), { enabled: true, start: '09:00', end: '09:00' }, 'UTC'), false);
  // 03:00 UTC is 22:00 in New York (EST) -> quiet there, not in UTC
  assert.equal(inQuietHours(at('2026-11-26T03:00:00Z'), night, 'America/New_York'), true);
});

// ---------- settings ----------
test('sanitizeSettings clamps and defaults', () => {
  const s = sanitizeSettings({ safe: false, maxPerDay: 99, quiet: { start: 'nope', end: '07:30' }, tz: 'x', muted: ['IVE', 'ive', 5] });
  assert.equal(s.safe, false);
  assert.equal(s.maxPerDay, 20);
  assert.equal(s.quiet.start, DEFAULT_SETTINGS.quiet.start);
  assert.equal(s.quiet.end, '07:30');
  assert.equal(s.tz, 'UTC');
  assert.deepEqual(s.muted, ['IVE']);
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS, quiet: { ...DEFAULT_SETTINGS.quiet }, muted: [] });
});

test('sanitizeArtists trims, dedupes case-insensitively, caps length and count', () => {
  assert.deepEqual(sanitizeArtists([' IVE ', 'ive', 'x'.repeat(61), 'TWICE']), ['IVE', 'TWICE']);
  assert.equal(sanitizeArtists(Array.from({ length: 30 }, (_, i) => `a${i}`)).length, 12);
  assert.deepEqual(sanitizeArtists('nope'), []);
});

// ---------- artists ----------
test('resolveArtist maps Korean names and aliases to the canonical spelling', () => {
  assert.equal(resolveArtist('뉴진스'), 'NewJeans');
  assert.equal(resolveArtist('new jeans'), 'NewJeans');
  assert.equal(resolveArtist('skz'), 'Stray Kids');
  assert.equal(resolveArtist('girls generation'), "Girls' Generation");
  assert.equal(resolveArtist('Some Unknown Act'), 'Some Unknown Act');
  assert.equal(resolveArtist('   '), null);
});

test('suggest prefers prefix matches', () => {
  assert.equal(suggest('new')[0].name, 'NewJeans');
  assert.ok(suggest('블랙').some((p) => p.name === 'BLACKPINK'));
  assert.deepEqual(suggest(''), []);
});

// ---------- feed ----------
const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[IVE announce tour &amp; fan event - Billboard]]></title><link>https://news.example/a</link><pubDate>Thu, 26 Nov 2026 12:00:00 GMT</pubDate><source url="https://billboard.com">Billboard</source></item>
<item><title>Bad link item</title><link>http://insecure.example/b</link><pubDate>Thu, 26 Nov 2026 12:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://news.example/c</link></item>
</channel></rss>`;

test('parseRss decodes entities, strips the source suffix and drops bad items', () => {
  const items = parseRss(RSS, 'IVE');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'IVE announce tour & fan event');
  assert.equal(items[0].source, 'Billboard');
  assert.equal(items[0].artist, 'IVE');
  assert.equal(items[0].id, hashId('https://news.example/a'));
});

test('parseItunes keeps recent matching releases only', () => {
  const day = 86_400_000;
  const json = {
    results: [
      { artistName: 'IVE', collectionName: 'IVE EMPATHY - EP', collectionViewUrl: 'https://music.apple.com/x', artworkUrl100: 'https://img/100x100bb.jpg', releaseDate: new Date(NOW - 3 * day).toISOString() },
      { artistName: 'IVE', collectionName: 'Old Album', collectionViewUrl: 'https://music.apple.com/old', releaseDate: new Date(NOW - 90 * day).toISOString() },
      { artistName: 'IVE', collectionName: 'Future Album', collectionViewUrl: 'https://music.apple.com/future', releaseDate: new Date(NOW + 5 * day).toISOString() },
      { artistName: 'Someone Else', collectionName: 'Other', collectionViewUrl: 'https://music.apple.com/other', releaseDate: new Date(NOW - day).toISOString() },
    ],
  };
  const out = parseItunes(json, 'IVE', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'New release: IVE EMPATHY');
  assert.equal(out[0].image, 'https://img/600x600bb.jpg');
  assert.equal(parseItunes({}, 'IVE', NOW).length, 0);
});

test('buildNewsQuery quotes the artist and strips quote characters', () => {
  assert.equal(buildNewsQuery('Stray Kids', 2), '"Stray Kids" (kpop OR k-pop) when:2d');
  assert.equal(buildNewsQuery('A"B', 2), '"AB" (kpop OR k-pop) when:2d');
});

test('fetchNews / fetchReleases return null on failure and items on success', async () => {
  const ok = async () => new Response(RSS, { status: 200 });
  const bad = async () => new Response('nope', { status: 503 });
  const boom = async () => { throw new Error('network'); };
  assert.equal((await fetchNews('IVE', { fetchImpl: ok })).length, 1);
  assert.equal(await fetchNews('IVE', { fetchImpl: bad }), null);
  assert.equal(await fetchReleases('IVE', { fetchImpl: boom }), null);
});

test('prepareItems filters, dedupes and sorts', () => {
  const mk = (title, ts, type = 'news') => ({ id: title, title, ts, artist: 'IVE', type });
  const out = prepareItems([
    mk('IVE contract dispute escalates', 5),
    mk('IVE new single teaser revealed', 3),
    mk('IVE new single teaser released today', 4),
    mk('아이브 컴백', 6),
    mk('New release: Album', 9, 'release'),
  ]);
  assert.deepEqual(out.map((i) => i.title), ['New release: Album', 'IVE new single teaser revealed']);
  assert.equal(prepareItems([mk('IVE contract dispute escalates', 5)], { safe: false }).length, 1);
});

// ---------- plan ----------
const settings = (over = {}) => ({ ...sanitizeSettings({ tz: 'UTC', quiet: { enabled: false } }), ...over });
const item = (title, ts, over = {}) => ({ id: title, title, ts, artist: 'IVE', type: 'news', link: `https://news.example/${ts}`, source: 'X', ...over });
const base = (over = {}) => ({
  sub: { cursor: NOW - 6 * HOUR, sent_day: null, sent_count: 0 },
  profile: { artists: ['IVE', 'TWICE'], settings: settings() },
  itemsBy: { IVE: { news: [item('IVE tour dates announced', NOW - HOUR)], releases: [] }, TWICE: { news: [], releases: [] } },
  now: NOW,
  appUrl: 'https://app.example',
  ...over,
});

test('plan: sends a single headline with its link', () => {
  const r = planNotification(base());
  assert.equal(r.action, 'send');
  assert.equal(r.payload.title, 'IVE');
  assert.equal(r.payload.body, 'IVE tour dates announced');
  assert.equal(r.payload.url, `https://news.example/${NOW - HOUR}`);
  assert.equal(r.cursor, NOW);
  assert.equal(r.sentCount, 1);
  assert.equal(r.sentDay, '2026-11-26');
});

test('plan: batches several items into one notification', () => {
  const r = planNotification(base({
    itemsBy: {
      IVE: { news: [item('IVE tour dates announced', NOW - HOUR)], releases: [] },
      TWICE: { news: [item('TWICE variety show appearance', NOW - 2 * HOUR, { artist: 'TWICE' })], releases: [] },
    },
  }));
  assert.equal(r.payload.title, 'K-Pop Tracker');
  assert.equal(r.payload.body, '2 updates: IVE, TWICE');
  assert.equal(r.payload.url, 'https://app.example');
});

test('plan: release uses artwork and release title', () => {
  const rel = item('New release: EMPATHY', NOW - HOUR, { type: 'release', image: 'https://img/a.jpg' });
  const r = planNotification(base({ itemsBy: { IVE: { news: [], releases: [rel] } } }));
  assert.equal(r.payload.title, 'IVE · new release');
  assert.equal(r.payload.body, 'EMPATHY');
  assert.equal(r.payload.image, 'https://img/a.jpg');
});

test('plan: skips items at or before the cursor', () => {
  const r = planNotification(base({ sub: { cursor: NOW - HOUR, sent_day: null, sent_count: 0 } }));
  assert.equal(r.action, 'none');
});

test('plan: quiet hours hold without consuming anything', () => {
  const quiet = settings({ quiet: { enabled: true, start: '14:00', end: '16:00' } });
  const r = planNotification(base({ profile: { artists: ['IVE'], settings: quiet } }));
  assert.deepEqual(r, { action: 'hold', reason: 'quiet' });
});

test('plan: daily cap holds, and resets on a new day', () => {
  const capped = base({ sub: { cursor: NOW - 6 * HOUR, sent_day: '2026-11-26', sent_count: 5 } });
  assert.deepEqual(planNotification(capped), { action: 'hold', reason: 'cap' });
  const nextDay = base({ sub: { cursor: NOW - 6 * HOUR, sent_day: '2026-11-25', sent_count: 5 } });
  assert.equal(planNotification(nextDay).action, 'send');
});

test('plan: muted artists, releases toggle and safe mode are honoured', () => {
  const muted = base({ profile: { artists: ['IVE'], settings: settings({ muted: ['ive'] }) } });
  assert.equal(planNotification(muted).action, 'none');

  const rel = item('New release: X', NOW - HOUR, { type: 'release' });
  const noReleases = base({ profile: { artists: ['IVE'], settings: settings({ releases: false }) }, itemsBy: { IVE: { news: [], releases: [rel] } } });
  assert.equal(planNotification(noReleases).action, 'none');

  const risky = item('IVE sued over contract', NOW - HOUR);
  const safe = base({ profile: { artists: ['IVE'], settings: settings() }, itemsBy: { IVE: { news: [risky], releases: [] } } });
  assert.equal(planNotification(safe).action, 'none');
  const unsafe = base({ profile: { artists: ['IVE'], settings: settings({ safe: false }) }, itemsBy: { IVE: { news: [risky], releases: [] } } });
  assert.equal(planNotification(unsafe).action, 'send');
});

test('plan: failed feeds are ignored rather than crashing', () => {
  const r = planNotification(base({ itemsBy: { IVE: { news: null, releases: null } } }));
  assert.equal(r.action, 'none');
});

test('buildPayload truncates long text and summarises many artists', () => {
  const long = item('x'.repeat(300), NOW);
  assert.ok(buildPayload([long], 'u').body.length <= 110);
  const many = ['A', 'B', 'C', 'D', 'E'].map((a, i) => item(`t${i}`, NOW - i, { artist: a }));
  assert.equal(buildPayload(many, 'u').body, '5 updates: A, B, C +2');
});

const BING_NOW = Date.parse('2026-11-26T12:00:00Z');
const bingItem = (title, url, pub) => `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=${encodeURIComponent(url)}&amp;c=1</link><pubDate>${pub}</pubDate><News:Source>Soompi</News:Source></item>`;
const BING = `<rss><channel>${bingItem('IVE announce tour &amp; fan meet', 'https://soompi.example/a', 'Thu, 26 Nov 2026 09:39:00 GMT')}${bingItem('Old story about IVE', 'https://soompi.example/old', 'Mon, 01 Jun 2026 09:00:00 GMT')}${bingItem('Insecure link', 'http://insecure.example/x', 'Thu, 26 Nov 2026 09:00:00 GMT')}</channel></rss>`;

test('unwrapBingLink extracts the https target and rejects everything else', () => {
  assert.equal(unwrapBingLink('http://www.bing.com/news/apiclick.aspx?ref=x&url=https%3a%2f%2fa.example%2fp'), 'https://a.example/p');
  assert.equal(unwrapBingLink('http://www.bing.com/news/apiclick.aspx?url=http%3a%2f%2fa.example'), '');
  assert.equal(unwrapBingLink('not a url'), '');
});

test('parseBingRss decodes entities, takes the source tag and drops non-https links', () => {
  const items = parseBingRss(BING, 'IVE');
  assert.deepEqual(items.map((i) => i.link), ['https://soompi.example/a', 'https://soompi.example/old']);
  assert.equal(items[0].title, 'IVE announce tour & fan meet');
  assert.equal(items[0].source, 'Soompi');
});

test('fetchNews prefers Bing (windowed), falls back to Google, and reports total failure as null', async () => {
  const route = (bing, google) => async (url) => {
    const body = String(url).includes('bing.com') ? bing : google;
    return body === null ? new Response('no', { status: 503 }) : new Response(body, { status: 200 });
  };
  const viaBing = await fetchNews('IVE', { fetchImpl: route(BING, null), windowDays: 3, now: BING_NOW });
  assert.deepEqual(viaBing.map((i) => i.link), ['https://soompi.example/a']);

  const viaGoogle = await fetchNews('IVE', { fetchImpl: route(null, RSS), now: BING_NOW });
  assert.equal(viaGoogle.length, 1);

  assert.equal(await fetchNews('IVE', { fetchImpl: route(null, null), now: BING_NOW }), null);
});

test('looksNonEnglish drops Thai, Japanese, Chinese and Korean headlines but keeps English with a native name', () => {
  assert.equal(looksNonEnglish('Spotify ชานแฟน K-Pop ดูโชว์เลิกรัคคูฟิทจาก IVE'), true);
  assert.equal(looksNonEnglish('IVE・ユジン、日本のコンビニで買い物'), true);
  assert.equal(looksNonEnglish('IVE 发布新专辑'), true);
  assert.equal(looksNonEnglish('IVE (아이브) announce world tour dates'), false);
  assert.equal(looksNonEnglish('PUBG launches music project with IVE'), false);
});

test('digest mode waits for the digest time, sends one summary a day, ignores the daily cap', () => {
  const tz = 'UTC';
  const settings = (at) => ({ ...DEFAULT_SETTINGS, tz, quiet: { enabled: false, start: '22:00', end: '08:00' }, digest: { enabled: true, at } });
  const at = (h) => Date.parse(`2026-11-26T${h}:00:00Z`);
  const sub = { cursor: 0, sent_day: null, sent_count: 0 };
  assert.equal(holdReason(sub, settings('17:00'), at('16')), 'digest-wait');
  assert.equal(holdReason(sub, settings('17:00'), at('18')), null);
  assert.equal(holdReason({ ...sub, sent_day: '2026-11-26', sent_count: 1 }, settings('17:00'), at('19')), 'digest-done');
  assert.equal(holdReason({ ...sub, sent_day: '2026-11-25', sent_count: 9 }, settings('17:00'), at('19')), null);

  const items = [
    { artist: 'IVE', title: 'IVE tour dates', type: 'news', ts: 1, link: 'https://x' },
    { artist: 'aespa', title: 'New release: Drama', type: 'release', ts: 2, link: 'https://y', image: 'https://img' },
  ];
  const p = buildDigestPayload(items, 'https://app');
  assert.equal(p.title, 'K-Pop daily digest · 2 updates');
  assert.match(p.body, /IVE: IVE tour dates • aespa: new release Drama/);
  assert.equal(p.tag, 'kpop-digest');
  assert.equal(p.image, 'https://img');
});

// ---------- youtube ----------
import { fetchUploads, parseUploads, pickChannel, resolveChannel, uploadsPlaylistId } from '../lib/youtube.js';

const CH = 'UC' + 'a'.repeat(22);
const YT_NOW = Date.parse('2026-11-26T12:00:00Z');
const vid = (id, title, at) => ({ snippet: { title, resourceId: { videoId: id }, thumbnails: { medium: { url: 'https://i.ytimg.com/vi/x/mq.jpg' } } }, contentDetails: { videoPublishedAt: at } });

test('pickChannel only accepts channels named after the artist and prefers the official one', () => {
  const json = { items: [
    { snippet: { channelId: 'UC' + 'b'.repeat(22), title: 'IVE fan edits' } },
    { snippet: { channelId: CH, title: 'IVE OFFICIAL' } },
    { snippet: { channelId: 'UC' + 'c'.repeat(22), title: 'Totally unrelated' } },
  ] };
  assert.equal(pickChannel(json, 'IVE').id, CH);
  assert.equal(pickChannel({ items: [{ snippet: { channelId: CH, title: 'Cooking tips' } }] }, 'IVE'), null);
  assert.equal(pickChannel({ items: [{ snippet: { channelId: 'bad', title: 'IVE' } }] }, 'IVE'), null);
  assert.equal(pickChannel({}, 'IVE'), null);
});

test('uploadsPlaylistId swaps the UC prefix for UU', () => {
  assert.equal(uploadsPlaylistId(CH), 'UU' + 'a'.repeat(22));
});

test('parseUploads keeps recent public videos only and builds watch links', () => {
  const json = { items: [
    vid('dQw4w9WgXcQ', 'IVE &quot;HEYA&quot; MV', '2026-11-25T10:00:00Z'),
    vid('aaaaaaaaaaa', 'Old upload', '2026-01-01T00:00:00Z'),
    vid('bbbbbbbbbbb', 'Private video', '2026-11-25T10:00:00Z'),
    vid('ccccccccccc', 'Future upload', '2027-01-01T00:00:00Z'),
  ] };
  const out = parseUploads(json, 'IVE', 'IVE OFFICIAL', YT_NOW, 14);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].type, out[0].title, out[0].link, out[0].source], ['video', 'IVE "HEYA" MV', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'IVE OFFICIAL']);
  assert.equal(out[0].image, 'https://i.ytimg.com/vi/x/mq.jpg');
});

test('resolveChannel and fetchUploads call the right endpoints with the key', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('/search?')
      ? { items: [{ snippet: { channelId: CH, title: 'IVE OFFICIAL' } }] }
      : { items: [vid('dQw4w9WgXcQ', 'IVE new MV', '2026-11-26T08:00:00Z')] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const channel = await resolveChannel('IVE', 'KEY', { fetchImpl });
  assert.equal(channel.id, CH);
  const items = await fetchUploads(channel, 'IVE', 'KEY', { fetchImpl, now: YT_NOW });
  assert.equal(items.length, 1);
  assert.match(urls[0], /type=channel/);
  assert.match(urls[1], new RegExp(`playlistId=UU${'a'.repeat(22)}`));
  assert.ok(urls.every((u) => u.includes('key=KEY')));
  await assert.rejects(resolveChannel('IVE', 'KEY', { fetchImpl: async () => new Response('x', { status: 403 }) }), /403/);
});

test('videos are never merged as duplicates and skip language/safety filters; settings.videos gates push', () => {
  const v = (id, title) => ({ id, type: 'video', artist: 'IVE', title, ts: 5, link: 'https://y' });
  const out = prepareItems([v('1', "IVE 'HEYA' MV"), v('2', "IVE 'HEYA' Dance Practice"), v('3', '아이브 직캠 lawsuit')], { safe: true });
  assert.equal(out.length, 3);
  const base = { sub: { cursor: 0, sent_day: null, sent_count: 0 }, now: NOW, appUrl: 'https://app', itemsBy: { IVE: { news: [], releases: [], videos: [v('1', 'IVE new MV')] } } };
  const on = planNotification({ ...base, profile: { artists: ['IVE'], settings: { ...DEFAULT_SETTINGS, quiet: { enabled: false, start: '22:00', end: '08:00' }, videos: true } } });
  assert.equal(on.action, 'send');
  assert.equal(on.payload.title, 'IVE · new video');
  const off = planNotification({ ...base, profile: { artists: ['IVE'], settings: { ...DEFAULT_SETTINGS, quiet: { enabled: false, start: '22:00', end: '08:00' }, videos: false } } });
  assert.equal(off.action, 'none');
});

test('pickChannel prefers the channel named exactly like the artist over "Official" variants', () => {
  const json = { items: [
    { snippet: { channelId: 'UC' + 'd'.repeat(22), title: 'Stray Kids Japan Official YouTube' } },
    { snippet: { channelId: CH, title: 'Stray Kids' } },
  ] };
  assert.equal(pickChannel(json, 'Stray Kids').id, CH);
});

test('pickChannel uses name hints for groups whose channel is named differently (BTS -> BANGTANTV)', () => {
  const json = { items: [
    { snippet: { channelId: 'UC' + 'e'.repeat(22), title: 'BTS WORLD Official' } },
    { snippet: { channelId: CH, title: 'BANGTANTV' } },
  ] };
  assert.equal(pickChannel(json, 'BTS').id, CH);
});
