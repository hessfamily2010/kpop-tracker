// Local-time helpers (quiet hours, "per day" counting) that work for any IANA time zone.

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    const options = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    };
    try {
      f = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
    }
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const dayKey = (ms, tz) => localParts(ms, tz).date;

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True while `ms` falls inside the (possibly overnight) quiet window in `tz`. */
export function inQuietHours(ms, quiet, tz) {
  if (!quiet || !quiet.enabled) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const now = localParts(ms, tz).minutes;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
