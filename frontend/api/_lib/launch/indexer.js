// Place Launch indexer: the launchpad's events, read inside the hub indexer's range loop with the same cursor
// (place/indexer.js calls collectLaunchLogs for every range, then applies hub and launch events together in
// block order, in one transaction).
//
// Two passes per range:
// 1. the static contracts (factory, hook, announcements, X registry, staking, reward routes, and for 0.3.0 the
//    FeeEscrow and the rewards distributor) come with the hub's own getLogs; a Launched there introduces a
//    token, its vaults and its pool id;
// 2. dynamic sources for the same range: every known launch token (Transfer, metadata), creator vault and
//    community vault, and the PoolManager's Swap/Initialize filtered by the launch pool ids. Newly found tokens
//    join this pass, so the launch transaction's own transfers and dev-buy swap are never missed.
// Swaps get their trader (the transaction sender, since the router is the PoolManager caller) and block time.
// Every write is idempotent: totals change only when the row keyed by (block, log_index) is new.
//
// Releases (src/launch/deployments.js) are read side by side, each with the ABI of its generation:
//   1 = 0.1.0 (buyback / rewards vault), 2 = 0.2.0 (burn / community fund vault, process()),
//   3 = 0.3.0 (Standard / Economy, five baskets, FeeEscrow burn, PlaceRewardsDistributor, PlaceCommunityVault).
// Some events keep their name but change their fields between generations (Collected, Trade, CreatorVaultCreated).
import { parseEventLogs, parseAbi, keccak256, encodeAbiParameters } from 'viem';
import {
  LAUNCH_FACTORY_ABI,
  LAUNCH_OPERATIONS_EVENTS,
  LAUNCH_HOOK_ABI,
  CREATOR_VAULT_ABI,
  COMMUNITY_VAULT_ABI,
  FEE_ESCROW_ABI,
  REWARDS_DISTRIBUTOR_ABI,
  ANNOUNCEMENT_REGISTRY_ABI,
  X_RECIPIENT_REGISTRY_ABI,
  LAUNCH_TOKEN_ABI,
  POOL_MANAGER_ABI,
  PLACE_STAKING_ABI,
  REWARD_TOKEN_REGISTRY_ABI,
} from '../../../src/launch/abi.js';
import {
  LEGACY_FACTORY_EVENTS,
  LEGACY_OPERATIONS_EVENTS,
  LEGACY_CREATOR_VAULT_ABI,
  V020_FACTORY_EVENTS,
  V020_FACTORY_READS,
  V020_OPERATIONS_EVENTS,
  V020_HOOK_EVENTS,
  V020_CREATOR_VAULT_ABI,
} from '../../../src/launch/abi.legacy.js';
import { launchDeployment, launchReleases, deployedReleases, launchStartBlock } from '../../../src/launch/deployments.js';
import { priceFromSqrt, swapSide } from '../../../src/launch/market.js';
import { retry } from '../place/chain.js';

const ADDRESS_CHUNK = Number(process.env.PLACE_LOGS_MAX_ADDRESSES || 10); // free log nodes allow 10 addresses per eth_getLogs
const TOPIC_CHUNK = 100;
const RPC_CHUNK = 50;
const ZERO = '0x0000000000000000000000000000000000000000';
const KIND = { 1: 'erc20', 2: 'b20' };
export const EPOCH = 86_400;

const events = (abi) => abi.filter((x) => x.type === 'event');

/** Which ABI generation a release version uses: 1 (0.1.x), 2 (0.2.x), 3 (0.3.0 and later). */
export function releaseGeneration(version) {
  const v = String(version || '');
  if (v.startsWith('0.1.')) return 1;
  if (v.startsWith('0.2.')) return 2;
  return 3;
}

const SHARED = [...events(ANNOUNCEMENT_REGISTRY_ABI), ...events(X_RECIPIENT_REGISTRY_ABI)];
const GEN = {
  1: { factory: [...LEGACY_FACTORY_EVENTS, ...LEGACY_OPERATIONS_EVENTS], hook: V020_HOOK_EVENTS, vault: events(LEGACY_CREATOR_VAULT_ABI) },
  2: { factory: [...V020_FACTORY_EVENTS, ...V020_OPERATIONS_EVENTS], hook: V020_HOOK_EVENTS, vault: events(V020_CREATOR_VAULT_ABI) },
  3: {
    factory: [...events(LAUNCH_FACTORY_ABI), ...LAUNCH_OPERATIONS_EVENTS],
    hook: events(LAUNCH_HOOK_ABI),
    vault: events(CREATOR_VAULT_ABI),
    community: events(COMMUNITY_VAULT_ABI),
    escrow: events(FEE_ESCROW_ABI),
    distributor: events(REWARDS_DISTRIBUTOR_ABI),
  },
};
const STAKING_EVENTS = events(PLACE_STAKING_ABI);
const REGISTRY_EVENTS = events(REWARD_TOKEN_REGISTRY_ABI).filter((e) => e.name.startsWith('Route'));
const TOKEN_EVENTS = events(LAUNCH_TOKEN_ABI);
const PM_EVENTS = events(POOL_MANAGER_ABI);
const SWAP = PM_EVENTS.find((e) => e.name === 'Swap');
const INIT = PM_EVENTS.find((e) => e.name === 'Initialize');
// Reads every generation shares (same signature): token kind and creator rights.
const FACTORY_READS = V020_FACTORY_READS;
const TAX_KINDS = { ProtocolFeeCredited: 'protocol', AntiSnipeFeeCredited: 'anti_snipe', CreatorTaxCredited: 'creator', CommunityTaxCredited: 'community', BurnTaxCredited: 'burn', RewardTaxCredited: 'reward' };

const READ_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function contractURI() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const lower = (a) => (a == null ? a : String(a).toLowerCase());
const iso = (seconds) => new Date(Number(seconds) * 1000).toISOString();
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const chunks = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const byOrder = (a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

/** PlaceRewardsDistributor.economyStreamId(token, kind): the stream (and FeeEscrow account) of a launch basket. */
export function economyStreamId(token, kind) {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }], [token, Number(kind)]));
}

