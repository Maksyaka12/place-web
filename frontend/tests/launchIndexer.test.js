// Place Launch indexer: launches, swaps, holders, metadata and vaults into a real Postgres (PGlite), read with
// the hub's cursor from a fake node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexEvents } from '../api/_lib/place/indexer.js';
import { l2Logs, fakeNode, freshDb, CHAIN, D, B0, B20, ERC, CREATOR, TRADER, DEAD, ETH, USDC, SUPPLY, timeOf } from './launchFixture.js';

const HEAD = B0 + 2000n + 30n; // + confirmations

async function indexed() {
  const b = l2Logs();
  const db = await freshDb();
  const node = fakeNode({ logs: b.logs, senders: b.senders, head: HEAD });
  const r = await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n });
  return { db, node, r, b };
}

const one = async (db, sql, params = []) => (await db.query(sql, params))[0];

test('a launch becomes a token row with its pool, vault, economics, metadata and opening price', async () => {
  const { db, r } = await indexed();
  assert.equal(r.caughtUp, true);
  const t = await one(db, 'select * from launch_tokens where token = $1', [B20.token]);
  assert.equal(t.kind, 'b20');
  assert.equal(t.pool_id, B20.pool);
  assert.equal(t.quote, ETH);
  assert.equal(t.token_is_currency0, false);
  assert.equal(t.vault, B20.vault);
  assert.deepEqual([t.buyback_bps, t.buyback_burn, t.rewards_bps], [2000, true, 6000]);
  assert.equal(t.original_creator, CREATOR);
  assert.equal(t.symbol, 'PL2B');
  assert.equal(t.name, 'Place L2 B20 Renamed', 'NameUpdated after the launch wins');
  // B20ExtraMetadataUpdated is emitted before Launched in the same transaction and still lands.
  assert.deepEqual(JSON.parse(t.extra), { website: 'https://place-blond.vercel.app', x: 'https://x.com/place' });
  assert.equal(t.created_at.toISOString(), new Date(Number(timeOf(B0)) * 1000).toISOString());
  assert.equal(t.dev_buy_in, '1000000000000000');
  assert.ok(t.price > 1.9e-9 && t.price < 2.0e-9, `price ${t.price}`);

  const e = await one(db, 'select * from launch_tokens where token = $1', [ERC.token]);
  assert.equal(e.kind, 'erc20');
  assert.equal(e.quote, USDC);
  assert.deepEqual(JSON.parse(e.extra), { telegram: 'https://t.me/place' });
  assert.ok(e.price > 4.0e-6 && e.price < 4.02e-6, `price ${e.price}`);
  const q = await db.query('select quote, decimals, start_tick, rewards_min::text from launch_quotes order by quote');
  assert.deepEqual(q.map((x) => [x.quote, x.decimals, x.start_tick]), [[ETH, 18, -200600], [USDC, 6, -400600]]);
  assert.equal(q[0].rewards_min, '100000000000000');
});

test('swaps get side, amounts, trader (tx sender), hook fee and time; the pool reserves follow them', async () => {
  const { db } = await indexed();
  const swaps = await db.query(
    'select side, trader, router, token_amount::text as t, quote_amount::text as q, fee::text as fee, at from launch_swaps where token = $1 order by block, log_index',
    [B20.token]
  );
  assert.deepEqual(
    swaps.map((s) => [s.side, s.trader, s.q, s.fee]),
    [
      ['buy', CREATOR, '990000000000000', '10000000000000'],
      ['buy', TRADER, '198000000000000', '2000000000000'],
      ['sell', TRADER, '98000000000000', '1000000000000'],
      ['buy', CREATOR, '55116900000000', null],
    ]
  );
  assert.equal(swaps[0].router, D.launchBuyAdapter);
  assert.equal(swaps[3].router, B20.vault, 'the vault buyback is a swap too');
  const t = await one(db, 'select quote_reserve::text as q, token_out::text as o, swaps from launch_tokens where token = $1', [B20.token]);
  assert.equal(t.q, String(990000000000000n + 198000000000000n - 98000000000000n + 55116900000000n));
  assert.equal(t.o, String(509243758909291886606726n + 101784362118681938915860n - 50892181059340969457930n + 28044287166493768656910n));
  assert.equal(t.swaps, 4);
});

