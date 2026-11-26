// localStorage persistence with v1 -> v2 migration. Never throws.

const KEY_V2 = 'kpop-tracker:v2';
const KEY_V1 = 'kpop-tracker:v1';

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function loadSaved() {
  const v2 = read(KEY_V2);
  if (v2 && typeof v2 === 'object') return v2;
  const v1 = read(KEY_V1); // { artists, lastSeen }
  return v1 && typeof v1 === 'object' ? { artists: v1.artists, lastSeen: v1.lastSeen } : {};
}

export function save(persisted) {
  try {
    localStorage.setItem(KEY_V2, JSON.stringify(persisted));
  } catch {
    /* storage unavailable (private mode / quota) */
  }
}