/** Static launch contracts of every deployed release whose logs come with the hub's getLogs. */
export function launchStaticAddresses(chainId) {
  const out = [];
  for (const r of deployedReleases(chainId)) {
    const gen = releaseGeneration(r.version);
    out.push(r.factory, r.hook, r.announcementRegistry, r.xRecipientRegistry);
    if (gen >= 2) out.push(r.staking, r.rewardTokenRegistry);
    if (gen >= 3) out.push(r.feeEscrow, r.rewardsDistributor);
  }
  return [...new Set(out.filter(Boolean))];
}

/** The block each static launch contract is indexed from: its release's start block (the earliest when reused). */
export function launchStaticStarts(chainId) {
  const out = new Map();
  for (const r of deployedReleases(chainId)) {
    if (r.startBlock == null) continue;
    const gen = releaseGeneration(r.version);
    const list = [r.factory, r.hook, r.announcementRegistry, r.xRecipientRegistry];
    if (gen >= 2) list.push(r.staking, r.rewardTokenRegistry);
    if (gen >= 3) list.push(r.feeEscrow, r.rewardsDistributor);
    for (const a of list.filter(Boolean).map((x) => x.toLowerCase())) {
      if (!out.has(a) || r.startBlock < out.get(a)) out.set(a, r.startBlock);
    }
  }
  return out;
}

/** Every rewards distributor, creator / community vault of the indexed releases: not traders, not holders. */
export function distributorAddresses(chainId) {
  return [...new Set(deployedReleases(chainId).map((r) => r.rewardsDistributor).filter(Boolean))];
}

/** Decodes static logs, each with its own release's ABI, and tags them with that release. */
function decodeStatic(chainId, logs) {
  const out = [];
  const taken = new Set();
  for (const r of deployedReleases(chainId)) {
    const gen = GEN[releaseGeneration(r.version)];
    const take = (addrs, abi) => {
      const set = new Set(addrs.filter((a) => a && !taken.has(a)));
      if (!set.size) return;
      set.forEach((a) => taken.add(a));
      const mine = logs.filter((l) => set.has(lower(l.address)));
      if (!mine.length) return;
      for (const l of parseEventLogs({ abi, logs: mine, strict: false })) if (l.eventName) out.push(Object.assign(l, { release: r }));
    };
    take([r.factory], gen.factory);
    take([r.hook], gen.hook);
    take([r.announcementRegistry, r.xRecipientRegistry], SHARED);
    if (r.staking) take([r.staking], STAKING_EVENTS);
    if (r.rewardTokenRegistry) take([r.rewardTokenRegistry], REGISTRY_EVENTS);
    if (gen.escrow && r.feeEscrow) take([r.feeEscrow], gen.escrow);
    if (gen.distributor && r.rewardsDistributor) take([r.rewardsDistributor], gen.distributor);
  }
  return out;
}

/**
 * Decodes the launch part of one range and fetches what it needs (dynamic logs, new token info, block
 * times, swap senders). `staticLogs` are the raw logs the hub indexer already got for the static addresses.
 * Returns { logs (decoded, sorted), ctx } for applyLaunchLog; logs is empty when nothing happened.
 */
