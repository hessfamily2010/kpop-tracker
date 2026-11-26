// Headline cleaning, kid-safe filtering and near-duplicate clustering.

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as',
  'is', 'are', 'its', 'it', 'new', 'kpop', 'pop', 'group', 'says', 'after', 'amid', 'over', 'has', 'have',
]);

/** Google News appends " - Source" to every headline; the source is shown separately. */
export function cleanTitle(title, source) {
  const suffix = source ? ` - ${source}` : '';
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title.trim();
}

// Crude stemmer: drop a plural "s", then keep the first 5 letters, so announce/announces/announced match.
const stem = (w) => {
  const base = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
  return base.length > 5 ? base.slice(0, 5) : base;
};

/** Distinctive words of a headline; `exclude` (e.g. the artist's own name) is ignored. */
export function tokens(title, exclude = new Set()) {
  const out = new Set();
  for (const raw of String(title).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    const t = stem(raw);
    if (!exclude.has(t)) out.add(t);
  }
  return out;
}

const overlap = (a, b) => {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
};

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const shared = overlap(a, b);
  return shared / (a.size + b.size - shared);
}

// Two headlines are "the same story" when they are similar overall AND share at least two real words.
const sameStory = (a, b, threshold) => overlap(a, b) >= 2 && jaccard(a, b) >= threshold;

/**
 * Merge reports of the same story. The earliest report represents the cluster (so later copies
 * never look "new"), and `also` counts how many other outlets covered it.
 */
export function clusterItems(items, threshold = 0.4) {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const clusters = [];
  for (const item of sorted) {
    // Every headline mentions the artist, so their name must not count as "shared" wording.
    const toks = tokens(item.title, tokens(item.artist));
    const hit = clusters.find(
      (c) => c.artist === item.artist && c.type === item.type && sameStory(c.toks, toks, threshold),
    );
    if (hit) hit.item.also += 1;
    else clusters.push({ artist: item.artist, type: item.type, toks, item: { ...item, also: 0 } });
  }
  return clusters.map((c) => c.item);
}

// ---- kid-safe filter ----
const BLOCKED = new RegExp(
  '\\b(' + [
    'lawsuits?', 'sued', 'sues', 'suing', 'court', 'trial', 'verdict', 'allegations?', 'alleged(ly)?',
    'accus\\w*', 'assault\\w*', 'abus\\w*', 'harass\\w*', 'bull(y|ies|ied|ying)', 'scandals?', 'controvers\\w*',
    'dating', 'relationship', 'girlfriend', 'boyfriend', 'affair', 'pregnan\\w*', 'arrest\\w*', 'police',
    'investigat\\w*', 'drugs?', 'overdose', 'suicid\\w*', 'death', 'died', 'dies', 'dead', 'funeral',
    'sex\\w*', 'nude', 'naked', 'leak\\w*', 'rumou?rs?', 'plagiari\\w*', 'racis\\w*', 'slurs?', 'hate',
    'feud', 'disband\\w*', 'terminat\\w*', 'contracts?', 'exploit\\w*', 'toxic', 'stalk\\w*', 'deepfakes?',
    'fraud', 'tax', 'disputes?', 'breach\\w*', 'blackmail\\w*', 'threat\\w*', 'shooting', 'crash\\w*',
    'injur\\w*', 'hospital\\w*', 'surgery', 'illegal', 'crime\\w*', 'criminal', 'prosecut\\w*', 'indict\\w*',
    'fined', 'banned', 'boycott\\w*', 'protest\\w*', 'backlash', 'apolog\\w*', 'slams?', 'slammed', 'blasts?',
    'expos(e|ed|es|ing)', 'child labor', 'minors?',
  ].join('|') + ')\\b',
  'i',
);

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;

/** English feed only: drop headlines that are mostly Hangul. */
export function looksKorean(title) {
  const letters = String(title).match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return false;
  return (String(title).match(HANGUL)?.length ?? 0) / letters > 0.3;
}

export const isSafe = (title) => !BLOCKED.test(title);
