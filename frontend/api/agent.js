// Vercel serverless function: the whole agent API in one function (Hobby allows 12 per deployment).
// vercel.json rewrites /api/swap and /api/agent/{act,token,settings} here as ?route=<name>; /api/agent itself is
// the index. Logic lives in ./_lib/agent.js and ./_lib/agentWallet.js. While FEATURES.agents is off, every
// route answers 404.
import { FEATURES } from '../src/config/features.js';
import { handleAgentIndex, handleSwap } from './_lib/agent.js';
import { handleAgentAct, handleAgentToken, handleAgentSettings } from './_lib/agentWallet.js';

export const config = { maxDuration: 60 };

const ROUTES = {
  swap: handleSwap,
  act: handleAgentAct,
  token: handleAgentToken,
  settings: handleAgentSettings,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!FEATURES.agents) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(404).send(JSON.stringify({ error: 'Not available yet' }));
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  const { route, ...query } = req.query || {};
  const handle = ROUTES[route] || handleAgentIndex;
  const result = await handle({ method: req.method, query, headers: req.headers, body: req.body });
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.status(result.status).send(JSON.stringify(result.body));
}
