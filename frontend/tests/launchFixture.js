// Shared fixture for the Place Launch tests: a B20/ETH launch and an ERC-20/USDC launch shaped like the L2
// live run on Base Sepolia, as raw logs from a fake node that answers the calls the indexer makes.
import { encodeAbiParameters, encodeEventTopics, parseEventLogs, toEventSelector } from 'viem';
import { PGlite } from '@electric-sql/pglite';
import { pgliteAdapter, migrate } from '../api/_lib/place/db.js';
import {
  LAUNCH_FACTORY_ABI,
  LAUNCH_OPERATIONS_EVENTS,
  LAUNCH_HOOK_ABI,
  CREATOR_VAULT_ABI,
  LAUNCH_TOKEN_ABI,
  POOL_MANAGER_ABI,
  ANNOUNCEMENT_REGISTRY_ABI,
  PLACE_STAKING_ABI,
  REWARD_TOKEN_REGISTRY_ABI,
  REWARDS_DISTRIBUTOR_ABI,
  COMMUNITY_VAULT_ABI,
  FEE_ESCROW_ABI,
} from '../src/launch/abi.js';
import {
  LEGACY_FACTORY_EVENTS,
  LEGACY_OPERATIONS_EVENTS,
  LEGACY_CREATOR_VAULT_ABI,
  V020_FACTORY_EVENTS,
  V020_OPERATIONS_EVENTS,
  V020_HOOK_EVENTS,
  V020_CREATOR_VAULT_ABI,
} from '../src/launch/abi.legacy.js';
import { launchReleases, launchDeployment } from '../src/launch/deployments.js';

export const CHAIN = 84532;
// The L2 launches below were made with 0.1.0; CUR is the 0.2.0 release (L5 run). Both are legacy now. NEXT is
// CUR is the 0.2.0 release; tests of the current one (0.3.0) give it fixture addresses with deploy030() first.
export const CUR = launchReleases(CHAIN).find((r) => r.version === '0.2.0-testnet');
export const NEXT = launchDeployment(CHAIN);
export const D = launchReleases(CHAIN).find((r) => r.version === '0.1.0-testnet');
export const ETH = '0x0000000000000000000000000000000000000000';
export const DEAD = '0x000000000000000000000000000000000000dead';
export const USDC = D.quotes.usdc;
export const CREATOR = '0x6bb35f78a2fe7fad0809d849a99b2e2b1c5e3134';
export const TRADER = '0xc3fa4c1e6fecc02be6de7440ff5b667719e8b892';
export const B20 = { token: '0xb200000000000000000000edee389ab594913e01', pool: '0x915b908ac32d11d2b09dd0d83896ab6d630e6b147dca270e3eccc2ceadec14cd', vault: '0x18b74a6ae4230454a46b1ca502b57bac6be072cb' };
export const ERC = { token: '0xb4f38e468f983611a1fb5574989be0e6a94efe01', pool: '0x4fa70b2a5f8fa84a3b2ec35dce12eda6e7849eed17b9a6b5657f1f34ac8d5484', vault: '0xd8aca3846a15a99a0dd92153164ef9d22292e013' };
export const B0 = 58280909n;
export const T0 = 1_794_578_040n; // a minute boundary
export const timeOf = (block) => T0 + (block - B0) / 5n; // 200 ms blocks
// rules/launch-holders-v1.json in place-contracts, byte for byte (its keccak is the vaults' rulesHash).
export const TEMPLATE =
  '{"claimDuration":2592000,"distribution":"proportional","exclude":"launch pool: PoolManager, PlaceLaunchHook, FeeEscrow, the creator vault and 0x000000000000000000000000000000000000dead","kind":"token-holders","leftover":"burn","minBalance":"1","note":"Template for holder campaigns started by a PlaceCreatorVault; per campaign, target = launch token, rewardToken = its pair, pool and snapshotAt come from the CampaignCreated event","rewardToken":"launch pair (quote) of the token","schema":"place.launch-rules/1","snapshotDelay":86400}';
export const SUPPLY = 10n ** 27n;
// Real sqrtPriceX96 values from the L2 run.
export const SQRT = {
  b20Init: 1797361575845028639913410322392517n,
  b20AfterDev: 1796446280680026189204988623606028n,
  b20AfterSell: 1796427245063906659329332100191960n,
  ercInit: 39569734776372747109332364130380419359n,
  ercAfterDev: 39559965594138685917755313364207274137n,
};

