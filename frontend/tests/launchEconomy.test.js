// Place Launch 0.2.0 economy: a launch from the current factory with burn and
// community-fund baskets, process() burns, fund campaigns and staking, PlaceStaking, the reward-token routes,
// the v2 rules template for the publisher and the keeper. Shaped like the L5 live run on Base Sepolia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, toBytes } from 'viem';
import { indexEvents } from '../api/_lib/place/indexer.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { runKeeper } from '../api/_lib/launch/keeper.js';
import { CREATOR_VAULT_ABI, PLACE_STAKING_ABI } from '../src/launch/abi.js';
import { launchCampaignRules } from '../src/launch/rules.js';
import { logBuilder, fakeNode, freshDb, CHAIN, CUR, CREATOR, TRADER, DEAD, ETH, USDC, timeOf } from './launchFixture.js';

const B1 = 58_740_700n;
const SUPPLY = 10n ** 27n;
const PL5B = { token: '0xb2000000000000000000003783b3b582c63bbe01', vault: '0x3abc6610532739b3f660ddd3289882234ce9dd51', pool: `0x${'5b'.repeat(32)}` };
const PROGRAM = `0x162c${'0'.repeat(56)}e356`;
const NOW = Number(timeOf(B1 + 3000n));
const e18 = 10n ** 18n;
// rules/launch-holders-v2.json in place-contracts, byte for byte.
const TEMPLATE_V2 =
  '{"distribution":"proportional","exclude":"launch pool: PoolManager, PlaceLaunchHook, FeeEscrow, PlaceStaking, the creator vault and 0x000000000000000000000000000000000000dead","kind":"token-holders","minBalance":"1","note":"Template for holder campaigns paid from the community fund of a PlaceCreatorVault (Place Launch 0.2.0+): fundCampaign by the creator or startDefaultCampaign by anyone. Per campaign, target = launch token; rewardToken, pool, snapshotAt, claimDuration and burnLeftover come from the hub CampaignCreated event","schema":"place.launch-rules/2"}';

