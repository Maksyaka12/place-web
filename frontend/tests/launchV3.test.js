// Place Launch 0.3.0 (V4): the fee math, launch/predict before and after the deploy, reward tokens, the indexer
// on the new events (economy, tax credits, trades, burn, reward streams), the daily rewards publisher with its
// cumulative Merkle roots, launch/rewards with claimMany, the token page, the creator panel and the keeper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, encodeAbiParameters, concat } from 'viem';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { indexEvents } from '../api/_lib/place/indexer.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { economyStreamId, releaseGeneration, launchStaticAddresses } from '../api/_lib/launch/indexer.js';
import { runRewardsPublisher, buildTable, proRata } from '../api/_lib/launch/rewardsPublisher.js';
import { runKeeper } from '../api/_lib/launch/keeper.js';
import { previewTax, ratesPercent, resolveLaunchTax, PERCENTAGE_SCALE, EconomicsError } from '../api/_lib/launch/taxMath.js';
import { LAUNCH_FACTORY_ABI, REWARDS_DISTRIBUTOR_ABI, COMMUNITY_VAULT_ABI, FEE_ESCROW_ABI } from '../src/launch/abi.js';
import { predictLaunch } from '../src/launch/vanity.js';
import { launchStartBlock, currentDeployed, launchDeployment } from '../src/launch/deployments.js';
import { rewardRegistry } from '../api/_lib/launch/rewards.js';
import { logBuilder, fakeNode, freshDb, deploy030, undeploy030, V3, CUR, CHAIN, CREATOR, TRADER, DEAD, ETH, USDC, timeOf, B0, T0 } from './launchFixture.js';

const e18 = 10n ** 18n;
const SUPPLY = 10n ** 27n;
const TOKEN = '0xb2000000000000000000000000000000a11c0e01';
const POOL = `0x${'3c'.repeat(32)}`;
const VAULT = `0x${'c1'.repeat(20)}`;
const COMMUNITY = `0x${'c2'.repeat(20)}`;
const HOLDERS = economyStreamId(TOKEN, 0);
const TRADERS = economyStreamId(TOKEN, 1);
const SMALL = '0x5a11000000000000000000000000000000000005'; // a trader below the daily minimum
const L = 59_000_100n; // launch block
const epochOf = (block) => Math.floor(Number(timeOf(block)) / 86400);
const E0 = epochOf(L);
const DAY_END = B0 + (BigInt((E0 + 1) * 86400) - T0) * 5n; // first block of the next day
const share = (bps) => BigInt(bps) * 10_000n;

const POLICY = {
  taxFeeBounds: { minimumBuyTaxRate: 1_000_000, maximumBuyTaxRate: 5_000_000, minimumSellTaxRate: 1_000_000, maximumSellTaxRate: 5_000_000 },
  protocolFeeConfiguration: { protocolTaxShare: 30_000_000, minimumProtocolFeeRate: 300_000, maximumProtocolFeeRate: 1_500_000, protocolFeeRecipient: '0x000000000000000000000000000000000000fee5' },
  antiSnipeConfiguration: { startTotalFeeRate: 99_000_000, windowSeconds: 20 },
};
const TAX = { buyTaxRate: 3_000_000, sellTaxRate: 5_000_000, creatorAllocationShare: 30_000_000, holderAllocationShare: 30_000_000, traderAllocationShare: 20_000_000, burnAllocationShare: 10_000_000, communityAllocationShare: 10_000_000 };

// ─────────────────────────────── fee math ───────────────────────────────

test('fee math: platform 30% of the tax (0.3%–1.5% of the trade), five baskets of the rest, like PlaceFeeMath', () => {
  const economy = { launchType: 1, buyTaxRate: 3_000_000n, sellTaxRate: 5_000_000n, allocation: { creator: share(3000), holders: share(3000), traders: share(2000), burn: share(1000), community: share(1000) }, minHolding: 10_000n * e18, minTraderDailyVolume: 10n ** 15n, rewardToken: USDC };
  const p = previewTax(economy);
  assert.deepEqual(ratesPercent(p.buyRates), { protocol: 0.9, creator: 0.63, holders: 0.63, traders: 0.42, burn: 0.21, community: 0.21, total: 3 });
  assert.deepEqual(ratesPercent(p.sellRates), { protocol: 1.5, creator: 1.05, holders: 1.05, traders: 0.7, burn: 0.35, community: 0.35, total: 5 });
  // Every basket plus the platform is exactly the tax (the contract's own invariant).
  for (const r of [p.buyRates, p.sellRates]) assert.equal(r.quoteRate + r.burnRate, (r === p.buyRates ? 3_000_000n : 5_000_000n) * PERCENTAGE_SCALE * PERCENTAGE_SCALE);
  // Standard: 1% both ways, 0.3% platform, 0.7% creator.
  const std = previewTax({ launchType: 0, buyTaxRate: 0n, sellTaxRate: 0n, allocation: { creator: 0n, holders: 0n, traders: 0n, burn: 0n, community: 0n }, minHolding: 0n, minTraderDailyVolume: 0n, rewardToken: ETH });
  assert.deepEqual(ratesPercent(std.buyRates), { protocol: 0.3, creator: 0.7, holders: 0, traders: 0, burn: 0, community: 0, total: 1 });
  // What the factory rejects, rejected here too.
  const bad = (patch) => assert.throws(() => resolveLaunchTax({ ...economy, ...patch }), EconomicsError);
  bad({ buyTaxRate: 6_000_000n });
  bad({ sellTaxRate: 500_000n });
  bad({ allocation: { ...economy.allocation, burn: share(2000) } });
  bad({ minHolding: 9_999n * e18 });
  bad({ allocation: { creator: share(10_000), holders: 0n, traders: 0n, burn: 0n, community: 0n } }); // minHolding / volume without baskets
  assert.throws(() => resolveLaunchTax({ ...economy, launchType: 0 }), EconomicsError);
  assert.throws(() => resolveLaunchTax(economy, { distributor: false }), /not available/);
});