// Older generations first: a log takes the first event whose name and fields match its args.
const ABIS = [
  ...V020_FACTORY_EVENTS, ...V020_OPERATIONS_EVENTS, ...V020_HOOK_EVENTS, ...V020_CREATOR_VAULT_ABI,
  ...REWARDS_DISTRIBUTOR_ABI, ...COMMUNITY_VAULT_ABI, ...FEE_ESCROW_ABI,
  ...LAUNCH_FACTORY_ABI, ...LAUNCH_OPERATIONS_EVENTS, ...LAUNCH_HOOK_ABI, ...CREATOR_VAULT_ABI, ...LAUNCH_TOKEN_ABI, ...POOL_MANAGER_ABI,
  ...ANNOUNCEMENT_REGISTRY_ABI, ...PLACE_STAKING_ABI, ...REWARD_TOKEN_REGISTRY_ABI, ...LEGACY_FACTORY_EVENTS, ...LEGACY_OPERATIONS_EVENTS, ...LEGACY_CREATOR_VAULT_ABI,
].filter((x) => x.type === 'event');

export function logBuilder() {
  const logs = [];
  const senders = new Map();
  let txn = 0;
  let tx = null;
  let index = 0;
  return {
    logs,
    senders,
    /** Starts a transaction from `from` in `block`; following logs share its hash. */
    tx(block, from) {
      tx = { hash: `0x${(++txn).toString(16).padStart(64, 'a')}`, block };
      senders.set(tx.hash, from);
      index = 0;
      return tx.hash;
    },
    log(address, eventName, args) {
      const ev = ABIS.find((e) => e.name === eventName && e.inputs.length === Object.keys(args).length && e.inputs.every((i) => i.name in args));
      if (!ev) throw new Error(`no event ${eventName}`);
      const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
      const plain = ev.inputs.filter((i) => !i.indexed);
      logs.push({
        address,
        topics: encodeEventTopics({ abi: [ev], eventName, args: indexed }),
        data: encodeAbiParameters(plain, plain.map((i) => args[i.name])),
        blockNumber: tx.block,
        logIndex: index++,
        transactionHash: tx.hash,
        transactionIndex: 0,
        blockHash: `0x${'0'.repeat(64)}`,
        removed: false,
      });
    },
  };
}