export async function collectLaunchLogs({ db, client, chainId, fromBlock, toBlock, staticLogs }) {
  const d = launchDeployment(chainId);
  const start = launchStartBlock(chainId);
  if (!d || start == null || toBlock < start) return { logs: [], ctx: null };
  const releases = launchReleases(chainId);
  const oldest = releases.find((r) => releaseGeneration(r.version) === 1)?.version ?? releases[releases.length - 1].version;
  const decoded = decodeStatic(chainId, staticLogs);

  // New launches in this range: token, pool, vaults, economics, then what the chain says about them.
  const fresh = new Map();
  const put = (t, v) => fresh.set(t, { ...(fresh.get(t) || {}), ...v });
  for (const l of decoded) {
    if (lower(l.address) !== l.release.factory) continue;
    const t = lower(l.args.token);
    const gen = releaseGeneration(l.release.version);
    switch (l.eventName) {
      case 'Launched':
        put(t, { token: t, version: l.release.version, gen, release: l.release, poolId: lower(l.args.poolId), creator: lower(l.args.originalCreator), quote: lower(l.args.quoteToken), supply: l.args.launchSupply, tickSpacing: Number(l.args.tickSpacing), block: l.blockNumber, tx: lower(l.transactionHash) });
        break;
      case 'CreatorVaultCreated':
        if (gen === 1) put(t, { vault: lower(l.args.vault), buybackBps: Number(l.args.buybackBps), buybackBurn: l.args.buybackBurn, rewardsBps: Number(l.args.rewardsBps) });
        else if (gen === 2) put(t, { vault: lower(l.args.vault), burnBps: Number(l.args.burnBps), communityBps: Number(l.args.communityBps) });
        else put(t, { vault: lower(l.args.vault) });
        break;
      case 'CommunityVaultCreated':
        put(t, { communityVault: lower(l.args.vault) });
        break;
      case 'LaunchEconomyConfigured':
        put(t, {
          economy: {
            launchType: Number(l.args.launchType) === 1 ? 'economy' : 'standard',
            creatorVault: lower(l.args.creatorVault),
            communityVault: l.args.communityVault === ZERO ? null : lower(l.args.communityVault),
            rewardToken: lower(l.args.rewardToken),
            minHolding: l.args.minHolding,
            minTraderDailyVolume: l.args.minTraderDailyVolume,
          },
        });
        break;
      case 'LaunchTaxConfigured':
        if (gen >= 3) put(t, { tax: l.args.taxConfiguration, antiSnipe: l.args.antiSnipeEnabled, configVersion: l.args.configVersion });
        break;
      default:
        break;
    }
  }
  const newTokens = [...fresh.values()].filter((t) => t.poolId);
  if (newTokens.length) await readNewTokens(client, newTokens);

  // Tokens indexed before launch_economy existed are 0.1.0 (the only release then).
  const known = await db.query(
    `select t.token, t.pool_id, t.vault, t.quote, t.token_is_currency0, coalesce(q.decimals, 18) as quote_decimals, e.version, e.community_vault
     from launch_tokens t left join launch_quotes q on q.chain_id = t.chain_id and q.quote = t.quote
     left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1`,
    [chainId]
  );
  const tokens = new Map(
    known.map((r) => {
      const version = r.version || oldest;
      return [r.token, { token: r.token, poolId: r.pool_id, vault: r.vault, communityVault: r.community_vault || null, quote: r.quote, tokenIsCurrency0: r.token_is_currency0, quoteDecimals: Number(r.quote_decimals), version, gen: releaseGeneration(version) }];
    })
  );
  const quoteDecimals = new Map((await db.query('select quote, decimals from launch_quotes where chain_id = $1', [chainId])).map((r) => [r.quote, Number(r.decimals)]));
  for (const l of decoded) if (l.eventName === 'QuoteRegistered') quoteDecimals.set(lower(l.args.quoteToken), Number(l.args.quoteDecimals));
  for (const t of newTokens) {
    tokens.set(t.token, { token: t.token, poolId: t.poolId, vault: t.vault, communityVault: t.communityVault ?? t.economy?.communityVault ?? null, quote: t.quote, tokenIsCurrency0: t.tokenIsCurrency0, quoteDecimals: quoteDecimals.get(t.quote) ?? 18, version: t.version, gen: t.gen });
  }

  let dynamic = [];
  if (tokens.size) {
    const list = [...tokens.values()];
    const addrs = [...list.map((t) => t.token), ...list.map((t) => t.vault).filter(Boolean), ...list.map((t) => t.communityVault).filter(Boolean)];
    const raw = [];
    for (const part of chunks(addrs, ADDRESS_CHUNK)) raw.push(...(await client.getLogs({ address: part, fromBlock, toBlock })));
    dynamic.push(...parseEventLogs({ abi: TOKEN_EVENTS, logs: raw.filter((l) => tokens.has(lower(l.address))), strict: false }));
    for (const gen of new Set(list.map((t) => t.gen))) {
      const vaults = new Set(list.filter((t) => t.vault && t.gen === gen).map((t) => t.vault));
      const mine = raw.filter((l) => vaults.has(lower(l.address)));
      if (mine.length) dynamic.push(...parseEventLogs({ abi: GEN[gen].vault, logs: mine, strict: false }));
    }
    const community = new Set(list.map((t) => t.communityVault).filter(Boolean));
    const cmine = raw.filter((l) => community.has(lower(l.address)));
    if (cmine.length) dynamic.push(...parseEventLogs({ abi: GEN[3].community, logs: cmine, strict: false }));
    for (const ids of chunks(list.map((t) => t.poolId), TOPIC_CHUNK)) {
      dynamic.push(...(await client.getLogs({ address: d.poolManager, event: SWAP, args: { id: ids }, fromBlock, toBlock })));
    }
    for (const ids of chunks(newTokens.map((t) => t.poolId), TOPIC_CHUNK)) {
      dynamic.push(...(await client.getLogs({ address: d.poolManager, event: INIT, args: { id: ids }, fromBlock, toBlock })));
    }
    dynamic = dynamic.filter((l) => l.eventName);
  }

  const logs = [...decoded, ...dynamic].sort(byOrder);
  if (!logs.length) return { logs, ctx: null };
  for (const l of logs) l.launch = true;

  // A launch transaction emits metadata, Initialize and the dev-buy swap around Launched, some of them before
  // it: new tokens get their opening price and metadata here and are inserted before any log is applied.
  for (const l of logs) {
    if (l.eventName === 'Initialize') {
      const t = newTokens.find((x) => x.poolId === lower(l.args.id));
      if (t) t.initSqrtPrice = l.args.sqrtPriceX96;
    } else if (l.eventName === 'B20ExtraMetadataUpdated' || l.eventName === 'ExtraMetadataUpdated') {
      const t = fresh.get(lower(l.eventName === 'B20ExtraMetadataUpdated' ? l.args.token : l.address));
      if (t) t.extra = { ...(t.extra || {}), [l.args.metadataKey]: l.args.metadataValue };
    }
  }

  const untimed = new Set(['Transfer', 'NameUpdated', 'ContractURIUpdated', 'ExtraMetadataUpdated', 'B20ExtraMetadataUpdated', 'Initialize']);
  const times = await blockTimes(client, [...new Set(logs.filter((l) => !untimed.has(l.eventName)).map((l) => l.blockNumber))]);
  const senders = await txSenders(client, [...new Set(logs.filter((l) => l.eventName === 'Swap').map((l) => l.transactionHash))]);
  const all = [...tokens.values()];
  const byPool = new Map(all.map((t) => [t.poolId, t]));
  const byVault = new Map(all.filter((t) => t.vault).map((t) => [t.vault, t]));
  const byCommunity = new Map(all.filter((t) => t.communityVault).map((t) => [t.communityVault, t]));
  // Swaps of these executors are the platform's own (reward conversions, fund swaps): no trader rewards.
  const notTraders = new Set([...distributorAddresses(chainId), ...byVault.keys(), ...byCommunity.keys()]);
  return { logs, ctx: { chainId, d, fresh, times, senders, byPool, byVault, byCommunity, tokens, notTraders } };
}

