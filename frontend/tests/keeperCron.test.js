// The keeper's NFT collection actions (buyback, processPending, payOut, price guard warm-up, dust thresholds), the
// daily closeStreams right after 00:00 UTC, and the cron tick: order (index → keeper → index → publisher), the
// lease against overlapping ticks and the ?async=1 mode for external schedulers. PGlite and a fake node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runKeeper } from '../api/_lib/launch/keeper.js';
import { tokenThreshold, nftKeeperConfig } from '../api/_lib/launch/nftKeeper.js';
import { runTick, runTicks, handleCron } from '../api/_lib/place/cron.js';
import { launchDeployment } from '../src/launch/deployments.js';
import { freshDb, CHAIN, ETH } from './launchFixture.js';

const D = launchDeployment(CHAIN);
const N = D.nft;
const e15 = 10n ** 15n;
const e18 = 10n ** 18n;
const COLL = `0x${'c0'.repeat(20)}`;
const PAIR = `0x${'a1'.repeat(20)}`;
const REWARD = `0x${'a2'.repeat(20)}`;
const WETH = '0x4200000000000000000000000000000000000006';
const POOL = { currency0: ETH, currency1: PAIR, fee: 0, tickSpacing: 60, hooks: D.hook };
const DAY = 86_400;
const NOW = 1_800_000_000 - (1_800_000_000 % DAY) + 3_600; // 01:00 UTC
const revert = (errorName, args = []) => Object.assign(new Error(errorName), { walk: () => ({ data: { errorName, args } }) });
const CONFIG = { intervalS: DAY, maxGas: 800_000n, maxCalls: 20, nft: { intervalS: 21_600, minEth: 5n * 10n ** 14n, minTokens: '1' } };

async function withCollection() {
  const db = await freshDb();
  await db.query(
    `insert into nft_launch_collections (chain_id, address, factory, creator, owner, token, reward_token, official, kind, idx, creator_bps, holders_bps, burn_bps, created_block, created_tx, created_at)
     values ($1, $2, $3, $4, $4, $5, $6, false, 'unique', 0, 5000, 3000, 2000, 1, '0x01', now())`,
    [CHAIN, COLL, N.factory, `0x${'99'.repeat(20)}`, PAIR, REWARD]
  );
  return db;
}

