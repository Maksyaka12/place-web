// Client for the Place Launch API (/api/place/launch/*). Same conventions as the hub client
// (src/place/api.js): the chain is added to every GET, and an error reply becomes a PlaceApiError.
import { PLACE_API_BASE, PlaceApiError, queryString } from '../place/api.js';
import { PLACE_CHAIN_ID } from '../place/chain.js';

async function request(method, path, { query, body, signal } = {}) {
  const url = `${PLACE_API_BASE}/launch/${path}${queryString(method === 'GET' ? { chain: PLACE_CHAIN_ID, ...query } : query)}`;
  let res;
  try {
    res = await fetch(url, {
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

export const launchApi = {
  /** @param {{sort?, category?, quote?, creator?, q?, limit?, offset?}} q */
  tokens: (q = {}, signal) => get('tokens', q, signal),
  token: (address, signal) => get('token', { address }, signal),
  candles: (q, signal) => get('candles', q, signal),
  trades: (q = {}, signal) => get('trades', q, signal),
  holders: (q, signal) => get('holders', q, signal),
  creator: (q, signal) => get('creator', q, signal),
  predict: (q, signal) => get('predict', q, signal),
  pairs: (signal) => get('pairs', {}, signal),
  stats: (signal) => get('stats', {}, signal),
  profile: (address, signal) => get('profile', { address }, signal),
  fundQuote: (q, signal) => get('fund-quote', q, signal),
  staking: (q = {}, signal) => get('staking', q, signal),
  stakingPosition: (q, signal) => get('staking/position', q, signal),
  keeper: (q = {}, signal) => get('keeper', q, signal),
  saveProfile: (body) => request('POST', 'profile', { body: { chainId: PLACE_CHAIN_ID, ...body } }),
};