/** Kind, editability, name, symbol and contract URI of new launch tokens; their vault's X shares. */
async function readNewTokens(client, list) {
  // launchTokenKind, creatorRights and xShares have the same signature in every release.
  const calls = list.flatMap((t) => [
    { address: t.release.factory, abi: FACTORY_READS, functionName: 'launchTokenKind', args: [t.token] },
    { address: t.release.factory, abi: FACTORY_READS, functionName: 'creatorRights', args: [t.token] },
    { address: t.token, abi: READ_ABI, functionName: 'name' },
    { address: t.token, abi: READ_ABI, functionName: 'symbol' },
    { address: t.token, abi: READ_ABI, functionName: 'contractURI' },
    t.vault ? { address: t.vault, abi: CREATOR_VAULT_ABI, functionName: 'xShares' } : { address: t.token, abi: READ_ABI, functionName: 'decimals' },
  ]);
  const res = await retry(() => client.multicall({ contracts: calls, allowFailure: true }));
  list.forEach((t, i) => {
    const [kind, rights, name, symbol, uri, x] = res.slice(6 * i, 6 * i + 6).map((r) => (r.status === 'success' ? r.result : null));
    t.kind = KIND[Number(kind)] || (t.token.startsWith('0xb2000000000000000000') ? 'b20' : 'erc20');
    t.metadataEditable = rights ? rights.metadataEditable : null;
    t.currentCreator = rights ? lower(rights.currentCreator) : t.creator;
    t.name = name;
    t.symbol = symbol;
    t.contractURI = uri;
    t.xShares = t.vault && Array.isArray(x) ? x.map((s) => ({ xId: s.xId.toString(), bps: Number(s.bps) })) : [];
    // Uniswap sorts currencies by address; ETH (zero) always comes first.
    t.tokenIsCurrency0 = t.token < t.quote;
  });
}

async function blockTimes(client, blocks) {
  const times = new Map();
  for (const part of chunks(blocks, RPC_CHUNK)) {
    const got = await Promise.all(part.map((n) => retry(() => client.getBlock({ blockNumber: n }))));
    got.forEach((b) => times.set(b.number, b.timestamp));
  }
  return times;
}

async function txSenders(client, hashes) {
  const out = new Map();
  for (const part of chunks(hashes, RPC_CHUNK)) {
    const got = await Promise.all(part.map((hash) => retry(() => client.getTransaction({ hash }))));
    got.forEach((t) => out.set(lower(t.hash), lower(t.from)));
  }
  return out;
}

/** Inserts this range's new launches. Call it first in the range's transaction, before applyLaunchLog. */
export async function insertFreshTokens(q, ctx) {
  for (const t of ctx.fresh.values()) {
    if (!t.poolId) continue;
    const init = t.initSqrtPrice ?? null;
    const quoteDecimals = ctx.tokens.get(t.token)?.quoteDecimals ?? 18;
    await q(
      `insert into launch_tokens (chain_id, token, kind, pool_id, quote, token_is_currency0, tick_spacing, launch_supply, original_creator,
         current_creator, vault, buyback_bps, buyback_burn, rewards_bps, x_shares, metadata_editable, name, symbol, contract_uri, extra,
         init_sqrt_price, sqrt_price, price, created_block, created_tx, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21, $22, $23, $24, $25)
       on conflict (chain_id, token) do nothing`,
      [
        ctx.chainId, t.token, t.kind, t.poolId, t.quote, t.tokenIsCurrency0, t.tickSpacing, t.supply.toString(), t.creator,
        t.currentCreator || t.creator, t.vault ?? null, t.buybackBps ?? null, t.buybackBurn ?? null, t.rewardsBps ?? null, json(t.xShares || []),
        t.metadataEditable, t.name, t.symbol, t.contractURI, JSON.stringify(t.extra || {}),
        init?.toString() ?? null, init ? priceFromSqrt(init, t.tokenIsCurrency0, quoteDecimals) : null,
        t.block.toString(), t.tx, iso(ctx.times.get(t.block) ?? 0n),
      ]
    );
    const e = t.economy;
    const x = t.tax;
    await q(
      `insert into launch_economy (chain_id, token, version, burn_bps, community_bps, updated_block, launch_type, config_version, buy_tax_rate,
         sell_tax_rate, creator_share, holders_share, traders_share, burn_share, community_share, min_holding, min_trader_volume, reward_token,
         creator_vault, community_vault, anti_snipe)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       on conflict (chain_id, token) do nothing`,
      [
        ctx.chainId, t.token, t.version, t.burnBps ?? null, t.communityBps ?? null, t.block.toString(),
        e?.launchType ?? null, t.configVersion?.toString() ?? null,
        x ? Number(x.buyTaxRate) : null, x ? Number(x.sellTaxRate) : null, x ? Number(x.creatorAllocationShare) : null, x ? Number(x.holderAllocationShare) : null,
        x ? Number(x.traderAllocationShare) : null, x ? Number(x.burnAllocationShare) : null, x ? Number(x.communityAllocationShare) : null,
        e ? e.minHolding.toString() : null, e ? e.minTraderDailyVolume.toString() : null, e ? e.rewardToken : null,
        e?.creatorVault ?? (t.gen >= 3 ? t.vault ?? null : null), e?.communityVault ?? t.communityVault ?? null, t.antiSnipe ?? null,
      ]
    );
  }
}

