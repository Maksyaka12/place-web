// Creator profiles for Place Launch: name, avatar, links and a short bio, stored by the API and changed only
// with a signature from the wallet. The site and the server build the signed text with the same function,
// so a profile can never be saved for a wallet that did not sign it.
export const PROFILE_LIMITS = { name: 40, bio: 180, website: 200 };
export const PROFILE_SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;

const trim = (v) => (v == null ? '' : String(v).trim());

/** "x.com/name", "@name", "https://twitter.com/name" → "name"; null when empty; throws when it is not a handle. */
export function xHandle(v) {
  const s = trim(v)
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  if (!s) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) throw new Error('X handle must be 1–15 letters, digits or _');
  return s;
}

/** "t.me/name", "@name", "https://t.me/name" → "name"; null when empty. */
export function telegramHandle(v) {
  const s = trim(v)
    .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '')
    .replace(/^(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  if (!s) return null;
  if (!/^[A-Za-z0-9_]{4,32}$/.test(s)) throw new Error('Telegram handle must be 4–32 letters, digits or _');
  return s;
}

/** "example.com" → "https://example.com"; null when empty; throws on anything that is not a plain https link. */
export function httpsLink(v, max = PROFILE_LIMITS.website) {
  let s = trim(v);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/^http:\/\//i, 'https://');
  if (s.length > max || !/^https:\/\/[^\s/$.?#][^\s]*\.[^\s]{2,}$/i.test(s)) throw new Error('Enter a link like https://example.com');
  return s;
}

/** Checks and normalizes a profile from the form or a request. Throws an Error with a plain message. */
export function cleanProfile(p = {}) {
  const name = trim(p.name);
  const bio = trim(p.bio).replace(/\s+\n/g, '\n');
  if (name.length > PROFILE_LIMITS.name) throw new Error(`Name can have at most ${PROFILE_LIMITS.name} characters`);
  if (bio.length > PROFILE_LIMITS.bio) throw new Error(`Bio can have at most ${PROFILE_LIMITS.bio} characters`);
  const avatar = trim(p.avatar) || null;
  if (avatar && !/^ipfs:\/\/[A-Za-z0-9]+$/.test(avatar)) throw new Error('Avatar must be an ipfs:// image');
  return {
    name: name || null,
    avatar,
    website: httpsLink(p.website),
    x: xHandle(p.x),
    telegram: telegramHandle(p.telegram),
    bio: bio || null,
  };
}

/** The text the wallet signs to save its profile. Every field is JSON-quoted so line breaks can't fake one. */
export function profileMessage({ address, profile, issuedAt }) {
  const p = cleanProfile(profile);
  const line = (k, v) => `${k}: ${v == null ? '-' : JSON.stringify(v)}`;
  return [
    'Place: save creator profile',
    `Wallet: ${String(address).toLowerCase()}`,
    line('Name', p.name),
    line('Avatar', p.avatar),
    line('Website', p.website),
    line('X', p.x),
    line('Telegram', p.telegram),
    line('Bio', p.bio),
    `Issued: ${issuedAt}`,
  ].join('\n');
}
