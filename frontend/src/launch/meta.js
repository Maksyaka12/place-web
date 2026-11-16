// Token metadata for Place Launch. A launch stores its logo in the token's contract URI: the site writes a
// small JSON as a data: URI ({"image": "ipfs://…"}), so the URI is known before the launch and the token
// address can be predicted from it (ERC-20 init code depends on it). Older tokens may point to https or
// ipfs JSON instead; readContractUri handles all three.
import { ipfsUrl } from '../place/format.js';

/** data:application/json;base64 URI with the logo, as the launch form writes it. */
export function buildContractUri({ image }) {
  const json = JSON.stringify(image ? { image } : {});
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return `data:application/json;base64,${b64}`;
}

/** Decodes a data: JSON URI; null for anything else. */
export function decodeDataUri(uri) {
  const m = String(uri || '').match(/^data:application\/json(;base64)?,(.*)$/s);
  if (!m) return null;
  try {
    const text = m[1] ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** Metadata JSON behind a contract URI (data:, ipfs:// or https://), or null when there is none. */
export async function readContractUri(uri, { signal } = {}) {
  if (!uri) return null;
  const inline = decodeDataUri(uri);
  if (inline) return inline;
  const url = ipfsUrl(uri);
  if (!url) return null;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  // A contract URI that points straight at an image is the image itself.
  if (type.startsWith('image/')) return { image: uri };
  return res.json().catch(() => null);
}

/** Image URL to show for a token, from its metadata. */
export const imageUrl = (meta) => (meta?.image ? ipfsUrl(meta.image) : null);