/** A collection on a fake node; `st` is its state, the wallet applies the calls' effects to it. */
function nftChain(st) {
  const sent = [];
  const guardCalls = [];
  const client = {
    async readContract({ address, functionName, args }) {
      switch (functionName) {
        case 'weth':
          return WETH;
        case 'decimals':
          return 18;
        case 'ethRoute':
          return [{ ...POOL, hop: 'eth->pair' }];
        case 'rewardRoute':
          return [{ ...POOL, hop: `${args[2]}->${args[3]}` }];
        case 'quote':
          assert.equal(address, N.priceGuard);
          guardCalls.push(args[0][0].hop);
          return (st.guard?.(args[0][0].hop) ?? true) && [1n, 1n];
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    async multicall({ contracts }) {
      return contracts.map((c) => {
        const a = c.args?.[0];
        if (c.functionName === 'balanceOf') return c.address === WETH ? (st.weth ?? 0n) : (st.balance?.[c.address] ?? 0n);
        assert.equal(c.address, COLL);
        switch (c.functionName) {
          case 'buybackPending':
            return st.buyback ?? 0n;
          case 'launchPool':
            return POOL;
          case 'pendingHolders':
            return st.pending?.[a] ?? 0n;
          case 'reserved':
            return st.reserved?.[a] ?? 0n;
          case 'creatorOwed':
            return st.owed?.[a] ?? 0n;
          case 'platformOwed':
            return 0n;
          default:
            throw new Error(`unexpected multicall ${c.functionName}`);
        }
      });
    },
    async getBalance() {
      return st.eth ?? 0n;
    },
  };
  const wallet = {
    address: '0x000000000000000000000000000000000000beef',
    estimate: async (call) => (st.estimate ? st.estimate(call) : 150_000n),
    send: async (call, gas) => {
      sent.push([call.address, call.functionName, call.args]);
      st.effect?.(call);
      return { hash: `0x${'ab'.repeat(32)}`, status: 'success', gasUsed: gas };
    },
  };
  return { client, wallet, sent, guardCalls };
}

const nftCalls = (sent) => sent.filter((s) => s[0] === COLL || s[0] === N.priceGuard).map((s) => [s[1], ...s[2].map((x) => (Array.isArray(x) ? x.map((h) => h.hop) : x))]);

test('nft keeper: buyback, royalties and waiting swaps, then payouts read again; once per interval', async () => {
  const db = await withCollection();
  const st = {
    buyback: 2n * e15,
    eth: 5n * e15, // 3e15 owed (buyback 2e15 + 1e15 reserved) and 2e15 of royalties
    reserved: { [ETH]: 3n * e15, [PAIR]: 0n },
    pending: { [PAIR]: 4n * e18 },
    owed: { [ETH]: 0n },
    effect: (call) => {
      if (call.functionName === 'buyback') st.buyback = 0n;
      if (call.functionName === 'processPending') {
        st.eth = 2n * e15;
        st.reserved[ETH] = 2n * e15;
        st.pending[PAIR] = 0n;
        st.owed[ETH] = 7n * 10n ** 14n;
        st.owed[PAIR] = 10n ** 17n; // dust: below 1 token
      }
    },
  };
  const { client, wallet, sent, guardCalls } = nftChain(st);
  const out = await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW, config: CONFIG });
  assert.deepEqual(out.nft, { collections: 1, checked: 1 });
  assert.deepEqual(nftCalls(sent), [
    ['buyback', 2n * e15],
    ['processPending', ETH],
    ['payOut', ETH],
  ]);
  assert.deepEqual(guardCalls, ['eth->pair', `${PAIR}->${REWARD}`], 'both swaps priced by the guard first');
  const rows = await db.query(`select action, status, token, detail from keeper_runs where vault = $1 order by id`, [COLL]);
  assert.deepEqual(rows.map((r) => [r.action, r.status]), [['nft_buyback', 'success'], ['nft_process', 'success'], ['nft_payout', 'success']]);
  assert.equal(rows[0].token, PAIR);
  assert.match(rows[1].detail, /royalties 2000000000000000 wei/);
  assert.match(rows[1].detail, /holders share 4000000000000000000/);

  // An hour later: not due yet (6 h interval), nothing read or sent.
  const n = sent.length;
  st.buyback = 5n * e15;
  await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW + 3_600, config: CONFIG });
  assert.equal(sent.length, n);
  // After the interval it is looked at again.
  await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW + 21_600, config: CONFIG });
  assert.deepEqual(nftCalls(sent.slice(n))[0], ['buyback', 5n * e15]);
});

test('nft keeper: WETH royalties go through processPending(WETH); a buyback too big at once is cut to a quarter', async () => {
  const db = await withCollection();
  const st = {
    buyback: 8n * e15,
    eth: 8n * e15,
    reserved: { [ETH]: 8n * e15 },
    weth: e15,
    estimate: (call) => {
      if (call.functionName === 'buyback' && call.args[0] === 8n * e15) throw revert('PriceImpactTooHigh', [500n, 300n]);
      return 150_000n;
    },
  };
  const { client, wallet, sent } = nftChain(st);
  await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW, config: CONFIG });
  assert.deepEqual(nftCalls(sent), [
    ['buyback', 2n * e15],
    ['processPending', WETH],
  ]);
  const [dry] = await db.query(`select status, detail from keeper_runs where vault = $1 and action = 'nft_buyback' order by id limit 1`, [COLL]);
  assert.equal(dry.status, 'reverted-dry-run');
  assert.match(dry.detail, /PriceImpactTooHigh/);
});

