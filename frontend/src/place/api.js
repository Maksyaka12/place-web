// Client for the public Place API (server in api/_lib/place/api.js). A thin wrapper over fetch:
// it builds the query string, adds the chain, and turns an error reply into a PlaceApiError with the
// server's message, so pages can show it as is.
import { PLACE_CHAIN_ID } from './chain.js';
import { ipfsUrl, IPFS_GATEWAY_COUNT } from './format.js';

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
export const PLACE_API_BASE = String(env.VITE_PLACE_API || '/api/place').replace(/\/+$/, '');

export class PlaceApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PlaceApiError';
    this.status = status;
  }
}

/** "?a=1&b=x" from an object, skipping null, undefined and empty values. */
export function queryString(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * @param {object} [opts]
 * @param {string} [opts.base]     API root, default /api/place
 * @param {number} [opts.chainId]  default: the Place chain
 * @param {typeof fetch} [opts.fetchFn]
 */
export function createPlaceApi({ base = PLACE_API_BASE, chainId = PLACE_CHAIN_ID, fetchFn } = {}) {
  const doFetch = (...args) => (fetchFn || globalThis.fetch)(...args);

  async function request(method, path, { query, body, signal } = {}) {
    const url = `${base}/${path}${queryString(method === 'GET' ? { chain: chainId, ...query } : query)}`;
    let res;
    try {
      res = await doFetch(url, {
        method,
        signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new PlaceApiError('Place API is not reachable. Check your connection and try again.', 0);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      if (res.ok) throw new PlaceApiError('Place API sent a reply that is not JSON', res.status);
    }
    if (!res.ok) throw new PlaceApiError(data?.error || `Place API error ${res.status}`, res.status);
    return data;
  }

  const get = (path, query, signal) => request('GET', path, { query, signal });
  const post = (path, body) => request('POST', path, { body });

  return {
    chainId,
    /** @param {{status?: 'live'|'upcoming'|'ended'|'all', target?, creator?, kind?, limit?, offset?, includeHidden?}} q */
    campaigns: (q = {}, signal) => get('campaigns', q, signal),
    campaign: ({ hub, id, address }, signal) => get('campaign', { hub, id, address }, signal),
    claims: (address, signal) => get('claims', { address }, signal),
    token: (address, signal) => get('token', { address }, signal),
    collections: (q = {}, signal) => get('collections', q, signal),
    holders: ({ target, kind, min, limit }, signal) => get('holders', { target, kind, min, limit }, signal),
    /** Rules: pass the rules object; the server checks and canonicalizes it and returns {uri, rulesHash}. */
    pinRules: (rules) => post('pin', { kind: 'rules', content: rules }),
    pinMetadata: ({ name, description, image }) => post('pin', { kind: 'metadata', content: { name, description, image } }),
    pinImage: ({ data, contentType }) => post('pin', { kind: 'image', data, contentType }),
    /** Several files as one IPFS folder: [{ name, contentType, data (base64) | content (JSON) }] → { uri: 'ipfs://cid/' }. */
    pinFolder: (files) => post('pin', { kind: 'folder', files }),
    /** Storefront moderation, signed by an admin wallet over moderationMessage(). */
    hide: (body) => post('admin/hide', { chainId, ...body }),
  };
}

/** Fetches a JSON document from IPFS, trying the public gateways in turn. IPFS content never changes. */
export async function fetchIpfsJson(uri, { signal, fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  let last;
  for (let g = 0; g < IPFS_GATEWAY_COUNT; g++) {
    try {
      const res = await fetchFn(ipfsUrl(uri, g), { signal });
      if (!res.ok) throw new Error(`IPFS gateway answered ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      last = e;
    }
  }
  throw new Error(`Could not load ${uri} from IPFS: ${last?.message || 'no gateway answered'}`);
}

export const placeApi = createPlaceApi();

