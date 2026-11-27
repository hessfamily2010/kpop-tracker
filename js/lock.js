// Parent PIN: a salted SHA-256 kept on this device. A deterrent for kids, not a security boundary.

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export const isValidPin = (pin) => /^\d{4,8}$/.test(String(pin));

async function digest(pin, salt) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`)));
}

export async function createLock(pin) {
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 8 digits');
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await digest(pin, salt) };
}

export async function verifyPin(pin, lock) {
  if (!lock || !isValidPin(pin)) return false;
  return (await digest(pin, lock.salt)) === lock.hash;
}
