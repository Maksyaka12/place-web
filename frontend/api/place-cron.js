// Place cron tick: indexer, keeper, rewards publisher, hub campaigns, snapshot jobs. Logic in ./_lib/place/cron.js.
// Callers: an external scheduler every 5 minutes with ?async=1 (docs/CRON.md), .github/workflows/place-cron.yml as
// a fallback, Vercel cron once a day (vercel.json). All send Authorization: Bearer CRON_SECRET.
import { handleCron, toJson } from './_lib/place/cron.js';

export default async function handler(req, res) {
  const result = await handleCron({ headers: req.headers, query: req.query || {} });
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.status(result.status).send(toJson(result.body));
}
