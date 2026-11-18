// The one campaign form (schedule preview, staking reward per epoch, reward currency options for a wallet and for
// the Community Pool) and Profile → Rewards (what shows under Staking / Holders / Traders / NFT holders).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSchedule, poolFromPerEpoch, walletRewardOptions, poolRewardOptions, planHubCreate, utcDay, EPOCH } from '../src/launch/hubCreate.js';
import { profileRewardGroups, rewardType, campaignType, withdrawable, LEGACY_SECTIONS, REWARD_FILTERS } from '../src/launch/profileRewards.js';

const TOKEN = '0xe0000000000000000000000000000000000000e1';
const USDC = '0x0000000000000000000000000000000000000c01';
const ROUTED = '0x0000000000000000000000000000000000000d01';
const id = (n) => `0x${n.toString(16).padStart(64, '0')}`;

// ─────────────────────────────── create form ───────────────────────────────

test('schedule: daily rewards run whole UTC days from 00:00; staking epochs last N days', () => {
  const daily = createSchedule({ type: 'holders', startDay: '2026-12-01', days: '30', epochDays: '7' });
  assert.equal(daily.epochs, 30);
  assert.equal(daily.epochDays, 1, 'holders ignore the epoch length');
  assert.equal(daily.startEpoch, utcDay('2026-12-01'));
  assert.equal(new Date(daily.startsAt).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(new Date(daily.endsAt).toISOString(), '2026-12-31T00:00:00.000Z');

  const stake = createSchedule({ type: 'staking', startDay: '2026-12-01', days: '4', epochDays: '7' });
  assert.deepEqual([stake.epochs, stake.epochDays, stake.totalDays], [4, 7, 28]);
  assert.equal(new Date(stake.endsAt).toISOString(), '2026-12-29T00:00:00.000Z');

  for (const bad of [{ startDay: '' }, { days: '0' }, { days: 'x' }, { days: '366' }, { type: 'staking', epochDays: '0' }]) {
    assert.equal(createSchedule({ type: 'holders', startDay: '2026-12-01', days: '30', epochDays: '7', ...bad }), null, JSON.stringify(bad));
  }
});

test('staking reward per epoch becomes the pool the form sends, and the plan splits it back exactly', () => {
  assert.equal(poolFromPerEpoch('0.25', '8', 18), '2');
  assert.equal(poolFromPerEpoch('1.5', '3', 6), '4.5');
  assert.equal(poolFromPerEpoch('', '3', 18), '');
  assert.equal(poolFromPerEpoch('1', '0', 18), '');
  assert.equal(poolFromPerEpoch('1', '3', null), '', 'unknown decimals: nothing yet');
  assert.equal(poolFromPerEpoch('0.0000001', '2', 6), '', 'more decimals than the token has');

  const now = Math.floor(Date.parse('2026-11-18T12:00:00Z') / 1000);
  const plan = planHubCreate(
    { type: 'staking', token: TOKEN, funding: 'wallet', reward: USDC, amount: poolFromPerEpoch('1.5', '3', 6), days: '3', epochDays: '7', startDay: '2026-11-20' },
    { now, asset: { allowed: { staking: true } }, rewardMeta: { decimals: 6 }, stakingFeeBps: 500, stakingFeeVersion: '1', staking: '0x00000000000000000000000000000000000000aa' }
  );
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.perEpoch, 1_500_000n);
  assert.equal(plan.total, 4_500_000n);
  assert.equal(plan.fee, 225_000n, 'Place fee 5% on top');
  assert.equal(plan.pay, 4_725_000n);
  assert.equal(plan.call.args[0].epochDuration, BigInt(7 * EPOCH));
});

test('reward currencies from a wallet: ETH and the launch pairs under Majors / Stocks, the token itself under Crypto', () => {
  const pairs = [
    { address: 'eth', symbol: 'ETH', decimals: 18, category: 'crypto' },
    { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, category: 'crypto' },
    { address: '0x0000000000000000000000000000000000000a01', symbol: 'AAPL', decimals: 18, category: 'stocks' },
    { address: '0x0000000000000000000000000000000000000b01', symbol: null, decimals: 18, category: 'crypto' },
  ];
  const asset = { symbol: 'TKN', name: 'Token', decimals: 18, isNft: false, place: { contractURI: 'ipfs://x' } };
  const list = walletRewardOptions({ pairs, token: TOKEN.toUpperCase().replace('0X', '0x'), asset });
  assert.deepEqual(
    list.map((t) => [t.symbol, t.source, t.category]),
    [
      ['ETH', 'pair', 'majors'],
      ['USDC', 'pair', 'majors'],
      ['AAPL', 'pair', 'stocks'],
      ['TKN', 'token', 'crypto'],
    ]
  );
  assert.equal(list[3].address, TOKEN, 'the token address is lowercased');
  assert.equal(list[3].placeLaunch, true);
  assert.equal(walletRewardOptions({ pairs, token: TOKEN, asset: { ...asset, isNft: true } }).length, 3, 'a collection is never a reward');
  assert.equal(walletRewardOptions({}).length, 1, 'ETH always');
});

