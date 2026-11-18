// Community Pool actions of Place Launch 0.3.1: NFT holder campaigns (fundNftCampaign) and buyback & burn
// (buybackAndBurn). Form helpers, the fund-quote dry runs, the pool panel (who can do what) and the indexer rows of
// the pool log. Shaped like the PNFT pool on Base Sepolia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { COMMUNITY_VAULT_ABI } from '../src/launch/abi.js';
import { ECONOMY_ROUTES } from '../api/_lib/launch/economy.js';
import { communityPanel, poolNftCollections } from '../api/_lib/launch/rewards.js';
import { applyLaunchLog } from '../api/_lib/launch/indexer.js';
import {
  parseShareBps,
  shareText,
  shareAmount,
  sortPoolCollections,
  defaultCollection,
  nftBlocker,
  nftQuoteQuery,
  buybackQuoteQuery,
  poolLogLabel,
} from '../src/launch/poolActions.js';

const CHAIN = 84532;
const TOKEN = '0x49a7f63e74418e709a03004379c2b8d8f6e1ad01';
const VAULT = '0x3bd5f6699e7129b524f20d8ad5f767690b2c0ea3';
const OFFICIAL = '0x6f0a50424cee3845e2b93829eae170f1289006cb';
const FAN = '0xefefa13fc2adf338a08b2d85204588f7298b712a';
const CREATOR = '0x6bb35f78a2fe7fad0809d849a99b2e2b1c5e3134';
const FACTORY = '0xe5a54d2984f10ec21257c9c2491a54567c376322';
const GUARD = '0x3db045168ffbce897049edaa4701f7dd57e2a392';
const ETH = '0x0000000000000000000000000000000000000000';
const NOW = 1_795_000_000;
const FUND = 1_091_631_437_415n;

const revert = (errorName, args) => {
  const err = new Error('reverted');
  err.walk = (fn) => (fn({ data: { errorName, args } }) ? { data: { errorName, args } } : null);
  return err;
};

const COLLECTIONS = [
  { address: OFFICIAL, factory: FACTORY, name: 'PNFT Founders', symbol: 'PNFTF', official: true, kind: 'edition', total_minted: 6, mint_price: '20000000000000' },
  { address: FAN, factory: FACTORY, name: 'PNFT Fan Art', symbol: 'PNFTA', official: false, kind: 'unique', total_minted: 3, mint_price: '10000000000000' },
];

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (sql.includes('from launch_tokens t')) return [{ token: TOKEN, vault: '0x7777777777777777777777777777777777777777', quote: ETH, current_creator: CREATOR, version: '0.3.1-testnet', community_vault: VAULT, min_holding: '0' }];
      if (sql.includes('select token, official from nft_launch_collections')) {
        const c = COLLECTIONS.find((x) => x.address === params[1]);
        return c ? [{ token: TOKEN, official: c.official }] : [];
      }
      if (sql.includes('from nft_launch_collections')) return COLLECTIONS;
      if (sql.includes('from launch_vault_events')) return [];
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

