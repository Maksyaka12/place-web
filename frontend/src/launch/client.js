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
  stocks: (signal) => get('stocks', {}, signal),
  stats: (signal) => get('stats', {}, signal),
  profile: (address, signal) => get('profile', { address }, signal),
  fundQuote: (q, signal) => get('fund-quote', q, signal),
  staking: (q = {}, signal) => get('staking', q, signal),
  stakingPosition: (q, signal) => get('staking/position', q, signal),
  keeper: (q = {}, signal) => get('keeper', q, signal),
  /** 0.3.0: reward token options of a pair (`quote` = address or 'eth'): { tokens: [{ address, symbol, name, decimals, source }] } */
  rewardTokens: (quote, signal) => get('reward-tokens', { quote }, signal),
  /** 0.3.0: what `account` can claim over every token (proofs + ready claimMany transactions); `token` narrows it. */
  rewards: (account, signal, token) => get('rewards', token ? { account, token } : { account }, signal),
  /** Rewards hub: every reward stream of any token, typed and sorted by source; with `account`, its claims. */
  hub: (q = {}, signal) => get('hub', q, signal),
  /** Rewards hub: one stream with its last days and the calls anyone can make. */
  hubStream: (q, signal) => get('hub/stream', q, signal),
  /** Rewards hub create form: what a token or collection allows. */
  hubAsset: (q, signal) => get('hub/asset', q, signal),
  saveProfile: (body) => request('POST', 'profile', { body: { chainId: PLACE_CHAIN_ID, ...body } }),
  /** NFT launchpad: collections ({ token, official, creator, holder, pool, q, sort, limit, offset }); { deployed: false } before the deploy. */
  collections: (q = {}, signal) => get('collections', q, signal),
  /** One collection with its live pool, holders, mints and log; with `account`, its NFTs and what it can claim. */
  collection: (address, account, signal) => get('collection', account ? { address, account } : { address }, signal),
  collectionHolders: (q, signal) => get('collection/holders', q, signal),
  /** A wallet's NFTs, collections, claimable holder rewards and claims. */
  nftAccount: (account, signal) => get('nft/account', { account }, signal),
  /** Tokens a collection can pair with, and its reward token options. */
  nftPairs: (signal) => get('nft/pairs', {}, signal),
  /** Whether one token can pair a collection, and why not. */
  nftPair: (address, signal) => get('nft/pair', { address }, signal),
  /** Register token: what the API sees about a token and this wallet's rights. */
  projectCheck: (q, signal) => get('projects/check', q, signal),
  projects: (q = {}, signal) => get('projects', q, signal),
  registerProject: (body) => request('POST', 'projects/register', { body: { chainId: PLACE_CHAIN_ID, ...body } }),
};