test('nft keeper: waits for the price guard, starts the warm-up of a route nobody observed, skips dust', async () => {
  // Guard warming up on the buyback route; the holders route (pair -> third-party reward token) never observed.
  const db = await withCollection();
  const st = {
    buyback: 2n * e15,
    pending: { [PAIR]: 3n * e18 },
    guard: (hop) => {
      if (hop === 'eth->pair') throw revert('PriceNotReady', [`0x${'11'.repeat(32)}`, BigInt(NOW + 600)]);
      throw revert('PriceNotReady', [`0x${'22'.repeat(32)}`, 0n]);
    },
  };
  const { client, wallet, sent } = nftChain(st);
  await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW, config: CONFIG });
  assert.deepEqual(nftCalls(sent), [['observeRoute', [`${PAIR}->${REWARD}`]]], 'no buyback or processPending while the guard cannot price them');
  const rows = await db.query(`select action, status, detail from keeper_runs where vault = $1 order by id`, [COLL]);
  assert.equal(rows[0].action, 'nft_buyback');
  assert.equal(rows[0].status, 'nothing');
  assert.match(rows[0].detail, /price guard ready at/);
  assert.deepEqual([rows[1].action, rows[1].status], ['nft_observe', 'success']);

  // Dust everywhere: one 'nothing' row, no transaction.
  const db2 = await withCollection();
  const dust = { buyback: 10n ** 14n, eth: 3n * 10n ** 14n, reserved: { [ETH]: 10n ** 14n }, pending: { [PAIR]: e18 / 2n }, owed: { [ETH]: 10n ** 14n, [PAIR]: e18 / 10n } };
  const c2 = nftChain(dust);
  await runKeeper({ db: db2, client: c2.client, wallet: c2.wallet, chainId: CHAIN, now: NOW, config: CONFIG });
  assert.equal(c2.sent.length, 0);
  const [only] = await db2.query(`select action, status, detail from keeper_runs where vault = $1`, [COLL]);
  assert.deepEqual([only.action, only.status, only.detail], ['nft_process', 'nothing', 'nothing waiting above the thresholds']);
});

test('nft keeper thresholds come from env', () => {
  const c = nftKeeperConfig({ PLACE_KEEPER_NFT_MIN_ETH: '0.002', PLACE_KEEPER_NFT_MIN_TOKENS: '2.5', PLACE_KEEPER_NFT_INTERVAL_S: '3600' });
  assert.equal(c.minEth, 2n * e15);
  assert.equal(c.intervalS, 3600);
  assert.equal(tokenThreshold(c.minTokens, 18), 25n * 10n ** 17n);
  assert.equal(tokenThreshold('1', 6), 1_000_000n);
  assert.equal(nftKeeperConfig({}).minEth, 5n * 10n ** 14n);
});

test('keeper: closeStreams on the first tick after 00:00 UTC, once per day, also after a late close the day before', async () => {
  const db = await freshDb();
  const E = Math.floor(NOW / DAY);
  const STREAM = `0x${'5e'.repeat(32)}`;
  await db.query(
    `insert into reward_streams (chain_id, stream_id, distributor, token, kind, economy, reward_token, start_epoch, epoch_count, last_closed_epoch, created_block, created_tx, created_at)
     values ($1, $2, $3, $4, 0, false, $5, $6, 30, $7, 1, '0x01', now())`,
    [CHAIN, STREAM, D.rewardsDistributor, COLL, REWARD, E - 5, E - 3]
  );
  const sent = [];
  const wallet = {
    address: '0x000000000000000000000000000000000000beef',
    estimate: async () => 100_000n,
    send: async (call) => (sent.push(call.functionName), { hash: `0x${'cd'.repeat(32)}`, status: 'success', gasUsed: 90_000n }),
  };
  const run = (now) => runKeeper({ db, client: {}, wallet, chainId: CHAIN, now, config: CONFIG });
  const close = async (now, lastClosed) => {
    const before = sent.length;
    await run(now);
    if (lastClosed != null) await db.query('update reward_streams set last_closed_epoch = $1', [lastClosed]); // the indexer saw EpochClosed
    return sent.slice(before).filter((f) => f === 'closeStreams').length;
  };
  // Day E, 04:00 (a late close, e.g. the daily Vercel cron).
  assert.equal(await close(E * DAY + 4 * 3_600, E - 1), 1);
  assert.equal(await close(E * DAY + 4 * 3_600 + 300), 0, 'same day: done');
  // Day E+1 at 00:05 — 20 hours after the last close, still the first tick of a new day.
  assert.equal(await close((E + 1) * DAY + 300, E), 1);
  assert.equal(await close((E + 1) * DAY + 600), 0);
});

