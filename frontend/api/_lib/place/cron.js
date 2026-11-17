// One Place cron tick per chain: index events, re-read open campaigns, then advance snapshot jobs.
// Called by /api/place-cron (Vercel cron, every minute). Each part has its own time budget so one slow
// part never starves the others; whatever is left over continues on the next tick.
import { getDb } from './db.js';
import { chainClient } from './chain.js';
import { refreshIndex, syncHubState, logsClient } from './indexer.js';
import { runSnapshotJobs } from './snapshotJob.js';
import { makePublisher } from './publisher.js';
import { pinText, fetchIpfsText } from './ipfs.js';
import { json } from '../common.js';
import { runKeeper, makeKeeperWallet, keeperConfig } from '../launch/keeper.js';
import { runRewardsPublisher } from '../launch/rewardsPublisher.js';

export function placeChains() {
  return (process.env.PLACE_CHAINS || '84532').split(',').map((s) => Number(s.trim())).filter(Boolean);
}

export async function runTick({ chainId, db, budgetMs = 240_000 }) {
  const started = Date.now();
  const key = process.env.ALCHEMY_API_KEY;
  const client = chainClient({ chainId, key });
  const out = { chainId };
  // Under the same lease as the API's read-through refresh, so the two never index the same range at once.
  out.events = await refreshIndex({ db, client: logsClient(chainId), chainId, maxAgeMs: 0, budgetMs: Math.min(30_000, budgetMs / 4) });
  out.synced = await syncHubState({ db, client, chainId });
  const left = budgetMs - (Date.now() - started);
  out.snapshots = await runSnapshotJobs({
    chainId,
    budgetMs: Math.max(5_000, left - 10_000),
    deps: {
      db,
      client,
      alchemyKey: key,
      fetchFn: fetch,
      ipfs: { pin: (text, name) => pinText(text, { name }), fetch: (uri) => fetchIpfsText(uri) },
      publisher: makePublisher({ chainId, alchemyKey: key, readClient: client }),
    },
  });
  // Place Launch keeper: daily closeStreams / convert / default campaigns (0.3.0), process() and default
  // campaigns of 0.2.0 vaults (logged in keeper_runs).
  try {
    const config = keeperConfig();
    const wallet = config.privateKey ? makeKeeperWallet({ chainId, alchemyKey: key, privateKey: config.privateKey, readClient: client }) : null;
    out.keeper = await runKeeper({ db, client, wallet, chainId, now: Math.floor(Date.now() / 1000), config, budgetMs: 60_000 });
  } catch (e) {
    out.keeper = { error: e.message };
  }
  // Place Launch rewards: the daily holder / trader tables of closed days, pinned, roots via publishRoots.
  try {
    let publisher = null;
    try {
      publisher = makePublisher({ chainId, alchemyKey: key, readClient: client });
    } catch {
      publisher = null; // no PUBLISHER_PRIVATE_KEY: tables are still built
    }
    out.rewards = await runRewardsPublisher({ db, client, chainId, publisher, alchemyKey: key, fetchFn: fetch, ipfs: { pin: (text, name) => pinText(text, { name }) }, budgetMs: 30_000 });
  } catch (e) {
    out.rewards = { error: e.message };
  }
  out.ms = Date.now() - started;
  return out;
}

/** The HTTP side: only Vercel cron (Authorization: Bearer CRON_SECRET) may run it. */
export async function handleCron({ headers }) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(503, { error: 'CRON_SECRET is not set' });
  if (headers.authorization !== `Bearer ${secret}`) return json(401, { error: 'Unauthorized' });
  const db = await getDb();
  const chains = placeChains();
  const results = [];
  for (const chainId of chains) {
    try {
      results.push(await runTick({ chainId, db, budgetMs: Math.floor(240_000 / chains.length) }));
    } catch (e) {
      results.push({ chainId, error: e.message });
    }
  }
  return json(200, { results }, { 'Cache-Control': 'no-store' });
}

// JSON.stringify cannot write bigint.
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
