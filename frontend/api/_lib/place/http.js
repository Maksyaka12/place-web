// Small HTTP helpers shared by the Place API routers (place/api.js and launch/api.js).
import { isAddress, getAddress } from 'viem';
import { DEPLOYMENTS } from '../../../src/place/deployments.js';

export const MAX_LIMIT = 100;
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
export const reply = (status, body, cache = 'no-store') => ({ status, body, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...CORS } });
export const bad = (msg, status = 400) => reply(status, { error: msg });

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (msg, status = 400) => {
  throw new HttpError(status, msg);
};

export function chainOf(q) {
  const chainId = Number(q.chain || q.chainId || Object.keys(DEPLOYMENTS)[0]);
  if (!DEPLOYMENTS[chainId]) fail(`Unsupported chain ${q.chain}`);
  return chainId;
}

export function addressOf(v, name = 'address') {
  if (!v || !isAddress(String(v), { strict: false })) fail(`Bad ${name}`);
  return getAddress(String(v)).toLowerCase();
}

export function limits(q, max = MAX_LIMIT, def = 50) {
  const limit = Math.min(max, Math.max(1, Number(q.limit) || def));
  const offset = Math.max(0, Number(q.offset) || 0);
  return { limit, offset };
}

export const iso = (v) => (v == null ? null : new Date(v).toISOString());
export const str = (v) => (v == null ? null : String(v));
