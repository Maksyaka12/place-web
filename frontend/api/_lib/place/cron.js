// One Place cron tick per chain. Called by /api/place-cron: an external scheduler every 5 minutes (docs/CRON.md),
// the GitHub workflow as a fallback, and Vercel cron once a day. Order of a tick:
//   1. index events (launch, NFT, campaigns)
//   2. keeper: closeStreams on the first tick after 00:00 UTC, conversions, NFT collections, default campaigns
//   3. index again when the keeper sent something, so EpochClosed of the day just closed is in the database
//   4. rewards publisher: tables and roots of the closed days (in the same tick, not the next one)
//   5. hub campaigns, then snapshot jobs with whatever time is left
// Each part has its own time budget so one slow part never starves the others; whatever is left over continues on
// the next tick. One tick at a time: a lease in job_leases ('cron'), so overlapping schedulers never run two.
import { getDb } from './db.js';
import { chainClient } from './chain.js';
import { refreshIndex, syncHubState, logsClient } from './indexer.js';
import { runSnapshotJobs, acquireLease, releaseLease } from './snapshotJob.js';
import { makePublisher } from './publisher.js';
import { pinText, fetchIpfsText } from './ipfs.js';
import { json } from '../common.js';
import { runKeeper, makeKeeperWallet, keeperConfig } from '../launch/keeper.js';
import { runRewardsPublisher } from '../launch/rewardsPublisher.js';

export function placeChains() {
  return (process.env.PLACE_CHAINS || '84532').split(',').map((s) => Number(s.trim())).filter(Boolean);
}

/** The real parts of a tick; tests pass their own (same names, same arguments). */
export function tickParts({ chainId, key = process.env.ALCHEMY_API_KEY }) {
  const client = chainClient({ chainId, key });
  const publisher = () => {
    try {
      return makePublisher({ chainId, alchemyKey: key, readClient: client });
    } catch {
      return null; // no PUBLISHER_PRIVATE_KEY: tables are still built
    }
  };
  return {
    // Under the same lease as the API's read-through refresh, so the two never index the same range at once.
    index: ({ db, budgetMs }) => refreshIndex({ db, client: logsClient(chainId), chainId, maxAgeMs: 0, budgetMs }),
    keeper: ({ db, budgetMs }) => {
      const config = keeperConfig();
      const wallet = config.privateKey ? makeKeeperWallet({ chainId, alchemyKey: key, privateKey: config.privateKey, readClient: client }) : null;
      return runKeeper({ db, client, wallet, chainId, now: Math.floor(Date.now() / 1000), config, budgetMs });
    },
    rewards: ({ db, budgetMs }) => runRewardsPublisher({ db, client, chainId, publisher: publisher(), alchemyKey: key, fetchFn: fetch, ipfs: { pin: (text, name) => pinText(text, { name }) }, budgetMs }),
    hub: ({ db }) => syncHubState({ db, client, chainId }),
    snapshots: ({ db, budgetMs }) =>
      runSnapshotJobs({
        chainId,
        budgetMs,
        deps: { db, client, alchemyKey: key, fetchFn: fetch, ipfs: { pin: (text, name) => pinText(text, { name }), fetch: (uri) => fetchIpfsText(uri) }, publisher: publisher() },
      }),
  };
}

const sentSomething = (keeper) => Boolean(keeper?.done?.some((d) => d.tx));

export async function runTick({ chainId, db, budgetMs = 240_000, parts }) {
  const started = Date.now();
  const p = parts ?? tickParts({ chainId });
  const out = { chainId, steps: [] };
  const step = async (name, fn) => {
    out.steps.push(name);
    try {
      return await fn();
    } catch (e) {
      return { error: e.message };
    }
  };
  out.events = await step('index', () => p.index({ db, budgetMs: Math.min(30_000, Math.floor(budgetMs / 8)) }));
  // Place Launch keeper: daily closeStreams / convert / default campaigns (0.3.0), NFT collections (0.3.1),
  // process() and default campaigns of 0.2.0 vaults (logged in keeper_runs).
  out.keeper = await step('keeper', () => p.keeper({ db, budgetMs: 60_000 }));
  // The keeper's transactions (EpochClosed above all) into the database before the publisher looks.
  if (sentSomething(out.keeper)) out.reindex = await step('reindex', () => p.index({ db, budgetMs: 20_000 }));
  // Place Launch rewards: the daily holder / trader tables of closed days, pinned, roots via publishRoots.
  out.rewards = await step('rewards', () => p.rewards({ db, budgetMs: 30_000 }));
  out.synced = await step('hub', () => p.hub({ db }));
  const left = budgetMs - (Date.now() - started);
  out.snapshots = await step('snapshots', () => p.snapshots({ db, budgetMs: Math.max(5_000, left - 10_000) }));
  out.ms = Date.now() - started;
  return out;
}

export const CRON_LEASE = 'cron';
const TICK_MS = 240_000;

/** Every chain once, under the cron lease. Returns { skipped } while another tick is running. */
export async function runTicks({ db, chains = placeChains(), tick = runTick }) {
  const holder = Math.random().toString(36).slice(2);
  // Longer than a function may live (maxDuration 300 s), so a killed tick frees the lease by itself soon after.
  if (!(await acquireLease(db, CRON_LEASE, holder, TICK_MS + 90_000))) return { skipped: 'another tick is running' };
  try {
    const results = [];
    for (const chainId of chains) {
      try {
        results.push(await tick({ chainId, db, budgetMs: Math.floor(TICK_MS / chains.length) }));
      } catch (e) {
        results.push({ chainId, error: e.message });
      }
    }
    return { results };
  } finally {
    await releaseLease(db, CRON_LEASE, holder);
  }
}

/** Vercel's waitUntil (what @vercel/functions exports), or null outside Vercel. */
export function vercelWaitUntil() {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  return typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
}

/**
 * The HTTP side: only callers with Authorization: Bearer CRON_SECRET may run it.
 * ?async=1 (external schedulers with a short request timeout): answers 202 at once and finishes the tick in the
 * background (Vercel waitUntil, up to maxDuration). Without waitUntil it runs inside the request, like the default.
 */
export async function handleCron({ headers, query = {} }, deps = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(503, { error: 'CRON_SECRET is not set' });
  if (headers.authorization !== `Bearer ${secret}`) return json(401, { error: 'Unauthorized' });
  const db = deps.db ?? (await getDb());
  const run = () => runTicks({ db, ...(deps.tick ? { tick: deps.tick } : {}), ...(deps.chains ? { chains: deps.chains } : {}) });
  const waitUntil = deps.waitUntil === undefined ? vercelWaitUntil() : deps.waitUntil;
  if (String(query.async || '') === '1' && waitUntil) {
    waitUntil(run().catch((e) => console.error('place-cron', e)));
    return json(202, { started: true, at: new Date().toISOString() }, { 'Cache-Control': 'no-store' });
  }
  return json(200, await run(), { 'Cache-Control': 'no-store' });
}

// JSON.stringify cannot write bigint.
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
