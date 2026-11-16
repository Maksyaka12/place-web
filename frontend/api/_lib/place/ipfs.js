// IPFS for Place: pinning through Pinata (env PINATA_JWT) and reading through public gateways.
// What is read back is always checked by the caller (rules against rulesHash, tables against the root), so
// any gateway is safe to use.
import { retry } from './chain.js';

const PINATA_UPLOAD = 'https://uploads.pinata.cloud/v3/files';
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

export function cidFromUri(uri) {
  const m = String(uri || '').match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/.*)?$/);
  if (!m) throw new Error(`Not an ipfs:// URI: ${uri}`);
  return m[1] + (m[2] || '');
}

/**
 * Pins `text` (a string or bytes) as a public file and returns `ipfs://<cid>`. `name` shows in the Pinata dashboard.
 * Exactly these bytes are pinned, so a hash of `text` matches what any gateway serves.
 */
export async function pinText(text, { name, jwt = process.env.PINATA_JWT, fetchFn = fetch, contentType = 'application/json' }) {
  if (!jwt) throw new Error('PINATA_JWT is not set');
  return retry(async () => {
    const form = new FormData();
    form.append('network', 'public');
    form.append('name', name);
    form.append('file', new Blob([text], { type: contentType }), name);
    const res = await fetchFn(PINATA_UPLOAD, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data?.cid) throw new Error(`Pinata upload failed: ${body?.error?.message || body?.error || res.status}`);
    return `ipfs://${body.data.cid}`;
  }, 3);
}

/** Fetches an ipfs:// URI as text, trying gateways in turn. */
export async function fetchIpfsText(uri, { fetchFn = fetch, gateways = GATEWAYS, timeoutMs = 20_000 } = {}) {
  // Place Launch vaults commit an https:// rules template; its hash is checked like any rules.
  if (/^https:\/\//.test(String(uri))) {
    const res = await fetchFn(uri, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Could not read ${uri}: HTTP ${res.status}`);
    return res.text();
  }
  const path = cidFromUri(uri);
  let last;
  for (const g of gateways) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(g + path, { signal: ctrl.signal });
      if (res.ok) return await res.text();
      last = new Error(`${g}: HTTP ${res.status}`);
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not read ${uri} from IPFS (${last?.message || 'no gateway answered'})`);
}
