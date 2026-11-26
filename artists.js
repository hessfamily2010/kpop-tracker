// Artist presets shared by the app (autocomplete) and the backend (query building).
// `ko` is the Korean name; `aliases` are other spellings people type.
import { MAX_NAME_LENGTH } from './lib/settings.js';

export const ARTISTS = [
  { name: 'BTS', ko: '방탄소년단', aliases: ['Bangtan Boys', 'Bangtan Sonyeondan'] },
  { name: 'BLACKPINK', ko: '블랙핑크', aliases: ['Black Pink'] },
  { name: 'Stray Kids', ko: '스트레이 키즈', aliases: ['SKZ'] },
  { name: 'TWICE', ko: '트와이스' },
  { name: 'NewJeans', ko: '뉴진스', aliases: ['New Jeans'] },
  { name: 'aespa', ko: '에스파' },
  { name: 'IVE', ko: '아이브' },
  { name: 'LE SSERAFIM', ko: '르세라핌', aliases: ['Le Sserafim'] },
  { name: 'SEVENTEEN', ko: '세븐틴', aliases: ['SVT'] },
  { name: 'ENHYPEN', ko: '엔하이픈' },
  { name: 'TOMORROW X TOGETHER', ko: '투모로우바이투게더', aliases: ['TXT'] },
  { name: 'ITZY', ko: '있지' },
  { name: '(G)I-DLE', ko: '아이들', aliases: ['GIDLE', 'G-IDLE', 'I-DLE'] },
  { name: 'NMIXX', ko: '엔믹스' },
  { name: 'ATEEZ', ko: '에이티즈' },
  { name: 'EXO', ko: '엑소' },
  { name: 'Red Velvet', ko: '레드벨벳' },
  { name: "Girls' Generation", ko: '소녀시대', aliases: ['SNSD', 'Girls Generation'] },
  { name: 'SHINee', ko: '샤이니' },
  { name: 'BIGBANG', ko: '빅뱅', aliases: ['Big Bang'] },
  { name: '2NE1', ko: '투애니원' },
  { name: 'MAMAMOO', ko: '마마무' },
  { name: 'ILLIT', ko: '아일릿' },
  { name: 'BABYMONSTER', ko: '베이비몬스터', aliases: ['Baby Monster'] },
  { name: 'ZEROBASEONE', ko: '제로베이스원', aliases: ['ZB1', 'Zero Base One'] },
  { name: 'RIIZE', ko: '라이즈' },
  { name: 'BOYNEXTDOOR', ko: '보이넥스트도어', aliases: ['Boy Next Door'] },
  { name: 'TWS', ko: '투어스' },
  { name: 'KISS OF LIFE', ko: '키스오브라이프', aliases: ['Kiss of Life'] },
  { name: 'Hearts2Hearts', ko: '하츠투하츠', aliases: ['H2H'] },
  { name: 'CORTIS', ko: '코르티스' },
  { name: 'Kep1er', ko: '케플러', aliases: ['Kepler'] },
  { name: 'STAYC', ko: '스테이씨' },
  { name: 'fromis_9', ko: '프로미스나인', aliases: ['Fromis 9', 'fromis9'] },
  { name: 'Dreamcatcher', ko: '드림캐쳐' },
  { name: 'MONSTA X', ko: '몬스타엑스', aliases: ['Monsta X'] },
  { name: 'GOT7', ko: '갓세븐' },
  { name: 'NCT', ko: '엔시티' },
  { name: 'NCT DREAM', ko: '엔시티 드림' },
  { name: 'NCT 127', ko: '엔시티 127' },
  { name: 'WayV', ko: '웨이션브이' },
  { name: 'SUPER JUNIOR', ko: '슈퍼주니어', aliases: ['Super Junior'] },
  { name: 'BTOB', ko: '비투비' },
  { name: 'THE BOYZ', ko: '더보이즈', aliases: ['The Boyz'] },
  { name: 'TREASURE', ko: '트레저' },
  { name: 'P1Harmony', ko: '피원하모니' },
  { name: 'CRAVITY', ko: '크래비티' },
  { name: 'DAY6', ko: '데이식스', aliases: ['Day6'] },
  { name: 'IU', ko: '아이유' },
  { name: 'JENNIE', ko: '제니', aliases: ['Jennie'] },
  { name: 'LISA', ko: '리사', aliases: ['Lisa'] },
  { name: 'ROSÉ', ko: '로제', aliases: ['Rose', 'Rosé'] },
  { name: 'JISOO', ko: '지수', aliases: ['Jisoo'] },
  { name: 'Jungkook', ko: '정국', aliases: ['Jung Kook'] },
  { name: 'Jimin', ko: '지민' },
  { name: 'Taeyeon', ko: '태연' },
];

export const normalizeName = (s) =>
  String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const INDEX = new Map();
for (const preset of ARTISTS) {
  for (const label of [preset.name, preset.ko, ...(preset.aliases ?? [])]) {
    const key = normalizeName(label);
    if (key && !INDEX.has(key)) INDEX.set(key, preset);
  }
}

/** Canonical display name for what the user typed (preset spelling when known). */
export function resolveArtist(input) {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return INDEX.get(normalizeName(name))?.name ?? name;
}

/** Presets whose name, Korean name or alias starts with / contains the text. */
export function suggest(text, limit = 8) {
  const q = normalizeName(text);
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const preset of ARTISTS) {
    const keys = [preset.name, preset.ko, ...(preset.aliases ?? [])].map(normalizeName);
    if (keys.some((k) => k.startsWith(q))) starts.push(preset);
    else if (keys.some((k) => k.includes(q))) contains.push(preset);
  }
  return [...starts, ...contains].slice(0, limit);
}
