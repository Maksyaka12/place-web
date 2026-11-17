// Rewards hub: how streams are typed and sourced, the create form's transactions, the daily tables of tokens
// not launched on Place (Alchemy transfers + balanceOf / ownerOf at the end of the day) and the hub API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { classifyStream, streamDays, UNSUPPORTED } from '../api/_lib/launch/hub.js';
import { runRewardsPublisher } from '../api/_lib/launch/rewardsPublisher.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { planHubCreate, feeOf, utcDay, dayText, EPOCH } from '../src/launch/hubCreate.js';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI } from '../src/launch/abi.js';
import { launchDeployment } from '../src/launch/deployments.js';
import { fakeNode, freshDb, CHAIN, CREATOR, TRADER, ETH, USDC, timeOf, B0 } from './launchFixture.js';

const e18 = 10n ** 18n;
const D = launchDeployment(CHAIN);
const DIST = D.rewardsDistributor.toLowerCase();
const EXT = '0xe0000000000000000000000000000000000000e1'; // an ERC-20 from another launchpad
const NFT = '0xe0000000000000000000000000000000000000c1'; // a collection made by the Place NFT factory
const OTHER_NFT = '0xe0000000000000000000000000000000000000c2'; // a collection made elsewhere
const POOL = '0xe0000000000000000000000000000000000000a1'; // an AMM pool holding EXT
const SMALL = '0x5a11000000000000000000000000000000000005';
const id = (n) => `0x${n.toString(16).padStart(64, '0')}`;

// ─────────────────────────────── pure parts ───────────────────────────────

const ctx = (patch = {}) => ({ placeTokens: new Map(), collections: new Map(), nfts: new Set(), poolStreams: new Set(), ...patch });

test('streams are typed (holders, traders, nft) and sourced (economy, pool, creator, community), with what Place supports', () => {
  const place = new Map([[EXT, { generation: 3, current_creator: CREATOR, original_creator: CREATOR }]]);
  const c = (s, x) => classifyStream({ stream_id: id(1), token: EXT, kind: 0, economy: false, funder: TRADER, ...s }, ctx(x));
  assert.deepEqual(
    [c({ economy: true }, { placeTokens: place }).source, c({}, { placeTokens: place, poolStreams: new Set([id(1)]) }).source, c({ funder: CREATOR }, { placeTokens: place }).source, c({}, { placeTokens: place }).source],
    ['economy', 'pool', 'creator', 'community']
  );
  assert.equal(c({}).type, 'holders');
  assert.equal(c({}).supported, true, 'holders of any ERC-20');
  assert.equal(c({}).placeToken, false);
  assert.deepEqual([c({ kind: 1 }).type, c({ kind: 1 }).unsupported], ['traders', UNSUPPORTED.traders], 'traders only on Place launches');
  assert.equal(c({ kind: 1 }, { placeTokens: place }).supported, true);
  assert.equal(c({ kind: 1 }, { placeTokens: new Map([[EXT, { generation: 2 }]]) }).supported, false, 'no Trade events before 0.3.0');
  const nft = c({ token: NFT, funder: CREATOR }, { collections: new Map([[NFT, CREATOR]]) });
  assert.deepEqual([nft.type, nft.supported, nft.placeCollection, nft.source], ['nft', true, true, 'creator']);
  const other = c({ token: OTHER_NFT }, { nfts: new Set([OTHER_NFT]) });
  assert.deepEqual([other.type, other.supported, other.unsupported], ['nft', false, UNSUPPORTED.nft]);
});

test('days of a stream: upcoming, live with days started, ended; economy streams have no end', () => {
  const now = 20_774 * EPOCH + 3600;
  assert.deepEqual(
    [streamDays({ start_epoch: 20_775, epoch_count: 3 }, now), streamDays({ start_epoch: 20_773, epoch_count: 3 }, now), streamDays({ start_epoch: 20_770, epoch_count: 3 }, now)].map((d) => [d.status, d.done]),
    [['upcoming', 0], ['live', 2], ['ended', 3]]
  );
  const eco = streamDays({ start_epoch: 20_700, epoch_count: 0 }, now);
  assert.deepEqual([eco.status, eco.done, eco.endsAt], ['live', 75, null]);
});

const NOW = 20_774 * EPOCH + 3600;
const tomorrow = dayText(20_775);
const holderAsset = { address: EXT, decimals: 18, isNft: false, allowed: { staking: true, holders: true, traders: false, nft: false }, reasons: { traders: UNSUPPORTED.traders }, pool: { available: false } };
const fees = { now: NOW, streamFeeBps: 500, stakingFeeBps: 500, stakingFeeVersion: '1', distributor: DIST, staking: D.staking };