function setup({ simulate } = {}) {
  const sims = [];
  const client = {
    async readContract({ functionName }) {
      if (functionName === 'streamFeeBps') return 500;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract(c) {
      sims.push(c);
      return simulate(c);
    },
  };
  const deps = { db: fakeDb(), client: () => client, now: () => NOW };
  const quote = (q) => ECONOMY_ROUTES['GET launch/fund-quote']({ query: { chain: String(CHAIN), token: TOKEN, ...q } }, deps);
  return { deps, quote, sims };
}

test('form helpers: share of the pool in %, the 25% cap, collections official first, quote queries', () => {
  assert.equal(parseShareBps('12.5'), 1250);
  assert.equal(parseShareBps('0.01'), 1);
  assert.equal(parseShareBps('100'), 10_000);
  assert.equal(parseShareBps('25.01', 2500), null, 'over the NFT cap');
  assert.equal(parseShareBps('0'), null);
  assert.equal(parseShareBps('1.234'), null);
  assert.equal(parseShareBps('abc'), null);
  assert.equal(shareText(1250), '12.5');
  assert.equal(shareText(2500), '25');
  assert.equal(shareAmount(FUND, 2500), (FUND * 2500n) / 10_000n, 'rounded down like the vault cap');
  assert.equal(shareAmount(FUND, null), null);

  const list = [
    { address: FAN, eligible: false, reason: 'Not official' },
    { address: OFFICIAL, eligible: true },
  ];
  assert.deepEqual(sortPoolCollections(list).map((c) => c.address), [OFFICIAL, FAN]);
  assert.equal(defaultCollection(list), OFFICIAL);
  assert.equal(defaultCollection([{ address: FAN, eligible: false }]), null);

  const nft = { available: true, maxBps: 2500, nextAt: null, collections: list };
  assert.equal(nftBlocker(nft, OFFICIAL, NOW * 1000), null);
  assert.equal(nftBlocker(nft, FAN, NOW * 1000), 'Not official');
  assert.equal(nftBlocker({ ...nft, nextAt: new Date((NOW + 86400) * 1000).toISOString() }, OFFICIAL, NOW * 1000), 'One NFT campaign per 30 days');
  assert.equal(nftBlocker({ ...nft, collections: [] }, null), 'No Place collection is paired with this token yet');
  assert.equal(nftBlocker({ available: false, reason: 'This pool has no NFT factory' }, OFFICIAL), 'This pool has no NFT factory');

  const base = { token: TOKEN, collection: OFFICIAL, total: FUND.toString(), shareBps: 1000, maxBps: 2500, rewardToken: 'eth', slippageBps: 100, epochCount: 30, startEpoch: 20_776, minNfts: 1 };
  assert.deepEqual(nftQuoteQuery(base), { token: TOKEN, kind: 'nft', collection: OFFICIAL, rewardToken: 'eth', amountIn: '109163143741', slippageBps: 100, epochCount: 30, startEpoch: 20_776, minNfts: 1 });
  assert.equal(nftQuoteQuery({ ...base, shareBps: 3000 }), null, 'over 25%');
  assert.equal(nftQuoteQuery({ ...base, minNfts: 0 }), null);
  assert.equal(nftQuoteQuery({ ...base, total: '0' }), null, 'empty pool');
  assert.deepEqual(buybackQuoteQuery({ token: TOKEN, total: FUND.toString(), shareBps: 2500, slippageBps: 100 }), { token: TOKEN, kind: 'buyback', amountIn: '272907859353', slippageBps: 100 });
  assert.equal(buybackQuoteQuery({ token: TOKEN, total: FUND.toString(), shareBps: null, slippageBps: 100 }), null);
  assert.equal(poolLogLabel('fund_burned'), 'Bought back and burned');
  assert.equal(poolLogLabel('fund_nft_stream'), 'NFT holders campaign');
});

test('fund-quote kind=nft: dry run with an impossible minOut for the swap, then the real call from the creator', async () => {
  const amountIn = (FUND * 1000n) / 10_000n;
  const { quote, sims } = setup({
    simulate: async ({ functionName, args, account }) => {
      assert.equal(functionName, 'fundNftCampaign');
      assert.equal(account, CREATOR, 'simulated as the current creator');
      if (args[0].minOut > 10n ** 70n) throw revert('SlippageExceeded', [365n * 10n ** 18n, args[0].minOut]);
      return { result: `0x${'fc'.repeat(32)}` };
    },
  });
  const r = await quote({ kind: 'nft', collection: OFFICIAL, rewardToken: TOKEN, amountIn: amountIn.toString(), epochCount: '30', startEpoch: String(Math.floor(NOW / 86400) + 1), minNfts: '2', slippageBps: '100' });
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.error, null);
  assert.equal(b.kind, 'nft');
  assert.equal(b.amountOut, String(365n * 10n ** 18n));
  assert.equal(b.minOut, String((365n * 10n ** 18n * 9900n) / 10_000n));
  assert.equal(b.feeBps, 500);
  assert.equal(b.budget, String((BigInt(b.minOut) * 10_000n) / 10_500n));
  assert.equal(b.perEpoch, String(BigInt(b.budget) / 30n));
  assert.equal(sims.length, 2, 'probe + real call');
  const { functionName, args } = decodeFunctionData({ abi: COMMUNITY_VAULT_ABI, data: b.tx.data });
  assert.equal(functionName, 'fundNftCampaign');
  assert.equal(b.tx.to, VAULT);
  assert.equal(args[0].collection.toLowerCase(), OFFICIAL);
  assert.equal(args[0].fundAsset, ETH);
  assert.equal(args[0].amountIn, amountIn);
  assert.equal(args[0].minNfts, 2n);
  assert.equal(args[0].epochCount, 30n);
  assert.equal(args[0].minOut, BigInt(b.minOut));
});