test('reward currencies from the Community Pool: the pair, the token bought in its own pool, the listed routes', () => {
  const tokens = [
    { address: USDC, symbol: 'USDC', decimals: 6, source: 'pair', category: 'majors' },
    { address: 'self', symbol: null, decimals: 18, source: 'self', category: null },
    { address: ROUTED, symbol: 'RTE', decimals: 18, source: 'route', category: 'crypto' },
  ];
  const list = poolRewardOptions(tokens, TOKEN, { symbol: 'TKN', name: 'Token', decimals: 18 });
  assert.deepEqual(
    list.map((t) => [t.address, t.symbol, t.source]),
    [
      [USDC, 'USDC', 'pair'],
      [TOKEN, 'TKN', 'token'],
      [ROUTED, 'RTE', 'route'],
    ]
  );
  assert.equal(poolRewardOptions(tokens, null, null).length, 2, "no token yet: no 'self'");
});

// ─────────────────────────────── profile rewards ───────────────────────────────

const reward = (n, kind, claimable) => ({ streamId: id(n), kind, claimable: String(claimable), token: { symbol: 'T' }, rewardToken: { symbol: 'R', decimals: 18 } });

test('profile rewards: staking always, holders / traders / NFT holders only when there is something to claim', () => {
  const rewards = [reward(1, 'holders', 5), reward(2, 'holders', 0), reward(3, 'traders', 7), reward(4, 'holders', 9), reward(5, 'holders', 2)];
  const streams = [
    { id: id(1), type: 'holders' },
    { id: id(3), type: 'traders' },
    { id: id(4), type: 'nft' }, // a Merkle stream of a collection: kind holders, type nft
  ];
  const programs = [
    { id: 'a', status: 'ended', endsAt: '2026-11-01T00:00:00Z', position: { staked: '0', claimed: '5' } },
    { id: 'b', status: 'live', endsAt: '2026-12-20T00:00:00Z', position: { staked: '10', claimed: '0' } },
    { id: 'c', status: 'upcoming', endsAt: '2026-12-10T00:00:00Z', position: { staked: '3', claimed: '0' } },
    { id: 'd', status: 'live', endsAt: '2026-12-01T00:00:00Z', position: null }, // not mine
  ];
  const collections = [
    { collection: '0xc1', claimable: '0', ids: [] },
    { collection: '0xc2', claimable: '12', ids: [{ id: '1' }] },
    { collection: '0xc3', claimable: null, ids: [{ id: '2' }] }, // unknown amount: still offered
  ];
  const campaigns = [{ kind: 'token-holders' }, { kind: 'nft-holders' }, { kind: 'nft-holders' }];
  const g = profileRewardGroups({ rewards, streams, programs, collections, campaigns });
  assert.deepEqual(
    g.staking.map((p) => p.id),
    ['b', 'c', 'a'],
    'live first, then upcoming, then ended; a vault with nothing staked stays while the wallet has a position'
  );
  assert.deepEqual(
    g.holders.map((r) => r.streamId),
    [id(1), id(5)],
    'claimable only, the biggest first; a stream the hub does not list falls back to its kind'
  );
  assert.deepEqual(
    g.traders.map((r) => r.streamId),
    [id(3)]
  );
  assert.deepEqual(
    g.nft.streams.map((r) => r.streamId),
    [id(4)]
  );
  assert.deepEqual(
    g.nft.pools.map((c) => c.collection),
    ['0xc2', '0xc3']
  );
  assert.deepEqual(g.campaigns, { holders: 1, nft: 2 }, 'one-off snapshot campaigns by their kind');
  assert.deepEqual(g.counts, { staking: 3, holders: 3, traders: 1, nft: 5, all: 12 });
  assert.deepEqual(profileRewardGroups().counts, { staking: 0, holders: 0, traders: 0, nft: 0, all: 0 });
});

test('profile rewards: types of streams and snapshot campaigns, what can be withdrawn, old sections', () => {
  assert.equal(rewardType({ streamId: id(9), kind: 'traders' }, new Map()), 'traders');
  assert.equal(rewardType({ streamId: id(9), kind: 'holders' }, new Map([[id(9), 'nft']])), 'nft');
  assert.equal(campaignType({ kind: 'nft-holders' }), 'nft');
  assert.equal(campaignType({ kind: 'token-holders' }), 'holders');

  const now = Date.parse('2026-11-18T12:00:00Z');
  const out = withdrawable(
    [
      { lotId: 0, amount: '100', unlocked: true, unlockAt: '2026-11-10T00:00:00Z' },
      { lotId: 1, amount: '0', unlocked: true, unlockAt: '2026-11-10T00:00:00Z' },
      { lotId: 2, amount: '50', unlocked: false, unlockAt: '2026-11-25T00:00:00Z' },
      { lotId: 3, amount: '25', unlocked: false, unlockAt: '2026-11-20T00:00:00Z' },
    ],
    now
  );
  assert.deepEqual(
    out.ready.map((l) => l.lotId),
    [0]
  );
  assert.equal(out.total, 100n);
  assert.equal(out.nextUnlock.toISOString(), '2026-11-20T00:00:00.000Z');
  assert.deepEqual(withdrawable(undefined, now), { ready: [], total: 0n, nextUnlock: null });

  assert.deepEqual(LEGACY_SECTIONS, { campaigns: 'launches', nfts: 'nft-launches' });
  assert.deepEqual(
    REWARD_FILTERS.map(([v]) => v),
    ['all', 'staking', 'holders', 'traders', 'nft']
  );
});
