// Vercel cron (every minute, see vercel.json): Place indexer and snapshot service. Logic in ./_lib/place/cron.js.
import { handleCron, toJson } from './_lib/place/cron.js';

export default async function handler(req, res) {
  const result = await handleCron({ headers: req.headers });
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.status(result.status).send(toJson(result.body));
}