function v2Logs() {
  const b = logBuilder();
  const F = CUR.factory;
  b.tx(B1 - 10n, CREATOR);
  b.log(F, 'QuoteRegistered', { quoteToken: ETH, quoteDecimals: 18, startTickToken0Frame: -200600, revision: 1n });
  b.log(F, 'QuoteRegistered', { quoteToken: USDC, quoteDecimals: 6, startTickToken0Frame: -400600, revision: 1n });
  b.log(F, 'QuoteLimitsUpdated', { quoteToken: ETH, maxBurnPerProcess: 10n ** 14n, defaultCampaignMinimum: 10n ** 14n });
  b.log(CUR.rewardTokenRegistry, 'RouteSet', {
    from: ETH,
    to: USDC,
    hops: [{ currency0: ETH, currency1: USDC, fee: 10000, tickSpacing: 200, hooks: ETH }],
  });

  // B20 / ETH launch: burn 25%, fund 50%, creator 25%; dev buy 0.0005 ETH
  b.tx(B1, CREATOR);
  b.log(F, 'CreatorVaultCreated', { token: PL5B.token, vault: PL5B.vault, burnBps: 2500, communityBps: 5000 });
  b.log(CUR.poolManager, 'Initialize', { id: PL5B.pool, currency0: ETH, currency1: PL5B.token, fee: 0, tickSpacing: 200, hooks: CUR.hook, sqrtPriceX96: 1797361575845028639913410322392517n, tick: 200600 });
  b.log(PL5B.token, 'Transfer', { from: ETH, to: CUR.poolManager, value: SUPPLY });
  b.log(F, 'Launched', { token: PL5B.token, poolId: PL5B.pool, originalCreator: CREATOR, quoteToken: ETH, launchSupply: SUPPLY, tickSpacing: 200 });
  b.log(CUR.poolManager, 'Swap', { id: PL5B.pool, sender: CUR.launchBuyAdapter, amount0: -495000000000000n, amount1: 254687n * e18, sqrtPriceX96: 1796446280680026189204988623606028n, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(PL5B.token, 'Transfer', { from: CUR.poolManager, to: CREATOR, value: 254687n * e18 });

  // process() from the trader: collect 0.0001235 ETH into the baskets, burn 15 606 PL5B
  b.tx(B1 + 1000n, TRADER);
  b.log(PL5B.vault, 'Collected', { amount: 123500000000000n, toBurn: 30875000000000n, toCommunity: 61750000000000n, toX: 0n, toCreator: 30875000000000n });
  b.log(CUR.poolManager, 'Swap', { id: PL5B.pool, sender: PL5B.vault, amount0: -30875000000000n, amount1: 15606n * e18, sqrtPriceX96: 1796440000000000000000000000000000n, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(PL5B.token, 'Transfer', { from: CUR.poolManager, to: DEAD, value: 15606n * e18 });
  b.log(PL5B.vault, 'Burned', { quoteIn: 30875000000000n, tokenOut: 15606n * e18, caller: TRADER });

  // fundCampaign in USDC (swap through the listed route) → campaign #3
  b.tx(B1 + 1100n, CREATOR);
  b.log(PL5B.vault, 'FundSwapped', { fundAsset: ETH, rewardToken: USDC, amountIn: 30900000000000n, amountOut: 63016n });
  b.log(PL5B.vault, 'FundCampaignCreated', { campaignId: 3n, rewardToken: USDC, pool: 60015n, paid: 63015n, isDefault: false });

  // fundStaking in the token itself → a PlaceStaking program; the trader stakes
  b.tx(B1 + 1200n, CREATOR);
  b.log(CUR.staking, 'VaultCreated', {
    vaultId: PROGRAM, creator: PL5B.vault, stakingToken: PL5B.token, rewardCurrency: PL5B.token, startTime: BigInt(NOW - 3600), epochDuration: 86400n, epochCount: 1n,
    rewardPerEpoch: 14914473n * e18, earlyExitMode: 0, penaltyBps: 0, totalReward: 14914473n * e18, protocolFee: 745724n * e18, feeBps: 500, feeRecipient: CREATOR, feeConfigVersion: 1n,
  });
  b.log(PL5B.vault, 'FundStakingCreated', { stakingVaultId: PROGRAM, rewardToken: PL5B.token, rewardPerEpoch: 14914473n * e18, epochCount: 1n, paid: 15660197n * e18 });
  b.tx(B1 + 1300n, TRADER);
  b.log(CUR.staking, 'Deposited', { vaultId: PROGRAM, user: TRADER, lotId: 0n, amount: 3757613n * e18, depositTime: BigInt(NOW - 3000), unlockAt: BigInt(NOW + 83400) });

  // the creator raises the burn share
  b.tx(B1 + 1400n, CREATOR);
  b.log(PL5B.vault, 'EconomicsIncreased', { burnBps: 3000, communityBps: 5000 });
  b.log(PL5B.vault, 'CreatorPaid', { payout: CREATOR, amount: 30875000000000n });
  return b;
}

const VAULT_STATE = {
  burnReserve: 0n,
  creatorOwed: 0n,
  xOwedTotal: 0n,
  pendingFees: 10n ** 12n,
  payoutAddress: CREATOR,
  currentCreator: CREATOR,
  lastProcessAt: BigInt(NOW - 7200),
  lastFundSpendAt: BigInt(NOW - 1000),
  nextProcessAt: BigInt(NOW - 3600),
  settings: {
    hub: CUR.hub, staking: CUR.staking, rewardRegistry: CUR.rewardTokenRegistry, processInterval: 3600n, defaultCampaignDelay: 30n * 86400n,
    maxBurnPerProcess: 10n ** 14n, defaultCampaignMinimum: 10n ** 14n, rulesHash: CUR.launchRules[0].rulesHash, rulesURI: CUR.launchRules[0].rulesURI,
  },
  burnBps: 3000,
  communityBps: 5000,
  quote: ETH,
  token: PL5B.token,
};

async function setup({ simulate, onMulticall } = {}) {
  const b = v2Logs();
  const db = await freshDb();
  const node = fakeNode({
    logs: b.logs,
    senders: b.senders,
    head: B1 + 3030n,
    onMulticall:
      onMulticall ||
      (async (contracts) =>
        contracts.map((c) => {
          if (c.functionName in VAULT_STATE) return VAULT_STATE[c.functionName];
          if (c.functionName === 'launchTokenKind') return { status: 'success', result: 2 };
          if (c.functionName === 'creatorRights') return { status: 'success', result: { currentCreator: CREATOR, creatorFeeRecipient: PL5B.vault, metadataEditable: false } };
          if (c.functionName === 'xShares') return { status: 'success', result: [] };
          if (c.functionName === 'symbol') return { status: 'success', result: c.address === USDC ? 'USDC' : 'PL5B' };
          if (c.functionName === 'name') return { status: 'success', result: c.address === USDC ? 'USDC' : 'Place L5 B20' };
          if (c.functionName === 'decimals') return { status: 'success', result: c.address === USDC ? 6 : 18 };
          return { status: 'success', result: '' };
        })),
  });
  await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n });
  const client = {
    ...node,
    async readContract({ functionName }) {
      if (functionName === 'fundBalance') return 61750000000000n - 30900000000000n;
      if (functionName === 'config') return '0x1111111111111111111111111111111111111111';
      if (functionName === 'campaignFeeBps') return 500n;
      if (functionName === 'feeConfig') return [500, CREATOR, 1n];
      if (functionName === 'getUserState') return [1n, 3757613n * e18, 0];
      if (functionName === 'getUserLots') return [[{ remainingAmount: 3757613n * e18, eligibleAt: BigInt(NOW - 3000), unlockAt: BigInt(NOW + 83400) }], 1n, 1n];
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: simulate || (async () => ({ result: 0n })),
  };
  const deps = {
    db,
    client: () => client,
    now: () => NOW,
    fetchFn: async (url) => ({ ok: true, json: async () => ({ data: { amount: url.includes('ETH-USD') ? '2000' : '1' } }) }),
  };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
  return { db, deps, get, client };
}

const revert = (errorName, args) => {
  const err = new Error('reverted');
  err.walk = (fn) => (fn({ data: { errorName, args } }) ? { data: { errorName, args } } : null);
  return err;
};

test('a 0.2.0 launch: release, baskets, burns, fund campaign and staking events, routes and quote limits', async () => {
  const { db } = await setup();
  const [e] = await db.query('select version, burn_bps, community_bps from launch_economy where token = $1', [PL5B.token]);
  assert.deepEqual(e, { version: '0.2.0-testnet', burn_bps: 3000, community_bps: 5000 }, 'EconomicsIncreased raises the shares');
  const [t] = await db.query('select vault, buyback_bps from launch_tokens where token = $1', [PL5B.token]);
  assert.equal(t.vault, PL5B.vault);
  assert.equal(t.buyback_bps, null, 'no 0.1.0 columns for 0.2.0 tokens');
  const kinds = (await db.query('select kind from launch_vault_events where vault = $1 order by block, log_index', [PL5B.vault])).map((r) => r.kind);
  assert.deepEqual(kinds, ['collected', 'burned', 'fund_swapped', 'fund_campaign', 'fund_staking', 'economics', 'creator_paid']);
  const [c] = await db.query("select data from launch_vault_events where kind = 'collected'");
  assert.equal(JSON.parse(c.data).toCommunity, '61750000000000');
  const [p] = await db.query('select creator, staking_token, total_staked::text as staked, fee_bps from staking_programs where vault_id = $1', [PROGRAM]);
  assert.deepEqual(p, { creator: PL5B.vault, staking_token: PL5B.token, staked: String(3757613n * e18), fee_bps: 500 });
  const [route] = await db.query('select from_token, to_token, active from launch_reward_routes');
  assert.deepEqual(route, { from_token: ETH, to_token: USDC, active: true });
  const [lim] = await db.query('select max_burn_per_process::text as m from launch_quote_limits where quote = $1', [ETH]);
  assert.equal(lim.m, String(10n ** 14n));
});

test('token page: 0.2.0 economics, burn history with transactions, community fund, staking, official campaigns', async () => {
  const { db, get } = await setup();
  await db.query(
    `insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at, claim_duration, burn_leftover, created_block, created_tx, created_at)
     values ($1, $2, 3, $3, 0, $4, $5, 60015, 3000, $6, 2592000, true, 1, '0x03', $6), ($1, $2, 9, $7, 0, $4, $5, 1000, 50, $6, 2592000, true, 2, '0x09', $6)`,
    [CHAIN, CUR.hub, PL5B.vault, PL5B.token, USDC, new Date(NOW * 1000).toISOString(), TRADER]
  );
  const r = await get('launch/token', { address: PL5B.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { token, burns, fund, staking, campaigns } = r.body;
  assert.equal(token.version, '0.2.0-testnet');
  assert.equal(token.legacy, true); // 0.3.0 is the current release now
  assert.equal(token.generation, 2);
  assert.equal(token.hook, CUR.hook);
  assert.deepEqual(token.economics, { version: '0.2.0-testnet', legacy: true, generation: 2, burnBps: 3000, communityBps: 5000, creatorBps: 2000, xShares: [] });
  assert.equal(burns.count, 1);
  assert.equal(burns.totalTokens, String(15606n * e18));
  assert.equal(burns.list[0].caller, TRADER);
  assert.match(burns.list[0].tx, /^0x/);
  assert.equal(fund.balance, String(61750000000000n - 30900000000000n));
  assert.equal(fund.pending, String((10n ** 12n * 5000n) / 10000n));
  assert.equal(fund.process.due, true);
  assert.equal(staking.length, 1);
  assert.equal(staking[0].fromLaunchVault, true);
  assert.equal(staking[0].status, 'live');
  assert.equal(staking[0].stakers, 1);
  assert.deepEqual(campaigns.map((c) => [c.id, c.section]).sort(), [['3', 'official'], ['9', 'community']]);
  assert.equal(token.holders, 1, 'the creator; the trader staked nothing at the token level here, the pool and burn address are not people');
});

test('creator panel (0.2.0): baskets, claim, process dry run, default campaign reason, reward tokens from routes', async () => {
  const sims = [];
  const { get } = await setup({
    simulate: async ({ functionName, account }) => {
      sims.push([functionName, account]);
      if (functionName === 'claim') return { result: 123n };
      if (functionName === 'process') return { result: [10n ** 12n, 30875000000000n, 15606n * e18] };
      throw revert('DefaultCampaignTooSoon', [BigInt(NOW + 30 * 86400)]);
    },
  });
  const r = await get('launch/creator', { address: CREATOR });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.tokens.find((x) => x.token.address === PL5B.token);
  const v = t.vault;
  assert.equal(v.version, 'v2');
  assert.deepEqual(v.economics, { burnBps: 3000, communityBps: 5000, creatorBps: 2000 });
  assert.equal(v.claim.paid, '123');
  assert.equal(decodeFunctionData({ abi: CREATOR_VAULT_ABI, data: v.claim.tx.data }).functionName, 'claim');
  assert.equal(v.process.canRun, true);
  assert.equal(v.process.tokensBurned, String(15606n * e18));
  assert.equal(v.defaultCampaign.canStart, false);
  assert.match(v.defaultCampaign.reason, /^DefaultCampaignTooSoon/);
  assert.deepEqual(v.rewardTokens.map((x) => [x.symbol, x.route]), [['ETH', 'none'], ['PL5B', 'own-pool'], ['USDC', 'registry']]);
  assert.equal(t.totals.burnedTokens, String(15606n * e18));
  assert.equal(t.totals.stakingPrograms, 1);
  assert.ok(sims.every(([, a]) => a === CREATOR));
});

test('fund quote: the swap output from the vault revert, minOut with slippage, hub and staking fees', async () => {
  const { get } = await setup({
    simulate: async ({ functionName, args }) => {
      assert.equal(functionName, 'fundCampaign');
      assert.equal(args[0].minOut, 2n ** 256n - 1n);
      throw revert('SlippageExceeded', [63016n, args[0].minOut]);
    },
  });
  const r = await get('launch/fund-quote', { token: PL5B.token, rewardToken: USDC, amountIn: '30900000000000', slippageBps: '100' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amountOut, '63016');
  assert.equal(r.body.minOut, String((63016n * 9900n) / 10000n));
  assert.equal(r.body.hubFeeBps, 500);
  assert.equal(r.body.campaignPool, String((((63016n * 9900n) / 10000n) * 10000n) / 10500n));
  const same = await get('launch/fund-quote', { token: PL5B.token, rewardToken: 'eth', amountIn: '1000' });
  assert.equal(same.body.amountOut, '1000');
  assert.equal(same.body.swap, false);
  const bad = await setup({ simulate: async () => Promise.reject(revert('PriceImpactTooHigh', [900n, 500n])) });
  const r2 = await bad.get('launch/fund-quote', { token: PL5B.token, rewardToken: USDC, amountIn: '30900000000000' });
  assert.equal(r2.body.amountOut, null);
  assert.equal(r2.body.error, 'PriceImpactTooHigh(900, 500)');
});

test('staking: programs with status and the account position, claimable epochs from previewClaim', async () => {
  const { get, client } = await setup();
  const list = await get('launch/staking', { account: TRADER });
  assert.equal(list.status, 200);
  assert.equal(list.body.programs.length, 1);
  assert.equal(list.body.programs[0].position.staked, String(3757613n * e18));
  assert.equal(list.body.programs[0].stakingToken.symbol, 'PL5B');
  // No epoch has ended yet: nothing to claim.
  const pos = await get('launch/staking/position', { id: PROGRAM, account: TRADER });
  assert.equal(pos.status, 200, JSON.stringify(pos.body));
  assert.equal(pos.body.lots.length, 1);
  assert.equal(pos.body.claimable.total, '0');
  assert.equal(pos.body.tx.claim, null);
  void client;
  assert.equal((await get('launch/staking/position', { id: '0x12', account: TRADER })).status, 400);
});

test('v2 rules template: reward token, pool, snapshot, claim window and leftover from the campaign; staking excluded', () => {
  assert.equal(keccak256(toBytes(TEMPLATE_V2)), CUR.launchRules[0].rulesHash);
  const campaign = {
    creator: PL5B.vault, kind: 0, target: PL5B.token, rewardToken: PL5B.token, pool: 2264571913073011166172n, snapshotAt: 1_794_772_601n,
    claimDuration: 7 * 86400, burnLeftover: false, rulesHash: CUR.launchRules[0].rulesHash,
  };
  const vault = { address: PL5B.vault, token: PL5B.token, quote: USDC };
  const rules = launchCampaignRules(TEMPLATE_V2, { campaign, hub: CUR.hub, chainId: CHAIN, d: CUR, vault, createdAt: 1_794_686_201 });
  assert.equal(rules.rewardToken, PL5B.token);
  assert.equal(rules.claimDuration, 7 * 86400);
  assert.equal(rules.leftover, 'return');
  assert.ok(rules.exclude.includes(CUR.staking) && rules.exclude.includes(PL5B.vault) && rules.exclude.includes(DEAD));
  assert.throws(() => launchCampaignRules(TEMPLATE_V2, { campaign: { ...campaign, creator: TRADER }, hub: CUR.hub, chainId: CHAIN, d: CUR, vault, createdAt: 1 }), /creator/);
  assert.throws(() => launchCampaignRules(TEMPLATE_V2, { campaign: { ...campaign, target: USDC }, hub: CUR.hub, chainId: CHAIN, d: CUR, vault, createdAt: 1 }), /target/);
  assert.throws(() => launchCampaignRules(TEMPLATE_V2.replace('proportional', 'equal'), { campaign, hub: CUR.hub, chainId: CHAIN, d: CUR, vault, createdAt: 1 }), /rulesHash/);
});

test('keeper: process() once a day when due, default campaign only after 30 days, gas cap, log', async () => {
  const { db, client } = await setup();
  const sent = [];
  let gas = 300_000n;
  const wallet = {
    address: '0x000000000000000000000000000000000000beef',
    estimate: async () => gas,
    send: async ({ address: vault, functionName: fn }, g) => {
      sent.push([vault, fn, g]);
      return { hash: `0x${'ab'.repeat(32)}`, status: 'success', gasUsed: 250_000n };
    },
  };
  const config = { intervalS: 86400, maxGas: 800_000n, maxCalls: 20 };
  const first = await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW, config });
  assert.deepEqual(sent.map(([v, f]) => [v, f]), [[PL5B.vault, 'process']]);
  assert.ok(sent[0][2] > 300_000n, 'the gas limit has headroom over the estimate');
  assert.equal(first.done.find((x) => x.action === 'default_campaign').status, 'nothing');
  // Same day: nothing new.
  await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW + 600, config });
  assert.equal(sent.length, 1);
  // A day later the estimate is above the cap: skipped and logged.
  gas = 2_000_000n;
  const later = await runKeeper({ db, client, wallet, chainId: CHAIN, now: NOW + 90_000, config });
  assert.equal(sent.length, 1);
  assert.equal(later.done.find((x) => x.action === 'process').status, 'skipped-gas');
  const { deps } = await setup();
  deps.db = db;
  const log = await handlePlace({ method: 'GET', path: 'launch/keeper', query: { chain: String(CHAIN) } }, deps);
  assert.ok(log.body.runs.some((r) => r.status === 'success' && r.gasUsed === '250000'));
  assert.ok(log.body.runs.some((r) => r.status === 'skipped-gas'));
  // No key: the keeper says so and does nothing.
  assert.match((await runKeeper({ db, client, wallet: null, chainId: CHAIN, now: NOW, config })).skipped, /PLACE_KEEPER_PRIVATE_KEY/);
  void PLACE_STAKING_ABI;
});

test('getLogs goes out at most 10 addresses at a time and comes back in block order', async () => {
  const { getLogsChunked } = await import('../api/_lib/place/indexer.js');
  const seen = [];
  const client = {
    async getLogs({ address }) {
      seen.push(address.length);
      return address.map((a, i) => ({ address: a, blockNumber: BigInt(100 - seen.length * 10 - i), logIndex: i }));
    },
  };
  const addrs = Array.from({ length: 23 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
  const logs = await getLogsChunked(client, addrs, 1n, 2n);
  assert.deepEqual(seen, [10, 10, 3]);
  assert.equal(logs.length, 23);
  assert.ok(logs.every((l, i) => i === 0 || l.blockNumber >= logs[i - 1].blockNumber));
});
