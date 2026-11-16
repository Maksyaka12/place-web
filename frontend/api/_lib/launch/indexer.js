// Place Launch indexer: the launchpad's events, read inside the hub indexer's range loop with the same cursor
// (place/indexer.js calls collectLaunchLogs for every range, then applies hub and launch events together in
// block order, in one transaction).
//
// Two passes per range:
// 1. the static contracts (factory, hook, announcements, X registry) come with the hub's own getLogs; a
//    Launched there introduces a token, its vault and its pool id;
// 2. dynamic sources for the same range: every known launch token (Transfer, metadata) and vault, and the
//    PoolManager's Swap/Initialize filtered by the launch pool ids. Newly found tokens join this pass, so the
//    launch transaction's own transfers and dev-buy swap are never missed.
// Swaps get their trader (the transaction sender, since the router is the PoolManager caller) and block time.
// Every write is idempotent: totals change only when the row keyed by (block, log_index) is new.
//
// Releases (src/launch/deployments.js): the current one (0.2.0: burn / community fund baskets, PlaceStaking)
// and legacy ones (0.1.0: buyback / rewards) are read side by side. Factory and vault events are decoded with
// their release's ABI, since some events keep their types but rename their fields (Collected).
import { parseEventLogs, parseAbi } from 'viem';
import {
  LAUNCH_FACTORY_ABI,
  LAUNCH_OPERATIONS_EVENTS,
  LAUNCH_HOOK_ABI,
  CREATOR_VAULT_ABI,
  ANNOUNCEMENT_REGISTRY_ABI,
  X_RECIPIENT_REGISTRY_ABI,
  LAUNCH_TOKEN_ABI,
  POOL_MANAGER_ABI,
  PLACE_STAKING_ABI,
  REWARD_TOKEN_REGISTRY_ABI,
} from '../../../src/launch/abi.js';
import { LEGACY_FACTORY_EVENTS, LEGACY_OPERATIONS_EVENTS, LEGACY_CREATOR_VAULT_ABI } from '../../../src/launch/abi.legacy.js';
import { launchDeployment, launchReleases, launchStartBlock } from '../../../src/launch/deployments.js';
import { priceFromSqrt, swapSide } from '../../../src/launch/market.js';
import { retry } from '../place/chain.js';

const ADDRESS_CHUNK = Number(process.env.PLACE_LOGS_MAX_ADDRESSES || 10); // free log nodes allow 10 addresses per eth_getLogs
const TOPIC_CHUNK = 100;
const RPC_CHUNK = 50;
const ZERO = '0x0000000000000000000000000000000000000000';
const KIND = { 1: 'erc20', 2: 'b20' };

const events = (abi) => abi.filter((x) => x.type === 'event');
const FACTORY_EVENTS = [...events(LAUNCH_FACTORY_ABI), ...LAUNCH_OPERATIONS_EVENTS];
const LEGACY_FACTORY = [...LEGACY_FACTORY_EVENTS, ...LEGACY_OPERATIONS_EVENTS];
const SHARED_EVENTS = [...events(LAUNCH_HOOK_ABI), ...events(ANNOUNCEMENT_REGISTRY_ABI), ...events(X_RECIPIENT_REGISTRY_ABI)];
const STAKING_EVENTS = events(PLACE_STAKING_ABI);
const REGISTRY_EVENTS = events(REWARD_TOKEN_REGISTRY_ABI).filter((e) => e.name.startsWith('Route'));
const TOKEN_EVENTS = events(LAUNCH_TOKEN_ABI);
const VAULT_EVENTS = events(CREATOR_VAULT_ABI);
const LEGACY_VAULT_EVENTS = events(LEGACY_CREATOR_VAULT_ABI);
const vaultEvents = (version, current) => (version === current ? VAULT_EVENTS : LEGACY_VAULT_EVENTS);
const PM_EVENTS = events(POOL_MANAGER_ABI);
const SWAP = PM_EVENTS.find((e) => e.name === 'Swap');
const INIT = PM_EVENTS.find((e) => e.name === 'Initialize');

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

/** Static launch contracts of every release whose logs come with the hub's getLogs. */
export function launchStaticAddresses(chainId) {
  return launchReleases(chainId).flatMap((r) => [
    r.factory,
    r.hook,
    r.announcementRegistry,
    r.xRecipientRegistry,
    ...(r.legacy ? [] : [r.staking, r.rewardTokenRegistry].filter(Boolean)),
  ]);
}