// ─────────────────────────────── predict and reward tokens ───────────────────────────────

async function apiOnly({ onMulticall } = {}) {
  const db = await freshDb();
  const node = fakeNode({ logs: [], senders: new Map(), head: 1n, onMulticall });
  const deps = { db, client: () => ({ ...node, simulateContract: async () => ({ result: 0n }) }), now: () => 1_800_000_000, fetchFn: async () => ({ ok: true, json: async () => ({ data: { amount: '1' } }) }) };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
  return { db, get };
}

const ECONOMY_Q = { type: 'economy', buyTaxBps: '300', sellTaxBps: '500', creatorBps: '3000', holdersBps: '3000', tradersBps: '2000', burnBps: '1000', communityBps: '1000', minHolding: '25000', minTraderVolume: '0.001', antiSnipe: '1' };

test('predict before the 0.3.0 deploy: economics in contract format and the local preview, no salt or tx', async (t) => {
  t.after(undeploy030());
  assert.equal(currentDeployed(CHAIN), false);
  const { db, get } = await apiOnly();
  await db.query(`insert into launch_quotes (chain_id, quote, decimals, start_tick, registered, revision, updated_block) values ($1, $2, 18, -200600, true, 1, 1), ($1, $3, 6, -400600, true, 1, 1)`, [CHAIN, ETH, USDC]);
  await db.query(`insert into launch_reward_routes (chain_id, registry, from_token, to_token, hops, active, updated_block) values ($1, $2, $3, $4, '[]', true, 1)`, [CHAIN, rewardRegistry(CHAIN), ETH, USDC]);
  const r = await get('launch/predict', { creator: CREATOR, kind: 'b20', quote: 'eth', name: 'Eco', symbol: 'ECO', ...ECONOMY_Q, rewardToken: USDC });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.deployed, false);
  assert.equal(b.previewSource, 'local');
  assert.equal(b.token, null);
  assert.equal(b.tx, null);
  assert.equal(b.launchType, 'economy');
  assert.deepEqual(b.preview.buy, { protocol: 0.9, creator: 0.63, holders: 0.63, traders: 0.42, burn: 0.21, community: 0.21, total: 3 });
  assert.deepEqual(b.preview.sell, { protocol: 1.5, creator: 1.05, holders: 1.05, traders: 0.7, burn: 0.35, community: 0.35, total: 5 });
  const e = b.launchParams.economics;
  assert.deepEqual(e, {
    launchType: 1,
    buyTaxRate: '3000000',
    sellTaxRate: '5000000',
    allocation: { creator: '30000000', holders: '30000000', traders: '20000000', burn: '10000000', community: '10000000' },
    minHolding: String(25_000n * e18),
    minTraderDailyVolume: String(10n ** 15n),
    rewardToken: USDC,
    xShares: [],
  });
  assert.equal(b.launchParams.antiSnipeEnabled, true);
  assert.equal(b.rewardToken, USDC);
  // Standard ignores taxes and baskets; anti-snipe can be switched off.
  const std = await get('launch/predict', { creator: CREATOR, name: 'Std', symbol: 'STD', type: 'standard', buyTaxBps: '500', holdersBps: '9999', antiSnipe: '0' });
  assert.equal(std.status, 200, JSON.stringify(std.body));
  assert.deepEqual(std.body.preview.buy, { protocol: 0.3, creator: 0.7, holders: 0, traders: 0, burn: 0, community: 0, total: 1 });
  assert.equal(std.body.launchParams.economics.launchType, 0);
  assert.equal(std.body.launchParams.antiSnipeEnabled, false);
  // self: the token itself, filled in once the address is mined (null before the deploy).
  const self = await get('launch/predict', { creator: CREATOR, name: 'Self', symbol: 'SLF', ...ECONOMY_Q, rewardToken: 'self' });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.equal(self.body.rewardToken, 'self');
  assert.equal(self.body.launchParams.economics.rewardToken, null);
  // Errors the form shows.
  const err = async (q) => (await get('launch/predict', { creator: CREATOR, name: 'x', symbol: 'X', ...ECONOMY_Q, ...q })).body.error;
  assert.match(await err({ buyTaxBps: '600' }), /buyTaxBps/);
  assert.match(await err({ burnBps: '2000' }), /add up to 10000/);
  assert.match(await err({ minHolding: '100' }), /10,000 tokens/);
  assert.match(await err({ rewardToken: '0x1111111111111111111111111111111111111111' }), /not available/);
  assert.match(await err({ minTraderVolume: '0.0000000000000000001' }), /decimals/);
  assert.match(await err({ type: 'tax' }), /standard or economy/);

  const opts = await get('launch/reward-tokens', { quote: 'eth' });
  assert.equal(opts.status, 200);
  assert.deepEqual(opts.body.tokens.map((t) => [t.address, t.source]), [['eth', 'pair'], ['self', 'self'], [USDC, 'route']]);
  assert.equal(opts.body.tokens[2].symbol, 'USDC');
  assert.equal(opts.body.tokens[2].decimals, 6);
  // Picker tabs and icons: ETH and USDC are majors with an icon; 'self' sits outside the tabs.
  assert.deepEqual(opts.body.tokens.map((t) => t.category), ['majors', null, 'majors']);
  assert.match(opts.body.tokens[0].logo, /^https:\/\//);
  assert.match(opts.body.tokens[2].logo, /^https:\/\//);
  assert.equal(opts.body.tokens[2].placeLaunch, false);
  assert.equal(opts.body.tokens[1].placeLaunch, true);
});

test('reward token category: majors, tokenized stocks and other crypto', async () => {
  const { rewardTokenCategory } = await import('../api/_lib/launch/rewards.js');
  assert.equal(rewardTokenCategory('ETH'), 'majors');
  assert.equal(rewardTokenCategory('cbBTC'), 'majors');
  assert.equal(rewardTokenCategory('AAPLc'), 'stocks');
  assert.equal(rewardTokenCategory('XYZQc', { quote: true }), 'stocks');
  assert.equal(rewardTokenCategory('XYZQc'), 'crypto');
  assert.equal(rewardTokenCategory('DEGEN'), 'crypto');
  assert.equal(rewardTokenCategory(null), 'crypto');
});

test('predict after the deploy: mined salt, factory preview and address checks, createLaunch with 0.3.0 economics', async () => {
  const restore = deploy030();
  try {
    const seen = [];
    const { db, get } = await apiOnly({
      onMulticall: async (contracts) =>
        contracts.map((c) => {
          seen.push(c);
          switch (c.functionName) {
            case 'configVersion':
              return 4n;
            case 'nativeLaunchFee':
              return 500000000000000n;
            case 'launchCreationEnabled':
              return true;
            case 'launchSupply':
              return SUPPLY;
            case 'economySettings':
              return { xRegistry: V3.xRecipientRegistry, staking: V3.staking, rewardRegistry: V3.rewardTokenRegistry, rewardsDistributor: V3.rewardsDistributor, defaultCampaignDelay: 2592000n, defaultCampaignEpochs: 30n };
            case 'quoteConfig':
              return [true, 18, -200600];
            case 'quoteLimits':
              return 5n * 10n ** 16n;
            case 'isLaunchSaltUsed':
              return false;
            case 'predictLaunchToken': {
              const [params, creator] = c.args;
              return predictLaunch({ kind: 'b20', creator, creatorSalt: params.creatorSalt, factory: V3.factory, tokenDeployer: V3.tokenDeployer, vaultImplementation: V3.creatorVaultImplementation }).token;
            }
            case 'previewTaxConfiguration': {
              const p = previewTax(c.args[0]);
              return { configVersion: 4n, buyRates: p.buyRates, sellRates: p.sellRates };
            }
            default:
              return { status: 'success', result: c.functionName === 'symbol' ? 'USDC' : 6 };
          }
        }),
    });
    await db.query(`insert into launch_reward_routes (chain_id, registry, from_token, to_token, hops, active, updated_block) values ($1, $2, $3, $4, '[]', true, 1)`, [CHAIN, V3.rewardTokenRegistry, ETH, USDC]);
    const r = await get('launch/predict', { creator: CREATOR, kind: 'b20', quote: 'eth', name: 'Eco', symbol: 'ECO', suffix: 'b', ...ECONOMY_Q, rewardToken: 'self', xShares: '44196397:1500' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.deployed, true);
    assert.equal(b.previewSource, 'factory');
    assert.ok(b.token.toLowerCase().endsWith('b01'));
    assert.equal(b.quote.defaultCampaignMinimum, String(5n * 10n ** 16n));
    assert.deepEqual(b.preview.buy, { protocol: 0.9, creator: 0.63, holders: 0.63, traders: 0.42, burn: 0.21, community: 0.21, total: 3 });
    const call = decodeFunctionData({ abi: LAUNCH_FACTORY_ABI, data: b.tx.data });
    assert.equal(call.functionName, 'createLaunch');
    const p = call.args[0];
    assert.equal(p.expectedConfigVersion, 4n);
    assert.equal(p.antiSnipeEnabled, true);
    assert.equal(p.economics.launchType, 1);
    assert.equal(p.economics.allocation.holders, 30_000_000);
    assert.equal(p.economics.rewardToken.toLowerCase(), b.token.toLowerCase(), 'self = the mined token address');
    assert.deepEqual(p.economics.xShares.map((x) => [x.xId, x.bps]), [[44196397n, 1500]]);
    assert.equal(b.tx.to, V3.factory);
    // The factory got the exact economics of the call for its preview.
    const prev = seen.find((c) => c.functionName === 'previewTaxConfiguration');
    assert.equal(prev.args[0].rewardToken.toLowerCase(), b.token.toLowerCase());
  } finally {
    restore();
  }
});

// ─────────────────────────────── a full Economy day ───────────────────────────────

const credit = (b, name, args) => b.log(V3.hook, name, { poolId: POOL, ...args });

/** One Economy launch (B20/ETH, rewards in USDC), a day of trading and the next day's close, as logs. */
function economyLogs() {
  const b = logBuilder();
  const F = V3.factory;
  const PM = CUR.poolManager;
  b.tx(L - 10n, CREATOR);
  b.log(F, 'QuoteRegistered', { quoteToken: ETH, quoteDecimals: 18, startTickToken0Frame: -200600, revision: 1n });
  b.log(F, 'QuoteRegistered', { quoteToken: USDC, quoteDecimals: 6, startTickToken0Frame: -400600, revision: 1n });
  b.log(F, 'QuoteLimitsUpdated', { quoteToken: ETH, defaultCampaignMinimum: 5n * 10n ** 16n });
  b.log(V3.rewardTokenRegistry, 'RouteSet', { from: ETH, to: USDC, hops: [{ currency0: ETH, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ETH }] });

  b.tx(L, CREATOR);
  b.log(F, 'CreatorVaultCreated', { token: TOKEN, vault: VAULT });
  b.log(F, 'CommunityVaultCreated', { token: TOKEN, vault: COMMUNITY });
  b.log(PM, 'Initialize', { id: POOL, currency0: ETH, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: V3.hook, sqrtPriceX96: 1797361575845028639913410322392517n, tick: 200600 });
  b.log(TOKEN, 'Transfer', { from: ETH, to: PM, value: SUPPLY });
  b.log(V3.rewardsDistributor, 'LaunchStreamRegistered', { streamId: HOLDERS, token: TOKEN, kind: 0, quote: ETH, rewardToken: USDC, criterion: 25_000n * e18, startEpoch: BigInt(E0) });
  b.log(V3.rewardsDistributor, 'LaunchStreamRegistered', { streamId: TRADERS, token: TOKEN, kind: 1, quote: ETH, rewardToken: USDC, criterion: 10n ** 15n, startEpoch: BigInt(E0) });
  b.log(F, 'LaunchTaxConfigured', { poolId: POOL, token: TOKEN, configVersion: 4n, admittedPolicy: POLICY, taxConfiguration: TAX, antiSnipeEnabled: true });
  b.log(F, 'LaunchEconomyConfigured', { token: TOKEN, launchType: 1, creatorVault: VAULT, communityVault: COMMUNITY, rewardToken: USDC, minHolding: 25_000n * e18, minTraderDailyVolume: 10n ** 15n });
  b.log(F, 'Launched', { token: TOKEN, poolId: POOL, originalCreator: CREATOR, quoteToken: ETH, launchSupply: SUPPLY, tickSpacing: 200 });
  // dev buy: 100 000 tokens to the creator
  b.log(PM, 'Swap', { id: POOL, sender: V3.launchBuyAdapter, amount0: -(10n ** 15n), amount1: 100_000n * e18, sqrtPriceX96: 1796446280680026189204988623606028n, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(V3.hook, 'Trade', { poolId: POOL, executor: V3.launchBuyAdapter, trader: CREATOR, isBuy: true, quoteCurrency: ETH, quoteVolume: 10n ** 15n, quoteFeeAmount: 3n * 10n ** 13n, comment: `0x${'0'.repeat(64)}` });
  b.log(TOKEN, 'Transfer', { from: PM, to: CREATOR, value: 100_000n * e18 });

  // The trader buys 0.01 ETH: 3% tax split into the baskets (burn in the token).
  b.tx(L + 500n, TRADER);
  b.log(PM, 'Swap', { id: POOL, sender: CUR.universalRouter, amount0: -(10n ** 16n), amount1: 50_000n * e18, sqrtPriceX96: 1796000000000000000000000000000000n, liquidity: 1n, tick: 200588, fee: 0 });
  credit(b, 'ProtocolFeeCredited', { recipient: POLICY.protocolFeeConfiguration.protocolFeeRecipient, currency: ETH, amount: 9n * 10n ** 13n });
  credit(b, 'CreatorTaxCredited', { recipient: VAULT, currency: ETH, amount: 63n * 10n ** 12n });
  credit(b, 'RewardTaxCredited', { distributor: V3.rewardsDistributor, account: HOLDERS, currency: ETH, amount: 63n * 10n ** 12n });
  credit(b, 'RewardTaxCredited', { distributor: V3.rewardsDistributor, account: TRADERS, currency: ETH, amount: 42n * 10n ** 12n });
  credit(b, 'CommunityTaxCredited', { vault: COMMUNITY, currency: ETH, amount: 21n * 10n ** 12n });
  credit(b, 'BurnTaxCredited', { token: TOKEN, sink: DEAD, amount: 105n * e18 });
  b.log(V3.hook, 'Trade', { poolId: POOL, executor: CUR.universalRouter, trader: TRADER, isBuy: true, quoteCurrency: ETH, quoteVolume: 10n ** 16n, quoteFeeAmount: 3n * 10n ** 14n, comment: `0x${'0'.repeat(64)}` });
  b.log(TOKEN, 'Transfer', { from: PM, to: TRADER, value: 50_000n * e18 });
  // A small trader below the volume minimum, and a distributor swap that is never counted.
  b.tx(L + 600n, SMALL);
  b.log(PM, 'Swap', { id: POOL, sender: CUR.universalRouter, amount0: -(10n ** 14n), amount1: 500n * e18, sqrtPriceX96: 1795990000000000000000000000000000n, liquidity: 1n, tick: 200588, fee: 0 });
  b.log(V3.hook, 'Trade', { poolId: POOL, executor: CUR.universalRouter, trader: SMALL, isBuy: true, quoteCurrency: ETH, quoteVolume: 10n ** 14n, quoteFeeAmount: 3n * 10n ** 12n, comment: `0x${'0'.repeat(64)}` });
  b.log(TOKEN, 'Transfer', { from: PM, to: SMALL, value: 500n * e18 });
  b.tx(L + 700n, CREATOR);
  b.log(V3.hook, 'Trade', { poolId: POOL, executor: V3.rewardsDistributor, trader: CREATOR, isBuy: false, quoteCurrency: ETH, quoteVolume: 10n ** 18n, quoteFeeAmount: 0n, comment: `0x${'0'.repeat(64)}` });

  // Next day: the keeper closes yesterday for both streams (ETH → USDC), someone burns the token's burn basket.
  b.tx(DAY_END + 100n, '0x000000000000000000000000000000000000beef');
  b.log(V3.rewardsDistributor, 'Converted', { streamId: HOLDERS, amountIn: 63n * 10n ** 12n, amountOut: 126_000n });
  b.log(V3.rewardsDistributor, 'EpochClosed', { streamId: HOLDERS, epoch: BigInt(E0), collected: 63n * 10n ** 12n, totalFunded: 126_000n });
  b.log(V3.rewardsDistributor, 'Converted', { streamId: TRADERS, amountIn: 42n * 10n ** 12n, amountOut: 84_000n });
  b.log(V3.rewardsDistributor, 'EpochClosed', { streamId: TRADERS, epoch: BigInt(E0), collected: 42n * 10n ** 12n, totalFunded: 84_000n });
  b.tx(DAY_END + 200n, SMALL);
  b.log(TOKEN, 'Transfer', { from: PM, to: DEAD, value: 105n * e18 });
  b.log(V3.feeEscrow, 'TokensBurned', { token: TOKEN, caller: SMALL, amount: 105n * e18 });
  return b;
}

const HEAD = DAY_END + 400n;

function chainReads(extra = {}) {
  const base = fakeNode({ logs: [], senders: new Map(), head: 1n });
  return async (contracts) => {
    const out = [];
    for (const c of contracts) {
      const f = extra[c.functionName];
      if (f) out.push(f(c));
      else if (c.functionName === 'launchTokenKind') out.push({ status: 'success', result: 2 });
      else if (c.functionName === 'creatorRights') out.push({ status: 'success', result: { originalCreator: CREATOR, currentCreator: CREATOR, pendingCreator: ETH, creatorFeeRecipient: VAULT, poolId: POOL, metadataEditable: true } });
      else if (c.address === TOKEN && c.functionName === 'name') out.push({ status: 'success', result: 'Economy Token' });
      else if (c.address === TOKEN && c.functionName === 'symbol') out.push({ status: 'success', result: 'ECO' });
      else out.push((await base.multicall({ contracts: [c] }))[0]);
    }
    return out;
  };
}

async function economySetup(extraReads = {}) {
  const b = economyLogs();
  const db = await freshDb();
  const reads = chainReads(extraReads);
  // allowFailure: false calls get plain results.
  const onMulticall = async (contracts) => (await reads(contracts)).map((x) => (x && typeof x === 'object' && 'status' in x ? x : { status: 'success', result: x }));
  let node = fakeNode({ logs: b.logs, senders: b.senders, head: HEAD, onMulticall });
  const plain = async ({ contracts, allowFailure }) => {
    const res = await onMulticall(contracts);
    return allowFailure === false ? res.map((r) => r.result) : res;
  };
  const client = () => ({ ...node, multicall: plain, readContract: async (c) => (await plain({ contracts: [c], allowFailure: false }))[0], simulateContract: async () => ({ result: 77n }) });
  const index = async (head) => {
    node = fakeNode({ logs: b.logs, senders: b.senders, head, onMulticall });
    await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n, confirmations: 0n });
  };
  await index(HEAD);
  const deps = { db, client, now: () => Number(timeOf(HEAD)), fetchFn: async (url) => ({ ok: true, json: async () => ({ data: { amount: url.includes('ETH-USD') ? '2000' : '1' } }) }) };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
  return { b, db, client, index, get, deps };
}

test('indexer 0.3.0: economics, tax credits per basket, trades and daily volumes, burn, reward streams and epochs', async () => {
  const restore = deploy030();
  try {
    assert.equal(releaseGeneration('0.3.0-testnet'), 3);
    assert.equal(launchStartBlock(CHAIN), 58275925n, 'the oldest release still decides where indexing starts');
    assert.ok(launchStaticAddresses(CHAIN).includes(V3.rewardsDistributor) && launchStaticAddresses(CHAIN).includes(V3.feeEscrow));
    const { db, index } = await economySetup();
    const [e] = await db.query('select * from launch_economy where token = $1', [TOKEN]);
    assert.equal(e.version, launchDeployment(CHAIN).version, 'the current 0.3.x release');
    assert.equal(e.launch_type, 'economy');
    assert.deepEqual([e.buy_tax_rate, e.sell_tax_rate, e.creator_share, e.holders_share, e.traders_share, e.burn_share, e.community_share].map(Number), [3e6, 5e6, 3e7, 3e7, 2e7, 1e7, 1e7]);
    assert.equal(String(e.min_holding), String(25_000n * e18));
    assert.equal(e.reward_token, USDC);
    assert.equal(e.community_vault, COMMUNITY);
    assert.equal(e.creator_vault, VAULT);
    assert.equal(e.anti_snipe, true);
    const credits = await db.query('select kind, amount::text as amount from launch_tax_credits where token = $1 order by log_index', [TOKEN]);
    assert.deepEqual(credits.map((c) => c.kind), ['protocol', 'creator', 'holders', 'traders', 'community', 'burn']);
    const trades = await db.query('select trader, counted, epoch::int as epoch from launch_trades where token = $1 order by block', [TOKEN]);
    assert.deepEqual(trades.map((t) => [t.trader, t.counted]), [[CREATOR, true], [TRADER, true], [SMALL, true], [CREATOR, false]]);
    assert.ok(trades.every((t) => t.epoch === E0));
    const vol = await db.query('select trader, volume::text as v from launch_trader_volume where token = $1 order by trader', [TOKEN]);
    assert.deepEqual(vol.map((v) => [v.trader, v.v]), [[SMALL, String(10n ** 14n)], [CREATOR, String(10n ** 15n)], [TRADER, String(10n ** 16n)]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const [burn] = await db.query('select caller, amount::text as amount from launch_burns where token = $1', [TOKEN]);
    assert.deepEqual(burn, { caller: SMALL, amount: String(105n * e18) });
    const streams = await db.query('select stream_id, kind, economy, funded::text as funded, last_closed_epoch::int as closed, criterion::text as criterion from reward_streams order by kind');
    assert.deepEqual(streams.map((s) => [s.stream_id, s.kind, s.economy, s.funded, s.closed]), [[HOLDERS, 0, true, '126000', E0], [TRADERS, 1, true, '84000', E0]]);
    // Indexing again changes nothing.
    await index(HEAD);
    assert.equal((await db.query('select sum(volume)::text as v from launch_trader_volume'))[0].v, String(10n ** 16n + 10n ** 15n + 10n ** 14n));
    assert.equal((await db.query("select funded::text as f from reward_streams where stream_id = $1", [HOLDERS]))[0].f, '126000');
  } finally {
    restore();
  }
});

test('rewards publisher: daily holder and trader tables, cumulative Merkle roots the distributor accepts, claimMany', async () => {
  const restore = deploy030();
  try {
    const { b, db, client, index, get } = await economySetup();
    const pinned = [];
    const sent = [];
    const ipfs = { pin: async (text, name) => (pinned.push({ text, name }), `ipfs://bafy${pinned.length}`) };
    const publisher = { publishRoots: async (x) => (sent.push(x), `0x${'77'.repeat(32)}`), status: async () => 'success' };
    const run = await runRewardsPublisher({ db, client: client(), chainId: CHAIN, ipfs, publisher });
    assert.equal(run.built.length, 2, JSON.stringify(run));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].distributor, V3.rewardsDistributor);
    const totals = new Map(sent[0].updates.map((u) => [u.streamId, [u.epoch, u.cumulativeTotal]]));
    assert.deepEqual(totals.get(HOLDERS), [BigInt(E0), 126_000n]);
    assert.deepEqual(totals.get(TRADERS), [BigInt(E0), 83_999n], 'pro rata floors: 1 unit of dust waits for the next day');
    // Holders: the creator (100 000) and the trader (50 000) hold ≥ 25 000; the small holder (500), the pool and dEaD do not count.
    const holders = JSON.parse(pinned.find((p) => p.text.includes(HOLDERS)).text);
    assert.equal(holders.schema, 'place.rewards-table/1');
    assert.deepEqual(holders.entries.map((x) => [x.account, x.amount]), [[CREATOR, '84000'], [TRADER, '42000']]);
    // Traders: the trader (0.01 ETH) and the creator's dev buy (exactly the 0.001 ETH minimum); not the small one,
    // not the distributor's own swap.
    const traders = JSON.parse(pinned.find((p) => p.text.includes(TRADERS)).text);
    assert.deepEqual(traders.entries.map((x) => [x.account, x.amount]), [[CREATOR, '7636'], [TRADER, '76363']]);
    // Same tick again: nothing new while the roots are on their way.
    assert.equal((await runRewardsPublisher({ db, client: client(), chainId: CHAIN, ipfs, publisher })).built.length, 0);

    // The roots land on chain; the leaf is the contract's own: keccak256(bytes.concat(keccak256(abi.encode(id, account, cumulative)))).
    b.tx(HEAD + 10n, '0x000000000000000000000000000000000000beef');
    for (const u of sent[0].updates) b.log(V3.rewardsDistributor, 'RootPublished', { streamId: u.streamId, epoch: u.epoch, root: u.root, cumulativeTotal: u.cumulativeTotal, uri: u.uri });
    await index(HEAD + 20n);
    assert.deepEqual((await db.query("select distinct status from reward_tables")).map((r) => r.status), ['published']);

    const r = await get('launch/rewards', { account: TRADER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mine = r.body.rewards;
    assert.equal(mine.length, 2);
    for (const x of mine) {
      const stream = sent[0].updates.find((u) => u.streamId === x.streamId);
      const leaf = keccak256(concat([keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [x.streamId, TRADER, BigInt(x.cumulative)]))]));
      assert.ok(StandardMerkleTree.verify(stream.root, ['bytes32', 'address', 'uint256'], [x.streamId, TRADER, x.cumulative], x.proof));
      assert.equal(leaf, StandardMerkleTree.of([[x.streamId, TRADER, x.cumulative]], ['bytes32', 'address', 'uint256']).leafHash([x.streamId, TRADER, x.cumulative]));
      assert.equal(x.rewardToken.symbol, 'USDC');
      assert.equal(x.claimable, x.cumulative);
    }
    assert.equal(r.body.totals[USDC], String(mine.reduce((s, x) => s + BigInt(x.claimable), 0n)));
    const tx = r.body.claimMany[0];
    assert.equal(tx.to, V3.rewardsDistributor);
    const call = decodeFunctionData({ abi: REWARDS_DISTRIBUTOR_ABI, data: tx.data });
    assert.equal(call.functionName, 'claimMany');
    assert.equal(call.args[0].length, 2);
    assert.ok(call.args[0].every((c) => c.account.toLowerCase() === TRADER));

    // Claimed: nothing left, and no transaction.
    b.tx(HEAD + 30n, TRADER);
    for (const x of mine) b.log(V3.rewardsDistributor, 'RewardClaimed', { streamId: x.streamId, account: TRADER, amount: BigInt(x.cumulative), cumulativeAmount: BigInt(x.cumulative) });
    await index(HEAD + 40n);
    const after = await get('launch/rewards', { account: TRADER });
    assert.ok(after.body.rewards.every((x) => x.claimable === '0'));
    assert.deepEqual(after.body.claimMany, []);
    assert.equal((await db.query('select claimed::text as c from reward_streams where stream_id = $1', [TRADERS]))[0].c, mine.find((x) => x.streamId === TRADERS).cumulative);
  } finally {
    restore();
  }
});

test('rewards tables: cumulative over days, budget carried over a day nobody is eligible, pro rata floors', () => {
  const id = HOLDERS;
  assert.deepEqual([...proRata([['0xa', 1n], ['0xb', 2n]], 10n)], [['0xa', 3n], ['0xb', 6n]]);
  const empty = buildTable({ streamId: id, prev: new Map(), days: [{ epoch: 1, weights: [] }], budget: 1000n });
  assert.equal(empty.empty, true, 'nobody eligible: no root, the budget waits');
  const a = '0x000000000000000000000000000000000000000a';
  const c = '0x000000000000000000000000000000000000000c';
  const day2 = buildTable({ streamId: id, prev: new Map(), days: [{ epoch: 1, weights: [] }, { epoch: 2, weights: [[a, 1n]] }], budget: 1000n });
  assert.equal(day2.cumulativeTotal, 1000n, 'the carried budget goes to the next eligible day');
  const day3 = buildTable({ streamId: id, prev: new Map(day2.entries.map((e) => [e.account, e.cumulative])), days: [{ epoch: 3, weights: [[a, 1n], [c, 3n]] }], budget: 400n });
  assert.deepEqual(day3.entries.map((e) => [e.account, e.cumulative]), [[a, 1100n], [c, 300n]]);
  assert.equal(day3.cumulativeTotal, 1400n);
  assert.ok(StandardMerkleTree.verify(day3.root, ['bytes32', 'address', 'uint256'], [id, a, '1100'], day3.proofs.get(a)));
});

test('token page and creator panel of an Economy token: economy, burn, streams with epochs, revenue, community pool', async () => {
  const restore = deploy030();
  try {
    const reads = {
      pendingBurn: () => 0n,
      pendingFees: (c) => (c.address === COMMUNITY ? 21n * 10n ** 12n : 63n * 10n ** 12n),
      creatorOwed: () => 0n,
      xOwedTotal: () => 0n,
      payoutAddress: () => CREATOR,
      currentCreator: () => CREATOR,
      quote: () => ETH,
      lastFundSpendAt: () => BigInt(Number(timeOf(L))),
      settings: () => ({ token: TOKEN, poolKey: {}, feeEscrow: V3.feeEscrow, distributor: V3.rewardsDistributor, staking: V3.staking, rewardRegistry: V3.rewardTokenRegistry, defaultCampaignDelay: 2592000n, defaultCampaignEpochs: 30n, defaultCampaignMinimum: 5n * 10n ** 16n, defaultMinHolding: 25_000n * e18 }),
      fundBalance: () => 0n,
    };
    const { get } = await economySetup(reads);
    const r = await get('launch/token', { address: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { token, economy, burn, rewards, revenue } = r.body;
    assert.equal(token.generation, 3);
    assert.equal(token.legacy, false);
    assert.equal(token.launchType, 'economy');
    assert.equal(economy.buyTax, 3);
    assert.deepEqual(economy.perTrade.buy, { protocol: 0.9, creator: 0.63, holders: 0.63, traders: 0.42, burn: 0.21, community: 0.21, total: 3 });
    assert.equal(economy.rewardToken, USDC);
    assert.equal(burn.burned, String(105n * e18));
    assert.equal(burn.credited, String(105n * e18));
    assert.equal(burn.pendingBurn, '0');
    assert.equal(decodeFunctionData({ abi: FEE_ESCROW_ABI, data: burn.tx.data }).functionName, 'burn');
    assert.deepEqual(rewards.map((s) => [s.kind, s.funded, s.economy, s.epochs.length]), [['holders', '126000', true, 1], ['traders', '84000', true, 1]]);
    assert.equal(rewards[0].rewardToken.symbol, 'USDC');
    // epoch numbers are UTC days: the dates are real days, not 1970
    assert.equal(rewards[0].epochs[0].day, new Date(Number(rewards[0].epochs[0].epoch ?? E0) * 86_400_000).toISOString().slice(0, 10));
    assert.ok(rewards[0].nextCloseAt > '2026-01-01' && rewards[0].nextCloseAt.endsWith('T00:00:00.000Z'));
    assert.equal(revenue.creator, String(63n * 10n ** 12n));
    assert.equal(revenue.protocol, String(9n * 10n ** 13n));
    const holders = await get('launch/holders', { address: TOKEN });
    assert.ok(!holders.body.list.some((h) => h.tag === 'escrow'));

    const c = await get('launch/creator', { address: CREATOR });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const v = c.body.tokens.find((x) => x.token.address === TOKEN).vault;
    assert.equal(v.version, 'v3');
    assert.equal(v.claim.paid, '77');
    assert.equal(v.community.address, COMMUNITY);
    assert.equal(v.community.afterCollect, String(21n * 10n ** 12n));
    assert.equal(v.community.defaultCampaign.due, false, 'fund below the minimum and spent recently');
    assert.equal(decodeFunctionData({ abi: COMMUNITY_VAULT_ABI, data: v.community.defaultCampaign.tx.data }).functionName, 'startDefaultCampaign');
  } finally {
    restore();
  }
});

test('keeper 0.3.0: closeStreams for finished days once a day, deferred conversions, default campaigns', async () => {
  const restore = deploy030();
  try {
    let fund = 0n;
    const { db, client } = await economySetup({
      pendingFees: () => 0n,
      lastFundSpendAt: () => 0n,
      quote: () => ETH,
      settings: () => ({ defaultCampaignDelay: 2592000n, defaultCampaignMinimum: 5n * 10n ** 16n }),
      fundBalance: () => fund,
    });
    // A day later than the data: yesterday (E0 + 1) is finished for both streams.
    const now = (E0 + 2) * 86400 + 600;
    // Deferred input on the holders stream: collected but not converted.
    await db.query(`insert into reward_epochs (chain_id, stream_id, epoch, collected, total_funded, tx, at) values ($1, $2, $3, 1000, 126000, '0x01', now())`, [CHAIN, HOLDERS, E0 + 1]);
    const sent = [];
    const wallet = {
      address: '0x000000000000000000000000000000000000beef',
      estimate: async (call) => {
        if (call.functionName === 'convert' && call.args[1] === 0n) throw Object.assign(new Error('x'), { walk: () => ({ data: { errorName: 'PriceImpactTooHigh', args: [300n, 100n] } }) });
        return 200_000n;
      },
      send: async (call, gas) => (sent.push([call.address, call.functionName, call.args, gas]), { hash: `0x${'ab'.repeat(32)}`, status: 'success', gasUsed: 150_000n }),
    };
    const config = { intervalS: 86400, maxGas: 800_000n, maxCalls: 20 };
    const first = await runKeeper({ db, client: client(), wallet, chainId: CHAIN, now, config });
    const close = sent.find((s) => s[1] === 'closeStreams');
    assert.equal(close[0], V3.rewardsDistributor);
    assert.deepEqual([...close[2][0]].sort(), [HOLDERS, TRADERS].sort());
    const convert = sent.find((s) => s[1] === 'convert');
    assert.deepEqual(convert[2], [HOLDERS, 250n], 'a quarter of the deferred 1000 after the whole did not fit');
    assert.equal(first.done.find((x) => x.action === 'default_campaign').status, 'nothing');
    // Same day: nothing new.
    const n = sent.length;
    await runKeeper({ db, client: client(), wallet, chainId: CHAIN, now: now + 600, config });
    assert.equal(sent.length, n);
    // 31 days later with a full fund: the default campaign starts.
    fund = 10n ** 17n;
    await runKeeper({ db, client: client(), wallet, chainId: CHAIN, now: now + 31 * 86400, config });
    assert.ok(sent.some((s) => s[0] === COMMUNITY && s[1] === 'startDefaultCampaign'));
  } finally {
    restore();
  }
});