test('create form: holder rewards in ETH from a wallet → createStream with the fee on top, rounded up', () => {
  const plan = planHubCreate({ type: 'holders', token: EXT, funding: 'wallet', reward: 'eth', amount: '0.3', days: '7', startDay: tomorrow, criterion: '1000' }, { ...fees, asset: holderAsset, rewardMeta: { decimals: 18 } });
  assert.deepEqual(plan.errors, {});
  const per = (3n * 10n ** 17n) / 7n;
  assert.equal(plan.perEpoch, per);
  assert.equal(plan.total, per * 7n);
  assert.equal(plan.fee, feeOf(per * 7n, 500));
  assert.equal(plan.fee, (per * 7n * 500n + 9_999n) / 10_000n);
  assert.equal(plan.value, plan.pay, 'ETH rewards are sent as value');
  const { args } = decodeFunctionData({ abi: REWARDS_DISTRIBUTOR_ABI, data: encodeFunctionData(plan.call) });
  assert.equal(args[0].token.toLowerCase(), EXT);
  assert.equal(args[0].kind, 0);
  assert.equal(args[0].rewardToken, ETH);
  assert.equal(args[0].startEpoch, 20_775n);
  assert.equal(args[0].criterion, 1000n * e18);
  assert.equal(plan.call.to, DIST);
});

test('create form: what the contracts or Place would refuse is explained before the wallet opens', () => {
  const err = (f, c = {}) => planHubCreate({ type: 'holders', token: EXT, funding: 'wallet', reward: 'eth', amount: '1', days: '7', startDay: tomorrow, ...f }, { ...fees, asset: holderAsset, rewardMeta: { decimals: 18 }, ...c }).errors;
  assert.equal(err({ type: 'traders' }).token, UNSUPPORTED.traders);
  assert.ok(err({ days: '366' }).days);
  assert.ok(err({ startDay: dayText(20_773) }).startDay, 'the past');
  assert.ok(err({ startDay: dayText(20_774 + 91) }).startDay, 'more than 90 days ahead');
  assert.ok(err({ amount: '0' }).amount);
  assert.ok(err({ reward: '0xabc' }).reward);
  assert.ok(err({ reward: USDC }, { rewardMeta: { decimals: 18, isNft: true } }).reward, 'never an NFT as the reward');
  assert.ok(err({ type: 'nft', criterion: '0' }, { asset: { ...holderAsset, isNft: true, allowed: { nft: true } } }).criterion);
  assert.ok(err({ funding: 'pool', type: 'nft' }, { asset: { ...holderAsset, allowed: { nft: true } } }).funding, 'NFT rewards are never paid from a pool');
  assert.ok(err({ funding: 'pool' }, { asset: { ...holderAsset, pool: { available: true, isCreator: false, types: ['holders'] } } }).funding, 'only the creator spends the pool');
  assert.equal(utcDay('2026-11-18'), 20_775);
});

test('create form: a staking vault in an ERC-20 → createVault with the fee config version; the pool → a fund-quote query', () => {
  const plan = planHubCreate(
    { type: 'staking', token: EXT, funding: 'wallet', reward: USDC, amount: '100', days: '10', epochDays: '2', startDay: tomorrow, earlyExit: true, penaltyPct: '12.5' },
    { ...fees, asset: holderAsset, rewardMeta: { decimals: 6 } }
  );
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.value, 0n);
  assert.equal(plan.spender, D.staking);
  const { functionName, args } = decodeFunctionData({ abi: PLACE_STAKING_ABI, data: encodeFunctionData(plan.call) });
  assert.equal(functionName, 'createVault');
  assert.equal(args[0].stakingToken.toLowerCase(), EXT);
  assert.equal(args[0].rewardCurrency.toLowerCase(), USDC.toLowerCase());
  assert.equal(args[0].startTime, BigInt(20_775 * EPOCH));
  assert.equal(args[0].epochDuration, BigInt(2 * EPOCH));
  assert.equal(args[0].rewardPerEpoch, 10_000_000n);
  assert.deepEqual([args[0].earlyExitMode, args[0].penaltyBps], [1, 1250]);
  assert.equal(args[1], 1n);

  const asset = { ...holderAsset, allowed: { ...holderAsset.allowed, traders: true }, place: { quote: { address: USDC, decimals: 6 } }, pool: { available: true, isCreator: true, types: ['staking', 'holders', 'traders'] } };
  const pool = planHubCreate({ type: 'traders', token: EXT, funding: 'pool', reward: 'eth', amount: '2.5', days: '5', startDay: tomorrow, criterion: '0.1' }, { ...fees, asset });
  assert.deepEqual(pool.errors, {});
  assert.deepEqual(pool.fundQuery, { token: EXT, rewardToken: 'eth', amountIn: '2500000', kind: 'traders', epochCount: '5', slippageBps: '100', startEpoch: '20775', criterion: '100000' });
});

