// Vercel serverless function: the public Place API behind /api/place/* (rewrite in vercel.json).
// Logic lives in ./_lib/place/api.js; `npm run dev` serves the same thing through placeRequest (vite.config.js).
import { handlePlace } from './_lib/place/api.js';
import { getDb } from './_lib/place/db.js';
import { chainClient } from './_lib/place/chain.js';
import { pinText } from './_lib/place/ipfs.js';
import { toJson } from './_lib/place/cron.js';
import { refreshIndex, logsClient } from './_lib/place/indexer.js';

const clients = new Map();
const client = (chainId) => {
  if (!clients.has(chainId)) {
    // Local development without an Alchemy key reads state through the public log nodes instead.
    const local = !process.env.ALCHEMY_API_KEY && process.env.PLACE_PGLITE_DIR;
    clients.set(chainId, local ? logsClient(chainId) : chainClient({ chainId, key: process.env.ALCHEMY_API_KEY }));
  }
  return clients.get(chainId);
};
const logClients = new Map();
const logs = (chainId) => {
  if (!logClients.has(chainId)) logClients.set(chainId, logsClient(chainId));
  return logClients.get(chainId);
};

/** One API request: { method, path, query, body, ip } → { status, headers, body }. */
export async function placeRequest(req) {
  const db = await getDb();
  return handlePlace(req, {
    db,
    client,
    alchemyKey: process.env.ALCHEMY_API_KEY,
    fetchFn: fetch,
    pin: (bytes, { name, contentType }) => pinText(bytes, { name, contentType }),
    now: () => Math.floor(Date.now() / 1000),
    // Launch market endpoints catch the indexer up first; PLACE_READ_THROUGH=0 turns it off.
    refresh: process.env.PLACE_READ_THROUGH === '0' ? null : (chainId) => refreshIndex({ db, client: logs(chainId), chainId }),
  });
}

export { toJson };

export default async function handler(req, res) {
  const path = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path || '';
  const { path: _drop, ...query } = req.query;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
  let result;
  try {
    result = await placeRequest({ method: req.method, path, query, body: req.body, ip });
  } catch (e) {
    // Setup problems (e.g. DATABASE_URL not set) happen before the router's own error handling.
    result = { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: { error: e.message } };
  }
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.status(result.status).send(result.body == null ? '' : toJson(result.body));
}
