// Pure decision logic: given a subscription, its profile and fetched items, what should we push?

import { dayKey, inQuietHours, localParts, toMinutes } from './schedule.js';
import { prepareItems } from './feed.js';
import { normalizeName } from '../artists.js';

const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One summary notification: top headlines of everything new today. */
export function buildDigestPayload(items, appUrl) {
  const top = items.slice(0, 3).map((i) => (i.type === 'release' ? `${i.artist}: ${i.title.replace(/^New release: /, 'new release ')}` : `${i.artist}: ${i.title}`));
  return {
    title: `K-Pop daily digest · ${items.length} ${items.length === 1 ? 'update' : 'updates'}`,
    body: clip(top.join(' • '), 160),
    url: appUrl,
    image: items.find((i) => i.image)?.image,
    tag: 'kpop-digest',
  };
}

export function buildPayload(items, appUrl) {
  if (items.length === 1) {
    const [i] = items;
    return {
      title: clip(i.type === 'release' ? `${i.artist} · new release` : i.type === 'video' ? `${i.artist} · new video` : i.artist, 60),
      body: clip(i.type === 'release' ? i.title.replace(/^New release: /, '') : i.title),
      url: i.link,
      image: i.image,
      tag: 'kpop-news',
    };
  }
  const names = [...new Set(items.map((i) => i.artist))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return {
    title: 'K-Pop Tracker',
    body: clip(`${items.length} updates: ${shown}`),
    url: appUrl,
    tag: 'kpop-news',
  };
}

/** Why this subscription must not be notified right now (null = free to send). */
export function holdReason(sub, settings, now) {
  if (inQuietHours(now, settings.quiet, settings.tz)) return 'quiet';
  const { digest } = settings;
  if (digest?.enabled) {
    const { date, minutes } = localParts(now, settings.tz);
    if (minutes < toMinutes(digest.at)) return 'digest-wait';
    if (sub.sent_day === date && sub.sent_count > 0) return 'digest-done';
    return null; // the daily cap does not apply: a digest is at most one per day
  }
  const sentToday = sub.sent_day === dayKey(now, settings.tz) ? sub.sent_count : 0;
  return sentToday >= settings.maxPerDay ? 'cap' : null;
}

/**
 * @param sub      { cursor, sent_day, sent_count }
 * @param profile  { artists, settings }
 * @param itemsBy  { [artist]: { news: Item[]|null, releases: Item[]|null } }
 * @returns {{action:'send', payload, cursor, sentDay, sentCount} | {action:'hold'|'none', reason:string}}
 */
export function planNotification({ sub, profile, itemsBy, now, appUrl }) {
  const { settings } = profile;
  const reason = holdReason(sub, settings, now);
  if (reason) return { action: 'hold', reason };

  const today = dayKey(now, settings.tz);
  const sentToday = sub.sent_day === today ? sub.sent_count : 0;

  const muted = new Set(settings.muted.map(normalizeName));
  const fresh = [];
  for (const artist of profile.artists) {
    if (muted.has(normalizeName(artist))) continue;
    const feed = itemsBy[artist];
    if (!feed) continue;
    const raw = [
      ...(feed.news ?? []),
      ...(settings.releases ? feed.releases ?? [] : []),
      ...(settings.videos ? feed.videos ?? [] : []),
    ];
    for (const item of prepareItems(raw, { safe: settings.safe })) {
      if (item.ts > sub.cursor) fresh.push(item);
    }
  }
  if (!fresh.length) return { action: 'none', reason: 'nothing-new' };

  fresh.sort((a, b) => b.ts - a.ts);
  return {
    action: 'send',
    payload: settings.digest?.enabled ? buildDigestPayload(fresh, appUrl) : buildPayload(fresh, appUrl),
    cursor: now,
    sentDay: today,
    sentCount: sentToday + 1,
  };
}