/** Applies one decoded launch event. `q` is the transaction's query function. */
export async function applyLaunchLog(q, log, ctx) {
  const { chainId, d } = ctx;
  const a = log.args;
  const addr = lower(log.address);
  const block = log.blockNumber.toString();
  const at = () => iso(ctx.times.get(log.blockNumber) ?? 0n);
  const key = [chainId, block, log.logIndex];

  // Uniswap v4 PoolManager
  if (addr === d.poolManager) {
    const t = ctx.byPool.get(lower(a.id));
    if (!t) return;
    if (log.eventName === 'Initialize') {
      const price = priceFromSqrt(a.sqrtPriceX96, t.tokenIsCurrency0, t.quoteDecimals);
      await q(
        `update launch_tokens set init_sqrt_price = $3, sqrt_price = coalesce(sqrt_price, $3), tick = coalesce(tick, $4), price = coalesce(price, $5)
         where chain_id = $1 and token = $2`,
        [chainId, t.token, a.sqrtPriceX96.toString(), Number(a.tick), price]
      );
      return;
    }
    if (log.eventName !== 'Swap') return;
    const s = swapSide(a, t.tokenIsCurrency0);
    const price = priceFromSqrt(a.sqrtPriceX96, t.tokenIsCurrency0, t.quoteDecimals);
    const inserted = await q(
      `insert into launch_swaps (chain_id, block, log_index, token, tx, at, trader, router, side, token_amount, quote_amount, price, sqrt_price, tick)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict do nothing returning token`,
      [...key, t.token, lower(log.transactionHash), at(), ctx.senders.get(lower(log.transactionHash)) ?? null, lower(a.sender), s.side, s.tokenAmount.toString(), s.quoteAmount.toString(), price, a.sqrtPriceX96.toString(), Number(a.tick)]
    );
    if (inserted.length) {
      await q(
        `update launch_tokens set sqrt_price = $3, tick = $4, price = $5, quote_reserve = quote_reserve + $6::numeric,
           token_out = token_out + $7::numeric, swaps = swaps + 1, last_trade_at = $8 where chain_id = $1 and token = $2`,
        [chainId, t.token, a.sqrtPriceX96.toString(), Number(a.tick), price, s.quoteIn.toString(), s.tokenOut.toString(), at()]
      );
    }
    return;
  }

  // Launch tokens (ERC-20 and B20 share these signatures)
  const token = ctx.tokens.get(addr);
  if (token) {
    switch (log.eventName) {
      case 'Transfer': {
        const inserted = await q(
          `insert into launch_transfers (chain_id, block, log_index, token, from_addr, to_addr, amount, tx)
           values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning token`,
          [...key, addr, lower(a.from), lower(a.to), a.value.toString(), lower(log.transactionHash)]
        );
        if (!inserted.length) return;
        for (const [account, delta] of [
          [lower(a.from), -a.value],
          [lower(a.to), a.value],
        ]) {
          if (account === ZERO) continue;
          await q(
            `insert into launch_balances (chain_id, token, account, balance) values ($1, $2, $3, $4)
             on conflict (chain_id, token, account) do update set balance = launch_balances.balance + excluded.balance`,
            [chainId, addr, account, delta.toString()]
          );
        }
        return;
      }
      case 'NameUpdated':
        await q('update launch_tokens set name = $3 where chain_id = $1 and token = $2', [chainId, addr, a.newName]);
        return;
      case 'ContractURIUpdated':
        await q('update launch_tokens set contract_uri = $3 where chain_id = $1 and token = $2', [chainId, addr, a.newContractURI]);
        return;
      case 'ExtraMetadataUpdated':
        await setExtra(q, chainId, addr, a.metadataKey, a.metadataValue);
        return;
      default:
        return;
    }
  }

  // Creator vaults and (0.3.0) community vaults share launch_vault_events, told apart by the vault address.
  const owner = ctx.byVault.get(addr) || ctx.byCommunity.get(addr);
  if (owner) {
    const row = (kind, amount, amount2, account, ref, data) =>
      q(
        `insert into launch_vault_events (chain_id, block, log_index, vault, token, kind, amount, amount2, account, ref, data, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing`,
        [...key, addr, owner.token, kind, amount?.toString() ?? null, amount2?.toString() ?? null, lower(account) ?? null, ref?.toString() ?? null, data ? json(data) : null, lower(log.transactionHash), at()]
      );
    switch (log.eventName) {
      case 'Collected':
        if ('toBurn' in a) return row('collected', a.amount, null, null, null, { toBurn: a.toBurn, toCommunity: a.toCommunity, toX: a.toX, toCreator: a.toCreator });
        if ('toBuyback' in a) return row('collected', a.amount, null, null, null, { toBuyback: a.toBuyback, toRewards: a.toRewards, toX: a.toX, toCreator: a.toCreator });
        if ('toX' in a) return row('collected', a.amount, null, null, null, { toX: a.toX, toCreator: a.toCreator });
        return row('fund_collected', a.amount); // PlaceCommunityVault.collect()
      case 'Burned':
        return row('burned', a.quoteIn, a.tokenOut, a.caller);
      case 'FundSwapped':
        return row('fund_swapped', a.amountIn, a.amountOut, null, null, { fundAsset: lower(a.fundAsset), rewardToken: lower(a.rewardToken) });
      case 'FundCampaignCreated':
        if ('streamId' in a) {
          return row('fund_stream', a.rewardPerEpoch, a.paid, a.rewardToken, lower(a.streamId), { kind: Number(a.kind), epochCount: a.epochCount, isDefault: a.isDefault });
        }
        return row('fund_campaign', a.pool, a.paid, a.rewardToken, a.campaignId, { isDefault: a.isDefault });
      case 'FundStakingCreated':
        return row('fund_staking', a.paid, a.rewardPerEpoch, a.rewardToken, lower(a.stakingVaultId), { epochCount: a.epochCount });
      case 'FundNftCampaignCreated': // 0.3.1: follows the stream's FundCampaignCreated (fund_stream) in the same call
        return row('fund_nft_stream', null, null, a.collection, lower(a.streamId));
      case 'FundBurned': // 0.3.1 buybackAndBurn: fund asset spent → tokens sent to 0x…dEaD
        return row('fund_burned', a.amountIn, a.tokensBurned, a.fundAsset);
      case 'BoughtBack':
        return row('bought_back', a.quoteIn, a.tokenOut, a.destination);
      case 'CreatorPaid':
        return row('creator_paid', a.amount, null, a.payout);
      case 'XPaid':
        return row('x_paid', a.amount, null, a.recipient, a.xId);
      case 'PayoutAddressSet':
        return row('payout_set', null, null, a.payout, null, { creator: lower(a.creator) });
      case 'RewardsCampaignStarted':
        return row('campaign', a.pool, a.paid, a.caller, a.campaignId);
      case 'EconomicsIncreased':
        if ('communityBps' in a) {
          await row('economics', null, null, null, null, { burnBps: a.burnBps, communityBps: a.communityBps });
          await q(
            'update launch_economy set burn_bps = $3, community_bps = $4, updated_block = $5 where chain_id = $1 and token = $2 and updated_block <= $5',
            [chainId, owner.token, Number(a.burnBps), Number(a.communityBps), block]
          );
          return;
        }
        await row('economics', null, null, null, null, { buybackBps: a.buybackBps, buybackBurn: a.buybackBurn, rewardsBps: a.rewardsBps });
        await q('update launch_tokens set buyback_bps = $3, buyback_burn = $4, rewards_bps = $5 where chain_id = $1 and token = $2', [chainId, owner.token, Number(a.buybackBps), a.buybackBurn, Number(a.rewardsBps)]);
        return;
      default:
        return;
    }
  }

  const gen = log.release ? releaseGeneration(log.release.version) : null;

  // PlaceStaking (every program, whatever token it is for)
  if (log.release && addr === log.release.staking) return applyStakingLog(q, log, ctx, at(), key);

  // The reward token registry (white list of reward and community-fund swaps)
  if (log.release && addr === log.release.rewardTokenRegistry) {
    if (log.eventName !== 'RouteSet' && log.eventName !== 'RouteRemoved') return;
    const set = log.eventName === 'RouteSet';
    await q(
      `insert into launch_reward_routes (chain_id, registry, from_token, to_token, hops, active, updated_block) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (chain_id, registry, from_token, to_token) do update set hops = excluded.hops, active = excluded.active, updated_block = excluded.updated_block
       where launch_reward_routes.updated_block <= excluded.updated_block`,
      [chainId, addr, lower(a.from), lower(a.to), set ? json(a.hops) : null, set, block]
    );
    return;
  }

  // 0.3.0 rewards distributor and FeeEscrow
  if (gen >= 3 && addr === log.release.rewardsDistributor) return applyDistributorLog(q, log, ctx, at(), key);
  if (gen >= 3 && addr === log.release.feeEscrow) {
    if (log.eventName !== 'TokensBurned') return;
    await q(
      `insert into launch_burns (chain_id, block, log_index, token, caller, amount, tx, at) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
      [...key, lower(a.token), lower(a.caller), a.amount.toString(), lower(log.transactionHash), at()]
    );
    return;
  }

  // 0.3.0 hook: tax credits per basket and the Trade with trader, side and volume.
  if (gen >= 3 && addr === log.release.hook && TAX_KINDS[log.eventName]) {
    const t = ctx.byPool.get(lower(a.poolId));
    if (!t) return;
    let kind = TAX_KINDS[log.eventName];
    if (kind === 'reward') {
      const id = lower(a.account);
      kind = id === economyStreamId(t.token, 0) ? 'holders' : id === economyStreamId(t.token, 1) ? 'traders' : null;
      if (!kind) return;
    }
    const recipient = lower(a.recipient ?? a.vault ?? a.distributor ?? a.sink) ?? null;
    const currency = kind === 'burn' ? t.token : lower(a.currency);
    await q(
      `insert into launch_tax_credits (chain_id, block, log_index, token, kind, recipient, currency, amount, tx, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
      [...key, t.token, kind, recipient, currency, a.amount.toString(), lower(log.transactionHash), at()]
    );
    return;
  }

  // Static contracts. The pair registry rows take the latest event of any release (updated_block), so the
  // current factory's registrations win once it exists and legacy launches still get their pair's decimals.
  switch (log.eventName) {
    case 'QuoteLimitsUpdated':
      await q(
        `insert into launch_quote_limits (chain_id, quote, max_burn_per_process, default_campaign_minimum, updated_block) values ($1, $2, $3, $4, $5)
         on conflict (chain_id, quote) do update set max_burn_per_process = excluded.max_burn_per_process,
           default_campaign_minimum = excluded.default_campaign_minimum, updated_block = excluded.updated_block
         where launch_quote_limits.updated_block <= excluded.updated_block`,
        [chainId, lower(a.quoteToken), a.maxBurnPerProcess?.toString() ?? null, a.defaultCampaignMinimum.toString(), block]
      );
      return;
    case 'QuoteRegistered':
      await q(
        `insert into launch_quotes (chain_id, quote, decimals, start_tick, registered, revision, updated_block) values ($1, $2, $3, $4, true, $5, $6)
         on conflict (chain_id, quote) do update set decimals = excluded.decimals, start_tick = excluded.start_tick, registered = true,
           revision = excluded.revision, updated_block = excluded.updated_block where launch_quotes.updated_block <= excluded.updated_block`,
        [chainId, lower(a.quoteToken), Number(a.quoteDecimals), Number(a.startTickToken0Frame), a.revision.toString(), block]
      );
      return;
    case 'QuoteStartTickUpdated':
      await q('update launch_quotes set start_tick = $3, revision = $4, updated_block = $5 where chain_id = $1 and quote = $2 and updated_block <= $5', [
        chainId, lower(a.quoteToken), Number(a.newStartTickToken0Frame), a.revision.toString(), block,
      ]);
      return;
    case 'QuoteUnregistered':
      await q('update launch_quotes set registered = false, revision = $3, updated_block = $4 where chain_id = $1 and quote = $2 and updated_block <= $4', [
        chainId, lower(a.quoteToken), a.revision.toString(), block,
      ]);
      return;
    case 'RewardsMinimumUpdated':
      await q(
        `insert into launch_quotes (chain_id, quote, decimals, start_tick, registered, revision, rewards_min, updated_block) values ($1, $2, 0, 0, false, 0, $3, 0)
         on conflict (chain_id, quote) do update set rewards_min = excluded.rewards_min`,
        [chainId, lower(a.quoteToken), a.minimum.toString()]
      );
      return;
    case 'Launched': // inserted by insertFreshTokens before the range's logs
      return;
    case 'CreatorVaultCreated':
      if (gen === 1) {
        await q('update launch_tokens set vault = $3, buyback_bps = coalesce(buyback_bps, $4), buyback_burn = coalesce(buyback_burn, $5), rewards_bps = coalesce(rewards_bps, $6) where chain_id = $1 and token = $2', [
          chainId, lower(a.token), lower(a.vault), Number(a.buybackBps), a.buybackBurn, Number(a.rewardsBps),
        ]);
        return;
      }
      await q('update launch_tokens set vault = $3 where chain_id = $1 and token = $2', [chainId, lower(a.token), lower(a.vault)]);
      return;
    case 'CommunityVaultCreated':
      await q('update launch_economy set community_vault = $3 where chain_id = $1 and token = $2', [chainId, lower(a.token), lower(a.vault)]);
      return;
    case 'LaunchBuyExecuted':
      await q('update launch_tokens set dev_buy_funding = $3, dev_buy_in = $4, dev_buy_out = $5 where chain_id = $1 and token = $2', [
        chainId, lower(a.token), lower(a.fundingToken), a.amountIn.toString(), a.amountOut.toString(),
      ]);
      return;
    case 'CreatorRightsTransferProposed':
      await q('update launch_tokens set pending_creator = $3 where chain_id = $1 and token = $2', [chainId, lower(a.token), lower(a.pendingCreator)]);
      return;
    case 'CreatorRightsTransferCancelled':
      await q('update launch_tokens set pending_creator = null where chain_id = $1 and token = $2', [chainId, lower(a.token)]);
      return;
    case 'CreatorRightsTransferred':
    case 'CreatorRightsReassigned':
      await q('update launch_tokens set current_creator = $3, pending_creator = null where chain_id = $1 and token = $2', [chainId, lower(a.token), lower(a.newCreator)]);
      return;
    case 'B20ExtraMetadataUpdated':
      await setExtra(q, chainId, lower(a.token), a.metadataKey, a.metadataValue);
      return;
    case 'Trade': {
      // The hook's fee for the swap just before it in the same transaction and pool.
      const t = ctx.byPool.get(lower(a.poolId));
      if (!t) return;
      await q(
        `update launch_swaps set fee = $5 where (chain_id, block, log_index) = (
           select chain_id, block, log_index from launch_swaps
           where chain_id = $1 and tx = $2 and token = $3 and (block < $4::bigint or (block = $4::bigint and log_index < $6))
           order by block desc, log_index desc limit 1)`,
        [chainId, lower(log.transactionHash), t.token, block, a.quoteFeeAmount.toString(), log.logIndex]
      );
      if (!('trader' in a)) return; // 0.1.0 / 0.2.0 hooks: fee only
      const time = ctx.times.get(log.blockNumber) ?? 0n;
      const epoch = Number(time) === 0 ? 0 : Math.floor(Number(time) / EPOCH);
      const trader = lower(a.trader);
      const counted = !ctx.notTraders.has(lower(a.executor)) && !ctx.notTraders.has(trader);
      const inserted = await q(
        `insert into launch_trades (chain_id, block, log_index, token, executor, trader, is_buy, quote_volume, quote_fee, epoch, counted, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing returning token`,
        [...key, t.token, lower(a.executor), trader, a.isBuy, a.quoteVolume.toString(), a.quoteFeeAmount.toString(), epoch, counted, lower(log.transactionHash), at()]
      );
      if (inserted.length && counted) {
        await q(
          `insert into launch_trader_volume (chain_id, token, epoch, trader, volume, trades) values ($1, $2, $3, $4, $5, 1)
           on conflict (chain_id, token, epoch, trader) do update set volume = launch_trader_volume.volume + excluded.volume, trades = launch_trader_volume.trades + 1`,
          [chainId, t.token, epoch, trader, a.quoteVolume.toString()]
        );
      }
      return;
    }
    case 'AnnouncementPosted':
      await q(
        `insert into launch_announcements (chain_id, token, announcement_id, creator, description, uri, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
        [chainId, lower(a.token), lower(a.announcementId), lower(a.creator), a.description, a.announcementURI, lower(log.transactionHash), at()]
      );
      return;
    case 'Bound':
    case 'Moved':
      await q(
        `insert into x_bindings (chain_id, x_id, wallet, block) values ($1, $2, $3, $4)
         on conflict (chain_id, x_id) do update set wallet = excluded.wallet, block = excluded.block where x_bindings.block <= excluded.block`,
        [chainId, a.xId.toString(), lower(log.eventName === 'Bound' ? a.wallet : a.newWallet), block]
      );
      return;
    default:
      return;
  }
}

/** PlaceRewardsDistributor: streams, closed epochs, conversions, published roots, claims. */
async function applyDistributorLog(q, log, ctx, at, key) {
  const { chainId } = ctx;
  const a = log.args;
  const id = lower(a.streamId);
  const tx = lower(log.transactionHash);
  const event = (kind, amount, amount2, epoch, data) =>
    q(
      `insert into reward_stream_events (chain_id, block, log_index, stream_id, kind, amount, amount2, epoch, data, tx, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing returning kind`,
      [...key, id, kind, amount?.toString() ?? null, amount2?.toString() ?? null, epoch?.toString() ?? null, data ? json(data) : null, tx, at]
    );
  switch (log.eventName) {
    case 'LaunchStreamRegistered':
      await q(
        `insert into reward_streams (chain_id, stream_id, distributor, token, kind, economy, reward_token, source, start_epoch, criterion,
           last_closed_epoch, created_block, created_tx, created_at)
         values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (chain_id, stream_id) do nothing`,
        [chainId, id, lower(log.address), lower(a.token), Number(a.kind), lower(a.rewardToken), lower(a.quote), a.startEpoch.toString(), a.criterion.toString(), (a.startEpoch - 1n).toString(), key[1], tx, at]
      );
      return;
    case 'StreamCreated':
      await q(
        `insert into reward_streams (chain_id, stream_id, distributor, token, kind, economy, reward_token, funder, start_epoch, epoch_count,
           reward_per_epoch, criterion, fee, metadata_uri, last_closed_epoch, created_block, created_tx, created_at)
         values ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) on conflict (chain_id, stream_id) do nothing`,
        [
          chainId, id, lower(log.address), lower(a.token), Number(a.kind), lower(a.rewardToken), lower(a.funder), a.startEpoch.toString(), a.epochCount.toString(),
          a.rewardPerEpoch.toString(), a.criterion.toString(), a.fee.toString(), a.metadataURI, (a.startEpoch - 1n).toString(), key[1], tx, at,
        ]
      );
      return;
    case 'EpochClosed':
      await q(
        `insert into reward_epochs (chain_id, stream_id, epoch, collected, total_funded, tx, at) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (chain_id, stream_id, epoch) do nothing`,
        [chainId, id, a.epoch.toString(), a.collected.toString(), a.totalFunded.toString(), tx, at]
      );
      await q(
        `update reward_streams set last_closed_epoch = $3, funded = $4 where chain_id = $1 and stream_id = $2 and (last_closed_epoch is null or last_closed_epoch <= $3)`,
        [chainId, id, a.epoch.toString(), a.totalFunded.toString()]
      );
      return;
    case 'Converted': {
      // A conversion funds the stream. Inside closeEpoch the EpochClosed that follows sets the exact total anyway.
      const inserted = await event('converted', a.amountIn, a.amountOut);
      if (inserted.length) await q('update reward_streams set funded = funded + $3::numeric where chain_id = $1 and stream_id = $2', [chainId, id, a.amountOut.toString()]);
      return;
    }
    case 'ConversionDeferred':
      await event('deferred', a.pendingInput, null, null, { reason: a.reason });
      return;
    case 'RootPublished': {
      await event('root', a.cumulativeTotal, null, a.epoch, { root: a.root, uri: a.uri });
      await q(
        `update reward_streams set root = $3, root_epoch = $4, allocated = $5, root_uri = $6 where chain_id = $1 and stream_id = $2 and (root_epoch is null or root_epoch <= $4)`,
        [chainId, id, lower(a.root), a.epoch.toString(), a.cumulativeTotal.toString(), a.uri]
      );
      await q(`update reward_tables set status = 'published', tx = coalesce(tx, $5) where chain_id = $1 and stream_id = $2 and epoch = $3 and root = $4`, [chainId, id, a.epoch.toString(), lower(a.root), tx]);
      return;
    }
    case 'RewardClaimed': {
      const inserted = await q(
        `insert into reward_claims (chain_id, block, log_index, stream_id, account, amount, cumulative, tx, at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict do nothing returning stream_id`,
        [...key, id, lower(a.account), a.amount.toString(), a.cumulativeAmount.toString(), tx, at]
      );
      if (inserted.length) await q('update reward_streams set claimed = claimed + $3::numeric where chain_id = $1 and stream_id = $2', [chainId, id, a.amount.toString()]);
      return;
    }
    case 'UnallocatedReclaimed': {
      const inserted = await event('reclaimed', a.amount, null, null, { funder: lower(a.funder) });
      if (inserted.length) await q('update reward_streams set reclaimed = reclaimed + $3::numeric where chain_id = $1 and stream_id = $2', [chainId, id, a.amount.toString()]);
      return;
    }
    default:
      return;
  }
}

/** PlaceStaking: programs, stakes, withdrawals and epoch claims. */
async function applyStakingLog(q, log, ctx, at, key) {
  const { chainId } = ctx;
  const a = log.args;
  const id = lower(a.vaultId);
  switch (log.eventName) {
    case 'VaultCreated':
      await q(
        `insert into staking_programs (chain_id, staking, vault_id, creator, staking_token, reward_currency, start_time, epoch_duration, epoch_count,
           reward_per_epoch, early_exit_mode, penalty_bps, total_reward, protocol_fee, fee_bps, created_block, created_tx, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) on conflict (chain_id, vault_id) do nothing`,
        [
          chainId, lower(log.address), id, lower(a.creator), lower(a.stakingToken), lower(a.rewardCurrency), iso(a.startTime), a.epochDuration.toString(),
          Number(a.epochCount), a.rewardPerEpoch.toString(), Number(a.earlyExitMode), Number(a.penaltyBps), a.totalReward.toString(), a.protocolFee.toString(),
          Number(a.feeBps), log.blockNumber.toString(), lower(log.transactionHash), at,
        ]
      );
      return;
    case 'Deposited':
    case 'Withdrawn':
    case 'EpochRewardClaimed': {
      const kind = { Deposited: 'deposit', Withdrawn: 'withdraw', EpochRewardClaimed: 'claim' }[log.eventName];
      const amount = kind === 'claim' ? a.reward : a.amount;
      const inserted = await q(
        `insert into staking_events (chain_id, block, log_index, vault_id, account, kind, amount, lot_id, epoch, penalty, unlock_at, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing returning kind`,
        [
          ...key, id, lower(a.user), kind, amount.toString(), a.lotId?.toString() ?? null, a.epoch?.toString() ?? null,
          a.penalty?.toString() ?? null, a.unlockAt != null ? iso(a.unlockAt) : null, lower(log.transactionHash), at,
        ]
      );
      if (!inserted.length) return;
      const staked = kind === 'deposit' ? amount : kind === 'withdraw' ? -amount : 0n;
      const claimed = kind === 'claim' ? amount : 0n;
      await q(
        `insert into staking_positions (chain_id, vault_id, account, staked, claimed) values ($1, $2, $3, $4, $5)
         on conflict (chain_id, vault_id, account) do update set staked = staking_positions.staked + excluded.staked,
           claimed = staking_positions.claimed + excluded.claimed`,
        [chainId, id, lower(a.user), staked.toString(), claimed.toString()]
      );
      await q('update staking_programs set total_staked = total_staked + $3::numeric, claimed = claimed + $4::numeric where chain_id = $1 and vault_id = $2', [
        chainId, id, staked.toString(), claimed.toString(),
      ]);
      return;
    }
    default:
      return;
  }
}

async function setExtra(q, chainId, token, key, value) {
  const [row] = await q('select extra from launch_tokens where chain_id = $1 and token = $2', [chainId, token]);
  if (!row) return;
  const extra = JSON.parse(row.extra || '{}');
  if (value === '' || value == null) delete extra[key];
  else extra[key] = value;
  await q('update launch_tokens set extra = $3 where chain_id = $1 and token = $2', [chainId, token, JSON.stringify(extra)]);
}