test('holders add up from transfers; the pool, hook and burn address are kept apart by the API', async () => {
  const { db } = await indexed();
  const rows = await db.query('select account, balance::text as b from launch_balances where token = $1 and balance > 0 order by account', [B20.token]);
  const bal = Object.fromEntries(rows.map((r) => [r.account, BigInt(r.b)]));
  assert.equal(bal[CREATOR], 509243758909291886606726n);
  assert.equal(bal[TRADER], 101784362118681938915860n - 50892181059340969457930n);
  assert.equal(bal[DEAD], 28044287166493768656910n);
  const total = Object.values(bal).reduce((a, b) => a + b, 0n);
  assert.equal(total, SUPPLY, 'balances always sum to the supply');
  assert.equal(bal[D.hook], undefined);
});

test('vault events, announcements and the campaign link are stored', async () => {
  const { db } = await indexed();
  const ev = await db.query('select kind, amount::text as a, amount2::text as a2, account, ref from launch_vault_events where vault = $1 order by block, log_index', [B20.vault]);
  assert.deepEqual(
    ev.map((e) => e.kind),
    ['collected', 'campaign', 'bought_back', 'creator_paid']
  );
  assert.equal(ev[1].ref, '1');
  assert.equal(ev[2].a2, '28044287166493768656910');
  assert.equal(ev[2].account, DEAD);
  const a = await one(db, 'select * from launch_announcements');
  assert.equal(a.description, 'gm');
});

test('indexing the same blocks again changes nothing (idempotent totals)', async () => {
  const { db, b } = await indexed();
  const before = await db.query('select token, quote_reserve::text, token_out::text, swaps from launch_tokens order by token');
  const bal = await db.query('select * from launch_balances order by token, account');
  await db.query('delete from indexer_cursors');
  await indexEvents({ db, client: fakeNode({ logs: b.logs, senders: b.senders, head: HEAD }), chainId: CHAIN, maxRange: 2_000_000n });
  assert.deepEqual(await db.query('select token, quote_reserve::text, token_out::text, swaps from launch_tokens order by token'), before);
  assert.deepEqual(await db.query('select * from launch_balances order by token, account'), bal);
});

test('a launch split over two ranges keeps tokens found earlier (dynamic logs use the database)', async () => {
  const b = l2Logs();
  const db = await freshDb();
  // first up to just after the launches, then the rest
  await indexEvents({ db, client: fakeNode({ logs: b.logs, senders: b.senders, head: B0 + 100n + 30n }), chainId: CHAIN, maxRange: 2_000_000n });
  assert.equal((await one(db, 'select count(*)::int as n from launch_swaps')).n, 2);
  await indexEvents({ db, client: fakeNode({ logs: b.logs, senders: b.senders, head: HEAD }), chainId: CHAIN, maxRange: 2_000_000n });
  assert.equal((await one(db, 'select count(*)::int as n from launch_swaps')).n, 5);
  assert.equal((await one(db, 'select name from launch_tokens where token = $1', [B20.token])).name, 'Place L2 B20 Renamed');
});

test('the shared cursor covers the hub and the launchpad from the earliest start block', async () => {
  const { db, r } = await indexed();
  const [c] = await db.query('select contract, last_block::text as b from indexer_cursors');
  assert.ok(c.contract.includes(D.factory) && c.contract.includes('0x493f55975bff2e4f111bad8d51637f3b9763bdd1'));
  assert.equal(c.b, String(HEAD - 30n));
  assert.ok(r.from < D.startBlock, 'starts at the hub deployment, before the launchpad');
});