// ─────────────────────────────── tables of tokens not launched on Place ───────────────────────────────

const DAY = Math.floor(Number(timeOf(B0)) / EPOCH) + 1;
const HEAD = B0 + BigInt((DAY + 2) * EPOCH - Number(timeOf(B0))) * 5n;
const BAL = { [CREATOR]: 3000n * e18, [TRADER]: 1000n * e18, [SMALL]: 10n * e18, [POOL]: 9000n * e18 };
const OWNERS = { 1: CREATOR, 2: CREATOR, 3: TRADER, 4: '0x0000000000000000000000000000000000000000' };

function reads(contracts) {
  return contracts.map((c) => {
    const a = c.address.toLowerCase();
    const arg = String(c.args?.[0] ?? '').toLowerCase();
    switch (c.functionName) {
      case 'balanceOf':
        return a === EXT ? { status: 'success', result: BAL[arg] ?? 0n } : { status: 'failure', error: new Error('no') };
      case 'ownerOf':
        return a === NFT && OWNERS[Number(c.args[0])] && Number(c.args[0]) !== 4 ? { status: 'success', result: OWNERS[Number(c.args[0])] } : { status: 'failure', error: new Error('burned') };
      case 'token0':
      case 'token1':
        return a === POOL ? { status: 'success', result: c.functionName === 'token0' ? EXT : USDC } : { status: 'failure', error: new Error('not a pool') };
      case 'supportsInterface':
        return { status: 'success', result: a === OTHER_NFT || a === NFT };
      case 'name':
        return { status: 'success', result: a === EXT ? 'Elsewhere' : a === NFT ? 'Place Club' : 'Token' };
      case 'symbol':
        return { status: 'success', result: a === EXT ? 'ELSE' : a === NFT ? 'CLUB' : 'TKN' };
      case 'decimals':
        return a === NFT || a === OTHER_NFT ? { status: 'failure', error: new Error('none') } : { status: 'success', result: a === USDC ? 6 : 18 };
      case 'streamFeeBps':
        return { status: 'success', result: 500 };
      case 'feeConfig':
        return { status: 'success', result: [500, CREATOR, 1n] };
      default:
        return { status: 'failure', error: new Error(`unexpected ${c.functionName}`) };
    }
  });
}

/** Alchemy alchemy_getAssetTransfers: every receiver of EXT, every token id of NFT. */
async function alchemy(url, init) {
  const body = JSON.parse(init.body);
  const p = body.params[0];
  const contract = p.contractAddresses[0].toLowerCase();
  const transfers =
    contract === EXT
      ? [CREATOR, TRADER, SMALL, POOL].map((to) => ({ to, blockNum: '0x1' }))
      : contract === NFT
        ? [1, 2, 3, 4].map((n) => ({ to: OWNERS[n], tokenId: `0x${n.toString(16)}`, blockNum: '0x1' }))
        : [];
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { transfers } }) };
}

async function hubSetup() {
  const db = await freshDb();
  const node = fakeNode({ logs: [], senders: new Map(), head: HEAD, onMulticall: async (contracts) => reads(contracts) });
  const client = { ...node, readContract: async (c) => reads([c])[0].result, getCode: async () => '0x6000' };
  const at = new Date(Number(timeOf(B0)) * 1000);
  const stream = (n, token, kind, criterion) =>
    db.query(
      `insert into reward_streams (chain_id, stream_id, distributor, token, kind, economy, reward_token, funder, start_epoch, epoch_count, reward_per_epoch, criterion, last_closed_epoch, funded, created_block, created_tx, created_at)
       values ($1, $2, $3, $4, $5, false, $6, $7, $8, 3, 1000000, $9, $8, 1000000, 1, $10, $11)`,
      [CHAIN, id(n), DIST, token, kind, USDC.toLowerCase(), CREATOR, DAY, criterion.toString(), `0x${'ab'.repeat(32)}`, at]
    );
  await stream(1, EXT, 0, 100n * e18); // holders of EXT with at least 100
  await stream(2, EXT, 1, 0n); // traders of EXT: not supported
  await stream(3, NFT, 0, 1n); // holders of a Place collection
  await stream(4, OTHER_NFT, 0, 1n); // holders of another collection: not supported
  await db.query(`insert into nft_collections (chain_id, address, creator, implementation, fee_paid, created_block, created_tx, created_at) values ($1, $2, $3, $4, 0, 1, $5, $6)`, [CHAIN, NFT, CREATOR, NFT, `0x${'cd'.repeat(32)}`, at]);
  await db.query(`insert into token_meta (chain_id, address, name, symbol, decimals, is_nft) values ($1, $2, 'Other', 'OTH', null, true)`, [CHAIN, OTHER_NFT]);
  return { db, client };
}