test('fund-quote kind=nft: the vault says why not (cooldown, collection) and no transaction is offered', async () => {
  const { quote } = setup({ simulate: async () => Promise.reject(revert('NftCampaignTooSoon', [1_797_606_579n])) });
  const r = await quote({ kind: 'nft', collection: OFFICIAL, rewardToken: 'eth', amountIn: '1000' });
  assert.equal(r.body.error, 'NftCampaignTooSoon(1797606579)');
  assert.equal(r.body.tx, null);

  const bad = setup({ simulate: async () => Promise.reject(revert('InvalidCollection', [])) });
  const r2 = await bad.quote({ kind: 'nft', collection: FAN, rewardToken: 'eth', amountIn: '1000' });
  assert.equal(r2.body.error, 'InvalidCollection()');
  assert.equal(r2.body.tx, null);

  await assert.rejects(() => bad.quote({ kind: 'nft', collection: '0x1111111111111111111111111111111111111111', amountIn: '1' }), /Not a Place NFT launchpad collection/);
  await assert.rejects(() => bad.quote({ kind: 'nft', collection: OFFICIAL, amountIn: '1', minNfts: '0' }), /minNfts must be/);
  await assert.rejects(() => bad.quote({ kind: 'mint', amountIn: '1' }), /kind must be holders, traders, staking, nft or buyback/);
});

test('fund-quote kind=buyback: dry run with minOut 0 gives the tokens burned, minus the slippage', async () => {
  const amountIn = (FUND * 2500n) / 10_000n;
  const { quote } = setup({
    simulate: async ({ functionName, args, account }) => {
      assert.equal(functionName, 'buybackAndBurn');
      assert.equal(account, CREATOR);
      assert.equal(args[0].minOut, 0n);
      return { result: 137_557_378_517_203_124_257n };
    },
  });
  const r = await quote({ kind: 'buyback', amountIn: amountIn.toString(), slippageBps: '100' });
  assert.equal(r.body.error, null);
  assert.equal(r.body.amountOut, '137557378517203124257');
  assert.equal(r.body.minOut, String((137_557_378_517_203_124_257n * 9900n) / 10_000n));
  const { functionName, args } = decodeFunctionData({ abi: COMMUNITY_VAULT_ABI, data: r.body.tx.data });
  assert.equal(functionName, 'buybackAndBurn');
  assert.deepEqual(args[0], { fundAsset: ETH, amountIn, minOut: BigInt(r.body.minOut) });

  const off = setup({ simulate: async () => Promise.reject(revert('BuybackDisabled', [])) });
  const r2 = await off.quote({ kind: 'buyback', amountIn: '1000' });
  assert.equal(r2.body.error, 'BuybackDisabled()');
  assert.equal(r2.body.tx, null);
});