/** Decodes static logs, each with its own release's ABI, and tags them with that release. */
function decodeStatic(chainId, logs) {
  const out = [];
  for (const r of launchReleases(chainId)) {
    const take = (addrs, abi) => {
      const mine = logs.filter((l) => addrs.includes(lower(l.address)));
      if (!mine.length) return;
      for (const l of parseEventLogs({ abi, logs: mine, strict: false })) if (l.eventName) out.push(Object.assign(l, { release: r }));
    };
    take([r.factory], r.legacy ? LEGACY_FACTORY : FACTORY_EVENTS);
    take([r.hook, r.announcementRegistry, r.xRecipientRegistry], SHARED_EVENTS);
    if (!r.legacy && r.staking) take([r.staking], STAKING_EVENTS);
    if (!r.legacy && r.rewardTokenRegistry) take([r.rewardTokenRegistry], REGISTRY_EVENTS);
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
  if (!d || toBlock < launchStartBlock(chainId)) return { logs: [], ctx: null };
  const legacyVersion = launchReleases(chainId).find((r) => r.legacy)?.version ?? d.version;
  const decoded = decodeStatic(chainId, staticLogs);

  // New launches in this range: token, pool, vault, then what the chain says about them.
  const fresh = new Map();
  for (const l of decoded) {
    if (lower(l.address) !== l.release.factory) continue;
    const t = lower(l.args.token);
    if (l.eventName === 'Launched') {
      fresh.set(t, { ...(fresh.get(t) || {}), token: t, version: l.release.version, release: l.release, poolId: lower(l.args.poolId), creator: lower(l.args.originalCreator), quote: lower(l.args.quoteToken), supply: l.args.launchSupply, tickSpacing: Number(l.args.tickSpacing), block: l.blockNumber, tx: lower(l.transactionHash) });
    } else if (l.eventName === 'CreatorVaultCreated') {
      const e = l.release.legacy
        ? { buybackBps: Number(l.args.buybackBps), buybackBurn: l.args.buybackBurn, rewardsBps: Number(l.args.rewardsBps) }
        : { burnBps: Number(l.args.burnBps), communityBps: Number(l.args.communityBps) };
      fresh.set(t, { ...(fresh.get(t) || {}), vault: lower(l.args.vault), ...e });
    }
  }
  const newTokens = [...fresh.values()].filter((t) => t.poolId);
  if (newTokens.length) await readNewTokens(client, newTokens);

  // Tokens indexed before launch_economy existed are 0.1.0 (the only release then).
  const known = await db.query(
    `select t.token, t.pool_id, t.vault, t.quote, t.token_is_currency0, coalesce(q.decimals, 18) as quote_decimals, e.version
     from launch_tokens t left join launch_quotes q on q.chain_id = t.chain_id and q.quote = t.quote
     left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1`,
    [chainId]
  );
  const tokens = new Map(known.map((r) => [r.token, { token: r.token, poolId: r.pool_id, vault: r.vault, quote: r.quote, tokenIsCurrency0: r.token_is_currency0, quoteDecimals: Number(r.quote_decimals), version: r.version || legacyVersion }]));
  const quoteDecimals = new Map((await db.query('select quote, decimals from launch_quotes where chain_id = $1', [chainId])).map((r) => [r.quote, Number(r.decimals)]));
  for (const l of decoded) if (l.eventName === 'QuoteRegistered') quoteDecimals.set(lower(l.args.quoteToken), Number(l.args.quoteDecimals));
  for (const t of newTokens) {
    tokens.set(t.token, { token: t.token, poolId: t.poolId, vault: t.vault, quote: t.quote, tokenIsCurrency0: t.tokenIsCurrency0, quoteDecimals: quoteDecimals.get(t.quote) ?? 18, version: t.version });
  }

  let dynamic = [];
  if (tokens.size) {
    const list = [...tokens.values()];
    const addrs = [...list.map((t) => t.token), ...list.map((t) => t.vault).filter(Boolean)];
    const raw = [];
    for (const part of chunks(addrs, ADDRESS_CHUNK)) raw.push(...(await client.getLogs({ address: part, fromBlock, toBlock })));
    dynamic.push(...parseEventLogs({ abi: TOKEN_EVENTS, logs: raw.filter((l) => tokens.has(lower(l.address))), strict: false }));
    for (const version of new Set(list.map((t) => t.version))) {
      const vaults = new Set(list.filter((t) => t.vault && t.version === version).map((t) => t.vault));
      const mine = raw.filter((l) => vaults.has(lower(l.address)));
      if (mine.length) dynamic.push(...parseEventLogs({ abi: vaultEvents(version, d.version), logs: mine, strict: false }));
    }
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

  const timed = new Set(['Launched', 'Swap', 'AnnouncementPosted', ...[...VAULT_EVENTS, ...LEGACY_VAULT_EVENTS, ...STAKING_EVENTS].map((e) => e.name)]);
  const times = await blockTimes(client, [...new Set(logs.filter((l) => timed.has(l.eventName)).map((l) => l.blockNumber))]);
  const senders = await txSenders(client, [...new Set(logs.filter((l) => l.eventName === 'Swap').map((l) => l.transactionHash))]);
  const byPool = new Map([...tokens.values()].map((t) => [t.poolId, t]));
  const byVault = new Map([...tokens.values()].filter((t) => t.vault).map((t) => [t.vault, t]));
  return { logs, ctx: { chainId, d, fresh, times, senders, byPool, byVault, tokens } };
}

/** Kind, editability, name, symbol and contract URI of new launch tokens; their vault's X shares. */
async function readNewTokens(client, list) {
  // launchTokenKind, creatorRights and xShares have the same signature in every release.
  const calls = list.flatMap((t) => [
    { address: t.release.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'launchTokenKind', args: [t.token] },
    { address: t.release.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'creatorRights', args: [t.token] },
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
    await q(
      `insert into launch_economy (chain_id, token, version, burn_bps, community_bps, updated_block) values ($1, $2, $3, $4, $5, $6)
       on conflict (chain_id, token) do nothing`,
      [ctx.chainId, t.token, t.version, t.burnBps ?? null, t.communityBps ?? null, t.block.toString()]
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

  // Creator vaults
  const owner = ctx.byVault.get(addr);
  if (owner) {
    const row = (kind, amount, amount2, account, ref, data) =>
      q(
        `insert into launch_vault_events (chain_id, block, log_index, vault, token, kind, amount, amount2, account, ref, data, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing`,
        [...key, addr, owner.token, kind, amount?.toString() ?? null, amount2?.toString() ?? null, lower(account) ?? null, ref?.toString() ?? null, data ? json(data) : null, lower(log.transactionHash), at()]
      );
    switch (log.eventName) {
      case 'Collected':
        return 'toBurn' in a
          ? row('collected', a.amount, null, null, null, { toBurn: a.toBurn, toCommunity: a.toCommunity, toX: a.toX, toCreator: a.toCreator })
          : row('collected', a.amount, null, null, null, { toBuyback: a.toBuyback, toRewards: a.toRewards, toX: a.toX, toCreator: a.toCreator });
      case 'Burned':
        return row('burned', a.quoteIn, a.tokenOut, a.caller);
      case 'FundSwapped':
        return row('fund_swapped', a.amountIn, a.amountOut, null, null, { fundAsset: lower(a.fundAsset), rewardToken: lower(a.rewardToken) });
      case 'FundCampaignCreated':
        return row('fund_campaign', a.pool, a.paid, a.rewardToken, a.campaignId, { isDefault: a.isDefault });
      case 'FundStakingCreated':
        return row('fund_staking', a.paid, a.rewardPerEpoch, a.rewardToken, lower(a.stakingVaultId), { epochCount: a.epochCount });
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

  // PlaceStaking (every program, whatever token it is for)
  if (log.release && !log.release.legacy && addr === log.release.staking) return applyStakingLog(q, log, ctx, at(), key);

  // The reward token registry (white list of community-fund swaps)
  if (log.release && !log.release.legacy && addr === log.release.rewardTokenRegistry) {
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

  // Static contracts. The pair registry rows take the latest event of any release (updated_block), so the
  // current factory's registrations win once it exists and legacy launches still get their pair's decimals.
  switch (log.eventName) {
    case 'QuoteLimitsUpdated':
      await q(
        `insert into launch_quote_limits (chain_id, quote, max_burn_per_process, default_campaign_minimum, updated_block) values ($1, $2, $3, $4, $5)
         on conflict (chain_id, quote) do update set max_burn_per_process = excluded.max_burn_per_process,
           default_campaign_minimum = excluded.default_campaign_minimum, updated_block = excluded.updated_block
         where launch_quote_limits.updated_block <= excluded.updated_block`,
        [chainId, lower(a.quoteToken), a.maxBurnPerProcess.toString(), a.defaultCampaignMinimum.toString(), block]
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
      if (!log.release?.legacy) {
        await q('update launch_tokens set vault = $3 where chain_id = $1 and token = $2', [chainId, lower(a.token), lower(a.vault)]);
        return;
      }
      await q('update launch_tokens set vault = $3, buyback_bps = coalesce(buyback_bps, $4), buyback_burn = coalesce(buyback_burn, $5), rewards_bps = coalesce(rewards_bps, $6) where chain_id = $1 and token = $2', [
        chainId, lower(a.token), lower(a.vault), Number(a.buybackBps), a.buybackBurn, Number(a.rewardsBps),
      ]);
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