test('tables of tokens not launched on Place: ERC-20 balances and Place-collection NFT counts at the end of the day', async () => {
  const { db, client } = await hubSetup();
  const pinned = [];
  const ipfs = { pin: async (text) => (pinned.push(JSON.parse(text)), `ipfs://bafy${pinned.length}`) };
  const run = await runRewardsPublisher({ db, client, chainId: CHAIN, ipfs, publisher: null, alchemyKey: 'test', fetchFn: alchemy });
  assert.deepEqual(run.built.map((b) => b.stream).sort(), [id(1), id(3)], JSON.stringify(run));
  assert.deepEqual(run.unsupported.map((u) => [u.stream, u.reason]).sort(), [[id(2), UNSUPPORTED.traders], [id(4), UNSUPPORTED.nft]]);

  // ERC-20: the pool (token0/token1) and the wallet below 100 are left out; 3000 : 1000 of the day's 1 000 000.
  const erc = pinned.find((t) => t.streamId === id(1));
  assert.equal(erc.source, 'erc20-balanceOf');
  assert.equal(erc.kind, 'holders');
  assert.deepEqual(erc.entries.map((e) => [e.account, e.amount]), [[CREATOR, '750000'], [TRADER, '250000']].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  // NFT: two for the creator, one for the trader, the burned id counts for nobody.
  const nft = pinned.find((t) => t.streamId === id(3));
  assert.deepEqual([nft.source, nft.kind], ['erc721-ownerOf', 'nft-holders']);
  assert.deepEqual(new Map(nft.entries.map((e) => [e.account, e.amount])), new Map([[CREATOR, '666666'], [TRADER, '333333']]));

  // Without an Alchemy key the tables wait.
  const again = await hubSetup();
  const waiting = await runRewardsPublisher({ db: again.db, client: again.client, chainId: CHAIN, ipfs, publisher: null, fetchFn: alchemy });
  assert.deepEqual(waiting.waiting.sort(), [id(1), id(3)]);
  assert.match(waiting.error, /ALCHEMY_API_KEY/);
});

test('hub API: every stream typed and sourced, one stream with its actions, what a token allows in the form', async () => {
  const { db, client } = await hubSetup();
  const deps = { db, client: () => client, now: () => Number(timeOf(HEAD)), fetchFn: async () => ({ ok: true, json: async () => ({ data: { amount: '1' } }) }) };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);

  const list = await get('launch/hub', { account: CREATOR });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const by = new Map(list.body.streams.map((s) => [s.id, s]));
  assert.deepEqual([by.get(id(1)).type, by.get(id(1)).source, by.get(id(1)).supported, by.get(id(1)).placeToken], ['holders', 'community', true, false]);
  assert.deepEqual([by.get(id(2)).type, by.get(id(2)).supported], ['traders', false]);
  assert.deepEqual([by.get(id(3)).type, by.get(id(3)).source, by.get(id(3)).placeCollection, by.get(id(3)).token.decimals], ['nft', 'creator', true, 0]);
  assert.deepEqual([by.get(id(4)).type, by.get(id(4)).supported], ['nft', false]);
  assert.equal(by.get(id(1)).pool, '3000000');
  assert.equal(by.get(id(1)).rewardToken.symbol, 'TKN');
  assert.equal(by.get(id(1)).mine.funded, true);
  assert.equal(list.body.fees.streamFeeBps, 500);
  assert.equal(list.body.fees.stakingFeeVersion, '1');

  const one = await get('launch/hub/stream', { id: id(1) });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.stream.status, 'live');
  assert.equal(one.body.actions.close.days, 1, 'yesterday is due');
  assert.equal(one.body.actions.close.tx.to, DIST);
  assert.equal(decodeFunctionData({ abi: REWARDS_DISTRIBUTOR_ABI, data: one.body.actions.close.tx.data }).functionName, 'closeStream');
  assert.equal(one.body.actions.reclaim.ready, false);
  assert.equal(one.body.actions.reclaim.at, new Date(((DAY + 3) * EPOCH + 30 * EPOCH) * 1000).toISOString());
  assert.equal((await get('launch/hub/stream', { id: id(9) })).status, 404);

  const asset = await get('launch/hub/asset', { address: NFT });
  assert.deepEqual([asset.body.isNft, asset.body.allowed.nft, asset.body.allowed.holders, asset.body.decimals], [true, true, false, 0]);
  const erc = await get('launch/hub/asset', { address: EXT });
  assert.deepEqual(erc.body.allowed, { staking: true, holders: true, traders: false, nft: false });
  assert.equal(erc.body.reasons.traders, UNSUPPORTED.traders);
  const other = await get('launch/hub/asset', { address: OTHER_NFT });
  assert.equal(other.body.allowed.nft, false);
});