function panelClient({ v031 = true, factory = FACTORY, guard = GUARD, lastNft = BigInt(NOW - 86400) } = {}) {
  const base = { pendingFees: 3_040_000_000n, lastFundSpendAt: BigInt(NOW - 86400), quote: ETH, currentCreator: CREATOR, token: TOKEN, settings: { distributor: '0xc43ba7b756427f37073fbf8b3f71e990139c9518', staking: ETH, rewardRegistry: '0x9999999999999999999999999999999999999999', defaultCampaignDelay: 30n * 86400n, defaultCampaignEpochs: 30n, defaultCampaignMinimum: 0n, defaultMinHolding: 0n } };
  const x = { nftFactory: factory, priceGuard: guard, lastNftCampaignAt: lastNft, NFT_CAMPAIGN_COOLDOWN: 30n * 86400n, MAX_NFT_CAMPAIGN_BPS: 2500n, totalBurned: 547_674_079_389_430_572_709n };
  return {
    async multicall({ contracts, allowFailure }) {
      return contracts.map((c) => {
        if (c.functionName in base) return allowFailure ? { status: 'success', result: base[c.functionName] } : base[c.functionName];
        if (c.functionName in x) return v031 ? { status: 'success', result: x[c.functionName] } : { status: 'failure', error: new Error('reverted') };
        throw new Error(`unexpected read ${c.functionName}`);
      });
    },
    async readContract({ functionName }) {
      if (functionName === 'fundBalance') return FUND - 3_040_000_000n;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract() {
      throw revert('DefaultCampaignTooSoon', [BigInt(NOW + 29 * 86400)]);
    },
  };
}

test('pool panel 0.3.1: NFT campaigns (cooldown, 25% cap, collections official first) and buybacks for the creator', async () => {
  const deps = { db: fakeDb(), client: () => panelClient() };
  const p = await communityPanel(deps, CHAIN, VAULT, NOW, { creator: CREATOR });
  assert.equal(p.afterCollect, FUND.toString());
  assert.equal(p.creator, CREATOR);
  const a = p.actions;
  assert.equal(a.supported, true);
  assert.equal(a.nft.available, true);
  assert.equal(a.nft.maxBps, 2500);
  assert.equal(a.nft.nextAt, new Date((NOW - 86400 + 30 * 86400) * 1000).toISOString(), 'one campaign per 30 days');
  assert.deepEqual(a.nft.collections.map((c) => [c.address, c.eligible, c.reason]), [
    [OFFICIAL, true, null],
    [FAN, false, 'Not official: only collections of the token’s creator'],
  ]);
  assert.equal(a.buyback.available, true);
  assert.equal(a.buyback.totalBurned, '547674079389430572709');

  const first = await communityPanel({ db: fakeDb(), client: () => panelClient({ lastNft: 0n }) }, CHAIN, VAULT, NOW);
  assert.equal(first.actions.nft.nextAt, null, 'no campaign yet: no cooldown');
  assert.equal(first.actions.nft.lastAt, null);

  const bare = await communityPanel({ db: fakeDb(), client: () => panelClient({ factory: ETH, guard: ETH }) }, CHAIN, VAULT, NOW);
  assert.equal(bare.actions.nft.available, false);
  assert.deepEqual(bare.actions.nft.collections, []);
  assert.equal(bare.actions.buyback.available, false);

  const old = await communityPanel({ db: fakeDb(), client: () => panelClient({ v031: false }) }, CHAIN, VAULT, NOW);
  assert.equal(old.actions.supported, false, 'a 0.3.0 pool keeps streams and staking only');
  assert.match(old.actions.reason, /0\.3\.1/);
  assert.equal(old.afterCollect, FUND.toString());
});

test('pool collections: free mints, empty and foreign collections cannot get a campaign; missing tables give none', async () => {
  const rows = [
    { ...COLLECTIONS[0], address: '0xa1', mint_price: '0' },
    { ...COLLECTIONS[0], address: '0xa2', total_minted: 0 },
    { ...COLLECTIONS[0], address: '0xa3', factory: '0xother' },
  ];
  const list = await poolNftCollections({ query: async () => rows }, CHAIN, TOKEN, FACTORY);
  assert.deepEqual(list.map((c) => c.reason), ['Free mint: only paid collections', 'Nothing minted yet', 'Made by another NFT factory']);
  assert.deepEqual(await poolNftCollections({ query: async () => Promise.reject(new Error('relation does not exist')) }, CHAIN, TOKEN, FACTORY), []);
});

/** A parsed log of the community vault, as viem's parseEventLogs returns it. */
function vaultLog(eventName, args, logIndex) {
  return { address: VAULT, eventName, args, blockNumber: 60_463_554n, logIndex, transactionHash: `0x${'6d'.repeat(32)}` };
}

test('indexer: buybackAndBurn and fundNftCampaign land in the pool log (launch_vault_events)', async () => {
  const rows = [];
  const q = async (sql, p) => {
    rows.push(p);
    return [];
  };
  const ctx = { chainId: CHAIN, d: { poolManager: '0x0' }, times: new Map(), tokens: new Map(), byVault: new Map(), byCommunity: new Map([[VAULT, { token: TOKEN }]]) };
  const stream = `0x${'fc'.repeat(32)}`;
  await applyLaunchLog(q, vaultLog('FundBurned', { fundAsset: ETH, amountIn: 1_086_560_820_255n, tokensBurned: 547_674_079_389_430_572_709n }, 1), ctx);
  await applyLaunchLog(q, vaultLog('FundCampaignCreated', { streamId: stream, kind: 0, rewardToken: TOKEN, rewardPerEpoch: 10n, epochCount: 30n, paid: 315n, isDefault: false }, 2), ctx);
  await applyLaunchLog(q, vaultLog('FundNftCampaignCreated', { streamId: stream, collection: OFFICIAL }, 3), ctx);
  const pick = (p) => ({ vault: p[3], token: p[4], kind: p[5], amount: p[6], amount2: p[7], account: p[8], ref: p[9] });
  assert.deepEqual(rows.map(pick), [
    { vault: VAULT, token: TOKEN, kind: 'fund_burned', amount: '1086560820255', amount2: '547674079389430572709', account: ETH, ref: null },
    { vault: VAULT, token: TOKEN, kind: 'fund_stream', amount: '10', amount2: '315', account: TOKEN, ref: stream },
    { vault: VAULT, token: TOKEN, kind: 'fund_nft_stream', amount: null, amount2: null, account: OFFICIAL, ref: stream },
  ]);
});