// ─────────────────────────────── cron tick ───────────────────────────────

function fakeParts(log, { keeperSent }) {
  const part = (name, value = {}) => async () => (log.push(name), value);
  return {
    index: part('index', { events: 1 }),
    keeper: part('keeper', { done: keeperSent ? [{ action: 'close_streams', status: 'success', tx: '0x01' }] : [{ action: 'close_streams', status: 'nothing' }] }),
    rewards: part('rewards'),
    hub: part('hub'),
    snapshots: part('snapshots'),
  };
}

test('cron tick: index → keeper → index again → publisher → hub → snapshots; no second index when nothing was sent', async () => {
  const log = [];
  const out = await runTick({ chainId: CHAIN, db: null, parts: fakeParts(log, { keeperSent: true }) });
  assert.deepEqual(log, ['index', 'keeper', 'index', 'rewards', 'hub', 'snapshots']);
  assert.deepEqual(out.steps, ['index', 'keeper', 'reindex', 'rewards', 'hub', 'snapshots']);
  const quiet = [];
  await runTick({ chainId: CHAIN, db: null, parts: fakeParts(quiet, { keeperSent: false }) });
  assert.deepEqual(quiet, ['index', 'keeper', 'rewards', 'hub', 'snapshots']);
  // A failing part does not stop the rest.
  const parts = { ...fakeParts([], { keeperSent: false }), keeper: async () => Promise.reject(new Error('rpc down')) };
  const failed = await runTick({ chainId: CHAIN, db: null, parts });
  assert.deepEqual(failed.keeper, { error: 'rpc down' });
  assert.ok(failed.steps.includes('snapshots'));
});

test('cron: one tick at a time (lease), ?async=1 answers 202 and finishes in waitUntil, the secret is required', async () => {
  const db = await freshDb();
  let release;
  const gate = new Promise((r) => (release = r));
  const ticks = [];
  const slowTick = async ({ chainId }) => (ticks.push(chainId), await gate, { chainId });
  const first = runTicks({ db, chains: [CHAIN], tick: slowTick });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await runTicks({ db, chains: [CHAIN], tick: slowTick }), { skipped: 'another tick is running' });
  release();
  assert.deepEqual(await first, { results: [{ chainId: CHAIN }] });
  assert.deepEqual((await runTicks({ db, chains: [CHAIN], tick: async ({ chainId }) => ({ chainId, again: true }) })).results, [{ chainId: CHAIN, again: true }], 'the lease is released');
  assert.equal(ticks.length, 1);

  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const auth = { authorization: 'Bearer test-secret' };
    const tick = async ({ chainId }) => ({ chainId, ok: true });
    assert.equal((await handleCron({ headers: {} }, { db, tick, chains: [CHAIN] })).status, 401);
    assert.equal((await handleCron({ headers: { authorization: 'Bearer nope' } }, { db, tick, chains: [CHAIN] })).status, 401);
    let background = null;
    const r = await handleCron({ headers: auth, query: { async: '1' } }, { db, tick, chains: [CHAIN], waitUntil: (p) => (background = p) });
    assert.equal(r.status, 202);
    assert.equal(r.body.started, true);
    await background;
    // Without waitUntil (local) or without ?async=1 the tick runs inside the request.
    const sync = await handleCron({ headers: auth, query: { async: '1' } }, { db, tick, chains: [CHAIN], waitUntil: null });
    assert.equal(sync.status, 200);
    assert.deepEqual(sync.body.results, [{ chainId: CHAIN, ok: true }]);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
});
