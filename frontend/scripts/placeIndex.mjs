// Runs the Place indexer once against a real chain and DATABASE_URL (both from frontend/.env):
//   node scripts/placeIndex.mjs [--chain 84532]
// The cron endpoint does the same on a schedule.
import { readFileSync, existsSync } from 'node:fs';
import { getDb } from '../api/_lib/place/db.js';
import { chainClient } from '../api/_lib/place/chain.js';
import { indexEvents, syncHubState, logsClient } from '../api/_lib/place/indexer.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const i = process.argv.indexOf('--chain');
const chainId = Number(i > 0 ? process.argv[i + 1] : 84532);

const db = await getDb();
try {
  const t0 = Date.now();
  const r = await indexEvents({ db, client: logsClient(chainId), chainId, budgetMs: 120_000 });
  console.log(`events: blocks ${r.from}…${r.to} (head ${r.head}), ${r.events} events, caught up: ${r.caughtUp}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const checked = await syncHubState({ db, client: chainClient({ chainId, key: process.env.ALCHEMY_API_KEY }), chainId });
  console.log(`state: ${checked} open campaigns re-read from the hub`);
  const [c] = await db.query('select count(*)::int as campaigns, (select count(*)::int from nft_collections) as collections from campaigns');
  console.log(`database: ${c.campaigns} campaigns, ${c.collections} collections`);
} finally {
  await db.end();
}