/** The two L2-like launches and their trading, as logs. */
export function l2Logs() {
  const b = logBuilder();
  const F = D.factory;
  // pairs
  b.tx(B0 - 1000n, CREATOR);
  b.log(F, 'QuoteRegistered', { quoteToken: ETH, quoteDecimals: 18, startTickToken0Frame: -200600, revision: 1n });
  b.log(F, 'QuoteRegistered', { quoteToken: USDC, quoteDecimals: 6, startTickToken0Frame: -400600, revision: 1n });
  b.log(F, 'RewardsMinimumUpdated', { quoteToken: ETH, minimum: 10n ** 14n });

  // B20 launch with a 0.001 ETH dev buy (metadata and Initialize come before Launched)
  b.tx(B0, CREATOR);
  b.log(F, 'CreatorVaultCreated', { token: B20.token, vault: B20.vault, buybackBps: 2000, buybackBurn: true, rewardsBps: 6000 });
  b.log(D.poolManager, 'Initialize', { id: B20.pool, currency0: ETH, currency1: B20.token, fee: 0, tickSpacing: 200, hooks: D.hook, sqrtPriceX96: SQRT.b20Init, tick: 200600 });
  b.log(B20.token, 'Transfer', { from: ETH, to: D.hook, value: SUPPLY });
  b.log(B20.token, 'Transfer', { from: D.hook, to: D.poolManager, value: SUPPLY });
  b.log(F, 'B20ExtraMetadataUpdated', { token: B20.token, metadataKey: 'website', metadataValue: 'https://place-blond.vercel.app' });
  b.log(F, 'B20ExtraMetadataUpdated', { token: B20.token, metadataKey: 'x', metadataValue: 'https://x.com/place' });
  b.log(F, 'Launched', { token: B20.token, poolId: B20.pool, originalCreator: CREATOR, quoteToken: ETH, launchSupply: SUPPLY, tickSpacing: 200 });
  b.log(D.poolManager, 'Swap', { id: B20.pool, sender: D.launchBuyAdapter, amount0: -990000000000000n, amount1: 509243758909291886606726n, sqrtPriceX96: SQRT.b20AfterDev, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(D.hook, 'Trade', { poolId: B20.pool, executor: D.launchBuyAdapter, referrer: ETH, quoteCurrency: ETH, quoteFeeAmount: 10n ** 13n, comment: `0x${'0'.repeat(64)}` });
  b.log(B20.token, 'Transfer', { from: D.poolManager, to: CREATOR, value: 509243758909291886606726n });
  b.log(F, 'LaunchBuyExecuted', { token: B20.token, poolId: B20.pool, originalCreator: CREATOR, fundingToken: ETH, amountIn: 10n ** 15n, amountOut: 509243758909291886606726n, launchBuyAdapter: D.launchBuyAdapter });

  // ERC-20 / USDC launch, 40 blocks (8 s) later, without metadata events of its own
  b.tx(B0 + 40n, CREATOR);
  b.log(F, 'CreatorVaultCreated', { token: ERC.token, vault: ERC.vault, buybackBps: 3000, buybackBurn: false, rewardsBps: 4000 });
  b.log(D.poolManager, 'Initialize', { id: ERC.pool, currency0: USDC, currency1: ERC.token, fee: 0, tickSpacing: 200, hooks: D.hook, sqrtPriceX96: SQRT.ercInit, tick: 400600 });
  b.log(ERC.token, 'Transfer', { from: ETH, to: D.hook, value: SUPPLY });
  b.log(ERC.token, 'ExtraMetadataUpdated', { updater: D.factory, metadataKey: 'telegram', metadataValue: 'https://t.me/place' });
  b.log(F, 'Launched', { token: ERC.token, poolId: ERC.pool, originalCreator: CREATOR, quoteToken: USDC, launchSupply: SUPPLY, tickSpacing: 200 });
  b.log(D.poolManager, 'Swap', { id: ERC.pool, sender: D.launchBuyAdapter, amount0: -990000n, amount1: 246885208841339286396836n, sqrtPriceX96: SQRT.ercAfterDev, liquidity: 1n, tick: 400595, fee: 0 });

  // B20: the trader buys a minute later and sells half two minutes later
  b.tx(B0 + 300n, TRADER);
  b.log(D.poolManager, 'Swap', { id: B20.pool, sender: D.universalRouter, amount0: -198000000000000n, amount1: 101784362118681938915860n, sqrtPriceX96: SQRT.b20AfterDev - 10n ** 28n, liquidity: 1n, tick: 200588, fee: 0 });
  b.log(D.hook, 'Trade', { poolId: B20.pool, executor: D.universalRouter, referrer: ETH, quoteCurrency: ETH, quoteFeeAmount: 2n * 10n ** 12n, comment: `0x${'0'.repeat(64)}` });
  b.log(B20.token, 'Transfer', { from: D.poolManager, to: TRADER, value: 101784362118681938915860n });
  b.tx(B0 + 900n, TRADER);
  b.log(B20.token, 'Transfer', { from: TRADER, to: D.poolManager, value: 50892181059340969457930n });
  b.log(D.poolManager, 'Swap', { id: B20.pool, sender: D.universalRouter, amount0: 98000000000000n, amount1: -50892181059340969457930n, sqrtPriceX96: SQRT.b20AfterSell, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(D.hook, 'Trade', { poolId: B20.pool, executor: D.universalRouter, referrer: ETH, quoteCurrency: ETH, quoteFeeAmount: 10n ** 12n, comment: `0x${'0'.repeat(64)}` });

  // B20 vault: collect, buyback-and-burn at claim, creator paid, a rewards campaign; rename; announcement
  b.tx(B0 + 1200n, CREATOR);
  b.log(B20.vault, 'Collected', { amount: 275584500000001n, toBuyback: 55116900000000n, toRewards: 165350700000000n, toX: 0n, toCreator: 55116900000001n });
  b.log(B20.vault, 'RewardsCampaignStarted', { campaignId: 1n, pool: 165350700000000n, paid: 165350700000000n, caller: CREATOR });
  b.tx(B0 + 1205n, CREATOR);
  b.log(D.poolManager, 'Swap', { id: B20.pool, sender: B20.vault, amount0: -55116900000000n, amount1: 28044287166493768656910n, sqrtPriceX96: SQRT.b20AfterSell - 10n ** 27n, liquidity: 1n, tick: 200589, fee: 0 });
  b.log(B20.token, 'Transfer', { from: D.poolManager, to: DEAD, value: 28044287166493768656910n });
  b.log(B20.vault, 'BoughtBack', { quoteIn: 55116900000000n, tokenOut: 28044287166493768656910n, destination: DEAD });
  b.log(B20.vault, 'CreatorPaid', { payout: CREATOR, amount: 55116900000001n });
  b.log(B20.token, 'NameUpdated', { updater: D.factory, newName: 'Place L2 B20 Renamed' });
  b.log(D.announcementRegistry, 'AnnouncementPosted', { token: B20.token, creator: CREATOR, announcementId: `0x${'11'.repeat(32)}`, description: 'gm', announcementURI: 'ipfs://x' });
  return b;
}

/** A fake node: raw getLogs by address, decoded getLogs by event + pool ids, reads for new tokens. */
export function fakeNode({ logs, senders, head, onMulticall }) {
  const calls = { getLogs: 0, getTransaction: 0 };
  const lower = (a) => a.toLowerCase();
  return {
    calls,
    async getBlockNumber() {
      return head;
    },
    async getBlock({ blockNumber }) {
      return { number: blockNumber, timestamp: timeOf(blockNumber) };
    },
    async getTransaction({ hash }) {
      calls.getTransaction++;
      return { hash, from: senders.get(hash) };
    },
    async getLogs({ address, event, args, fromBlock, toBlock }) {
      calls.getLogs++;
      const inRange = logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      if (event) {
        const sel = toEventSelector(event);
        const ids = (args?.id || []).map(lower);
        const raw = inRange.filter((l) => lower(l.address) === lower(address) && l.topics[0] === sel && ids.includes(lower(l.topics[1])));
        return parseEventLogs({ abi: [event], logs: raw });
      }
      const set = new Set((Array.isArray(address) ? address : [address]).map(lower));
      return inRange.filter((l) => set.has(lower(l.address)));
    },
    async multicall({ contracts }) {
      if (onMulticall) return onMulticall(contracts);
      return contracts.map((c) => {
        const t = String(c.args?.[0] || c.address).toLowerCase();
        const isB20 = t === B20.token || c.address === B20.token;
        if (c.address === USDC && ['name', 'symbol'].includes(c.functionName)) return { status: 'success', result: 'USDC' };
        switch (c.functionName) {
          case 'launchTokenKind':
            return { status: 'success', result: t === B20.token ? 2 : 1 };
          case 'creatorRights':
            return { status: 'success', result: { originalCreator: CREATOR, currentCreator: CREATOR, pendingCreator: ETH, creatorFeeRecipient: t === B20.token ? B20.vault : ERC.vault, poolId: t === B20.token ? B20.pool : ERC.pool, metadataEditable: true } };
          case 'name':
            return { status: 'success', result: isB20 ? 'Place L2 B20' : 'Place L2 ERC20' };
          case 'symbol':
            return { status: 'success', result: isB20 ? 'PL2B' : 'PL2E' };
          case 'contractURI':
            return { status: 'success', result: 'https://place-blond.vercel.app/launch/l2-test.json' };
          case 'xShares':
            return { status: 'success', result: [] };
          case 'decimals':
            return { status: 'success', result: c.address === USDC ? 6 : 18 };
          case 'supportsInterface':
            return { status: 'success', result: false };
          default:
            return { status: 'failure', error: new Error(`unexpected ${c.functionName}`) };
        }
      });
    },
  };
}

export async function freshDb() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  return db;
}

// Made-up 0.3.0 addresses for tests until the release is deployed (V6). PlaceStaking is reused from 0.2.0.
const a3 = (tail) => `0x3${'0'.repeat(35)}${tail}`;
export const V3 = {
  startBlock: 59_000_000n,
  factory: a3('0f01'),
  hook: a3('0acc'),
  feeEscrow: a3('0e5c'),
  creatorVaultImplementation: a3('0c01'),
  communityVaultImplementation: a3('0c02'),
  rewardsDistributor: a3('0d15'),
  rewardTokenRegistry: a3('0a11'),
  staking: '0x1390719ddd7a3f597abcdd8b48bcc7dc465220df',
  xRecipientRegistry: a3('0b0b'),
  launchBuyAdapter: a3('0bad'),
  announcementRegistry: a3('0a00'),
  tokenDeployer: a3('0de9'),
};

/** Gives the current release (0.3.0) the V3 test addresses; returns a function that restores the placeholders. */
/** Puts the current release back to its state before the deploy: `deployed: false` and null addresses. */
export function undeploy030() {
  const d = launchDeployment(CHAIN);
  const keys = [...Object.keys(V3), 'deployed'];
  const saved = Object.fromEntries(keys.map((k) => [k, d[k]]));
  Object.assign(d, Object.fromEntries(Object.keys(V3).map((k) => [k, null])), { deployed: false });
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete d[k];
      else d[k] = saved[k];
    }
  };
}

export function deploy030() {
  const d = launchDeployment(CHAIN);
  const saved = Object.fromEntries([...Object.keys(V3), 'deployed'].map((k) => [k, d[k]]));
  Object.assign(d, V3, { deployed: true });
  return () => Object.assign(d, saved);
}
