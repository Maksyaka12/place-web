// Place Launch economy in the API: the 0.2.0 creator vault's three baskets, community fund, burns and fund
// swaps; the 0.3.0 Community Pool's fund quotes; PlaceStaking programs of every release.
//
//   GET launch/fund-quote  ?chain&token&rewardToken&amountIn[&slippageBps&kind=campaign|staking]   (0.2.0 tokens)
//                          ?chain&token&rewardToken&amountIn[&slippageBps&kind=holders|traders|staking&epochCount
//                           &startEpoch&criterion&metadataURI&startTime&epochDuration&earlyExit&penaltyBps]  (0.3.0)
//                          what the fund gets in the reward token (a dry run of fundCampaign with an impossible
//                          minOut: the vault reverts with SlippageExceeded(amountOut, minOut)), minOut, fees; for
//                          0.3.0 also the ready fundCampaign / fundStaking transaction of the Community Pool
//   GET launch/staking     ?chain[&token&creator&account&limit]   PlaceStaking programs with status and totals
//   GET launch/staking/position ?chain&id&account                 lots, claimable epochs (previewClaim), txs
//
// The token page (`fund`, `burns`, `staking` in launch/token) and the creator panel (vault in launch/creator)
// use the helpers exported here.
import { encodeFunctionData, maxUint256 } from 'viem';
import { PLACE_STAKING_ABI, COMMUNITY_VAULT_ABI, REWARDS_DISTRIBUTOR_ABI } from '../../../src/launch/abi.js';
import { V020_CREATOR_VAULT_ABI as CREATOR_VAULT_ABI } from '../../../src/launch/abi.legacy.js'; // the 0.2.0 vault
import { PLACE_HUB_ABI, PLACE_CONFIG_ABI } from '../../../src/place/abi.js';
import { launchDeployment, deployedReleases, releaseByVersion } from '../../../src/launch/deployments.js';
import { releaseGeneration, EPOCH } from './indexer.js';
import { reply, fail, chainOf, addressOf, iso } from '../place/http.js';
import { ensureTokenMeta } from '../place/tokenMeta.js';
import { retry } from '../place/chain.js';
import { quoteUsd } from './prices.js';

const ETH = '0x0000000000000000000000000000000000000000';
const BPS = 10_000n;
const outAddr = (a) => (a === ETH ? 'eth' : a);
const inAddr = (v) => (v === 'eth' || v === 'ETH' ? ETH : addressOf(v, 'address'));
const lower = (a) => (a == null ? a : String(a).toLowerCase());

/** The contract's own error, e.g. "ProcessTooSoon(1795183733)", when the node returned revert data. */
export function revertReason(e) {
  const hit = typeof e?.walk === 'function' ? e.walk((x) => x?.data?.errorName) : null;
  if (hit) return `${hit.data.errorName}(${(hit.data.args || []).map(String).join(', ')})`;
  return e?.shortMessage || e?.message || String(e);
}
const revertArgs = (e) => {
  const hit = typeof e?.walk === 'function' ? e.walk((x) => x?.data?.errorName) : null;
  return hit ? { name: hit.data.errorName, args: hit.data.args || [] } : null;
};

function chainParts(q) {
  const chainId = chainOf(q);
  const d = launchDeployment(chainId);
  if (!d) fail(`Place Launch is not deployed on chain ${chainId}`);
  return { chainId, d };
}

/** PlaceStaking of the newest deployed release (0.3.0 may reuse the 0.2.0 one). */
export function stakingAddress(chainId) {
  return deployedReleases(chainId).find((r) => r.staking)?.staking ?? null;
}

async function simulate(client, address, abi, functionName, args, account) {
  try {
    const { result } = await client.simulateContract({ address, abi, functionName, args, account });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: revertReason(e), revert: revertArgs(e) };
  }
}

const VAULT_READS = [
  'burnReserve', 'creatorOwed', 'xOwedTotal', 'pendingFees', 'payoutAddress', 'currentCreator', 'lastProcessAt', 'lastFundSpendAt',
  'nextProcessAt', 'settings', 'burnBps', 'communityBps', 'quote', 'token',
];

async function readVault(client, vault) {
  const res = await retry(() =>
    client.multicall({ contracts: VAULT_READS.map((functionName) => ({ address: vault, abi: CREATOR_VAULT_ABI, functionName })), allowFailure: false })
  );
  const v = Object.fromEntries(VAULT_READS.map((k, i) => [k, res[i]]));
  v.fund = await retry(() => client.readContract({ address: vault, abi: CREATOR_VAULT_ABI, functionName: 'fundBalance', args: [v.quote] }));
  return v;
}

/** Fund, process and default-campaign state anyone may see (token page). Null if the chain cannot be read. */
export async function vaultPublicState(deps, chainId, vault, now) {
  if (!vault) return null;
  const client = deps.client(chainId);
  let v;
  try {
    v = await readVault(client, vault);
  } catch {
    return null;
  }
  const pendingCommunity = (v.pendingFees * BigInt(v.communityBps)) / BPS;
  const pendingBurn = (v.pendingFees * BigInt(v.burnBps)) / BPS;
  const s = v.settings;
  const nextProcessAt = Number(v.nextProcessAt);
  const defaultAt = Number(v.lastFundSpendAt) + Number(s.defaultCampaignDelay);
  return {
    vault,
    quote: outAddr(lower(v.quote)),
    economics: { burnBps: Number(v.burnBps), communityBps: Number(v.communityBps), creatorBps: 10_000 - Number(v.burnBps) - Number(v.communityBps) },
    fund: { balance: v.fund.toString(), pending: pendingCommunity.toString(), afterCollect: (v.fund + pendingCommunity).toString() },
    burn: { reserve: v.burnReserve.toString(), pending: pendingBurn.toString(), maxPerProcess: s.maxBurnPerProcess.toString() },
    pendingFees: v.pendingFees.toString(),
    process: { interval: Number(s.processInterval), lastAt: Number(v.lastProcessAt) ? iso(Number(v.lastProcessAt) * 1000) : null, nextAt: iso(Math.max(nextProcessAt, 0) * 1000), due: nextProcessAt <= now },
    defaultCampaign: {
      delay: Number(s.defaultCampaignDelay),
      minimum: s.defaultCampaignMinimum.toString(),
      lastFundSpendAt: iso(Number(v.lastFundSpendAt) * 1000),
      nextAt: iso(defaultAt * 1000),
      due: s.hub !== ETH && defaultAt <= now && v.fund + pendingCommunity >= (s.defaultCampaignMinimum || 1n),
    },
    settings: {
      hub: lower(s.hub),
      staking: lower(s.staking),
      rewardRegistry: lower(s.rewardRegistry),
      processInterval: Number(s.processInterval),
      defaultCampaignDelay: Number(s.defaultCampaignDelay),
      maxBurnPerProcess: s.maxBurnPerProcess.toString(),
      defaultCampaignMinimum: s.defaultCampaignMinimum.toString(),
      rulesHash: s.rulesHash,
      rulesURI: s.rulesURI,
    },
    raw: v,
  };
}

/** Reward tokens the fund may pay in: the pair (no swap), the token itself (own pool), listed routes. */
export async function rewardTokens(deps, chainId, { token, quote, registry }) {
  const rows = registry
    ? await deps.db.query(
        'select to_token from launch_reward_routes where chain_id = $1 and registry = $2 and from_token = $3 and active order by to_token',
        [chainId, registry, quote]
      )
    : [];
  const list = [
    { address: quote, route: 'none' },
    { address: token, route: 'own-pool' },
    ...rows.map((r) => ({ address: r.to_token, route: 'registry' })).filter((r) => r.address !== quote && r.address !== token),
  ];
  const erc = list.map((r) => r.address).filter((a) => a !== ETH);
  await ensureTokenMeta(deps, chainId, erc);
  const meta = new Map((await deps.db.query('select address, symbol, decimals from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, erc])).map((m) => [m.address, m]));
  return list.map((r) => ({
    address: outAddr(r.address),
    route: r.route,
    symbol: r.address === ETH ? 'ETH' : meta.get(r.address)?.symbol ?? null,
    decimals: r.address === ETH ? 18 : meta.get(r.address)?.decimals ?? 18,
  }));
}

/** The creator panel of a 0.2.0 vault: live baskets, claim, process, default campaign, fund tools. */
export async function vaultPanelV2(deps, chainId, t, now) {
  const client = deps.client(chainId);
  const pub = await vaultPublicState(deps, chainId, t.vault, now);
  if (!pub) return { address: t.vault, version: 'v2', error: 'Could not read the vault' };
  const v = pub.raw;
  const creator = lower(v.currentCreator);
  const claim = await simulate(client, t.vault, CREATOR_VAULT_ABI, 'claim', [], creator);
  const proc = await simulate(client, t.vault, CREATOR_VAULT_ABI, 'process', [], creator);
  const def = pub.settings.hub === ETH ? { ok: false, error: 'CommunityDisabled()' } : await simulate(client, t.vault, CREATOR_VAULT_ABI, 'startDefaultCampaign', [], creator);
  const tx = (functionName, args = []) => ({ to: t.vault, value: '0', data: encodeFunctionData({ abi: CREATOR_VAULT_ABI, functionName, args }) });
  const { raw, ...rest } = pub;
  void raw;
  return {
    version: 'v2',
    address: t.vault,
    creator,
    payout: lower(v.payoutAddress),
    ...rest,
    balances: {
      pendingFees: v.pendingFees.toString(),
      burnReserve: v.burnReserve.toString(),
      creatorOwed: v.creatorOwed.toString(),
      xOwed: v.xOwedTotal.toString(),
      fund: v.fund.toString(),
      fundAfterCollect: pub.fund.afterCollect,
    },
    claim: claim.ok ? { paid: claim.result.toString(), tx: { ...tx('claim'), from: creator } } : { error: claim.error },
    process: {
      ...pub.process,
      canRun: proc.ok,
      collected: proc.ok ? proc.result[0].toString() : null,
      quoteIn: proc.ok ? proc.result[1].toString() : null,
      tokensBurned: proc.ok ? proc.result[2].toString() : null,
      reason: proc.ok ? null : proc.error,
      tx: tx('process'),
    },
    defaultCampaign: { ...pub.defaultCampaign, canStart: def.ok, reason: def.ok ? null : def.error, tx: tx('startDefaultCampaign') },
    rewardTokens: await rewardTokens(deps, chainId, { token: t.token, quote: lower(v.quote), registry: pub.settings.rewardRegistry === ETH ? null : pub.settings.rewardRegistry }),
  };
}

/** Burns of the token (0.2.0 Burned, 0.1.0 buybacks sent to 0x…dEaD) for the token page. */
export async function burnHistory(db, chainId, vault, limit = 50) {
  if (!vault) return { totalQuote: '0', totalTokens: '0', count: 0, list: [] };
  const where = `chain_id = $1 and vault = $2 and (kind = 'burned' or (kind = 'bought_back' and account = '0x000000000000000000000000000000000000dead'))`;
  const [s] = await db.query(`select coalesce(sum(amount), 0)::text as q, coalesce(sum(amount2), 0)::text as t, count(*)::int as n from launch_vault_events where ${where}`, [chainId, vault]);
  const rows = await db.query(
    `select amount::text as quote_in, amount2::text as tokens, account, tx, at, kind from launch_vault_events where ${where} and coalesce(amount2, 0) > 0
     order by block desc, log_index desc limit ${Number(limit)}`,
    [chainId, vault]
  );
  return {
    totalQuote: s.q,
    totalTokens: s.t,
    count: s.n,
    list: rows.map((r) => ({ quoteIn: r.quote_in, tokens: r.tokens, caller: r.kind === 'burned' ? r.account : null, tx: r.tx, at: iso(r.at) })),
  };
}

// ─────────────────────────────── fund quote ───────────────────────────────

async function fundQuote({ query: q }, deps) {
  const { chainId } = chainParts(q);
  const token = addressOf(q.token, 'token');
  const rewardToken = inAddr(q.rewardToken || 'eth');
  const slippageBps = q.slippageBps == null ? 100 : Number(q.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) fail('slippageBps must be 0–5000');
  if (!/^[0-9]{1,78}$/.test(String(q.amountIn || '')) || BigInt(q.amountIn) === 0n) fail('amountIn must be a positive integer (smallest units)');
  const amountIn = BigInt(q.amountIn);
  const [row] = await deps.db.query(
    `select t.token, t.vault, t.quote, t.current_creator, e.version, e.community_vault, e.min_holding::text as min_holding from launch_tokens t
     left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1 and t.token = $2`,
    [chainId, token]
  );
  if (!row?.vault) fail('Not a Place Launch token (or not indexed yet)', 404);
  const gen = releaseGeneration(row.version || '0.1.0');
  if (gen >= 3) return fundQuoteV3(q, deps, { chainId, row, rewardToken, amountIn, slippageBps });
  if (gen !== 2) fail('This token was launched with 0.1.0: its vault has no community fund', 409);
  const release = releaseByVersion(chainId, row.version);
  const client = deps.client(chainId);
  const creator = row.current_creator;
  const fundAsset = row.quote;
  let amountOut;
  let error = null;
  if (rewardToken === fundAsset) amountOut = amountIn;
  else {
    // An impossible minOut makes the vault revert with SlippageExceeded(amountOut, minOut) after the real swap.
    const req = { fundAsset, amountIn, rewardToken, minOut: maxUint256, snapshotDelay: 86_400n, claimDuration: 30 * 86_400, burnLeftover: true, metadataURI: '' };
    const sim = await simulate(client, row.vault, CREATOR_VAULT_ABI, 'fundCampaign', [req], creator);
    if (sim.revert?.name === 'SlippageExceeded') amountOut = BigInt(sim.revert.args[0]);
    else error = sim.ok ? 'Unexpected success' : sim.error;
  }
  let feeBps = null;
  try {
    const config = await client.readContract({ address: release.hub, abi: PLACE_HUB_ABI, functionName: 'config' });
    feeBps = Number(await client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'campaignFeeBps', args: [token] }));
  } catch {
    feeBps = null;
  }
  let stakingFeeBps = null;
  try {
    stakingFeeBps = Number((await client.readContract({ address: release.staking, abi: PLACE_STAKING_ABI, functionName: 'feeConfig' }))[0]);
  } catch {
    stakingFeeBps = null;
  }
  // No swap: the vault spends exactly amountIn, so there is no slippage to allow for.
  const minOut = amountOut == null ? null : rewardToken === fundAsset ? amountOut : (amountOut * BigInt(10_000 - slippageBps)) / BPS;
  const net = (out, bps) => (out == null || bps == null ? null : ((out * BPS) / (BPS + BigInt(bps))).toString());
  return reply(200, {
    chainId,
    token,
    vault: row.vault,
    fundAsset: outAddr(fundAsset),
    rewardToken: outAddr(rewardToken),
    amountIn: amountIn.toString(),
    amountOut: amountOut?.toString() ?? null,
    swap: rewardToken !== fundAsset,
    slippageBps,
    minOut: minOut?.toString() ?? null,
    hubFeeBps: feeBps,
    stakingFeeBps,
    campaignPool: net(minOut, feeBps),
    stakingBudget: net(minOut, stakingFeeBps),
    error,
  });
}

const STREAM_KINDS = { holders: 0, traders: 1 };

/**
 * 0.3.0 Community Pool: the swap quote (dry run of fundCampaign with an impossible minOut), the fee the program
 * pays (distributor stream fee or staking fee), and the ready transaction for the creator.
 */
async function fundQuoteV3(q, deps, { chainId, row, rewardToken, amountIn, slippageBps }) {
  if (!row.community_vault) fail('This token has no community basket', 409);
  const kind = q.kind || 'holders';
  if (kind !== 'staking' && !(kind in STREAM_KINDS)) fail('kind must be holders, traders or staking');
  const vault = row.community_vault;
  const creator = row.current_creator;
  const fundAsset = row.quote;
  const client = deps.client(chainId);
  const now = deps.now();
  const int = (v, name, def, lo, hi) => {
    const n = v == null || v === '' ? def : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} must be ${lo}–${hi}`);
    return n;
  };
  let amountOut;
  let error = null;
  if (rewardToken === fundAsset) amountOut = amountIn;
  else {
    const probe = { kind: 0, fundAsset, amountIn, rewardToken, minOut: maxUint256, startEpoch: BigInt(Math.floor(now / EPOCH) + 1), epochCount: 1n, criterion: 0n, metadataURI: '' };
    const sim = await simulate(client, vault, COMMUNITY_VAULT_ABI, 'fundCampaign', [probe], creator);
    if (sim.revert?.name === 'SlippageExceeded') amountOut = BigInt(sim.revert.args[0]);
    else error = sim.ok ? 'Unexpected success' : sim.error;
  }
  const minOut = amountOut == null ? null : rewardToken === fundAsset ? amountOut : (amountOut * BigInt(10_000 - slippageBps)) / BPS;
  const r = releaseByVersion(chainId, row.version);
  let feeBps = null;
  try {
    feeBps =
      kind === 'staking'
        ? Number((await client.readContract({ address: stakingAddress(chainId), abi: PLACE_STAKING_ABI, functionName: 'feeConfig' }))[0])
        : Number(await client.readContract({ address: r.rewardsDistributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'streamFeeBps' }));
  } catch {
    feeBps = null;
  }
  const epochCount = int(q.epochCount, 'epochCount', 30, 1, 365);
  let tx = null;
  if (minOut != null) {
    if (kind === 'staking') {
      const startTime = int(q.startTime, 'startTime', (Math.floor(now / EPOCH) + 1) * EPOCH, now, now + 365 * EPOCH);
      const req = {
        fundAsset, amountIn, rewardToken, minOut, startTime: BigInt(startTime),
        epochDuration: BigInt(int(q.epochDuration, 'epochDuration', EPOCH, 3600, 30 * EPOCH)),
        epochCount: BigInt(epochCount),
        earlyExitMode: q.earlyExit === '1' ? 1 : 0,
        penaltyBps: int(q.penaltyBps, 'penaltyBps', 0, 0, 5000),
      };
      tx = { to: vault, value: '0', from: creator, data: encodeFunctionData({ abi: COMMUNITY_VAULT_ABI, functionName: 'fundStaking', args: [req] }) };
    } else {
      const startEpoch = int(q.startEpoch, 'startEpoch', Math.floor(now / EPOCH) + 1, Math.floor(now / EPOCH), Math.floor(now / EPOCH) + 30);
      // Holders: at least the token's own minimum (or 10 000 tokens); traders: a daily volume in the pair asset.
      const criterion = q.criterion != null && q.criterion !== '' ? (/^[0-9]{1,78}$/.test(String(q.criterion)) ? BigInt(q.criterion) : fail('criterion must be an integer (smallest units)')) : kind === 'holders' ? BigInt(row.min_holding && row.min_holding !== '0' ? row.min_holding : 10_000n * 10n ** 18n) : 0n;
      const req = { kind: STREAM_KINDS[kind], fundAsset, amountIn, rewardToken, minOut, startEpoch: BigInt(startEpoch), epochCount: BigInt(epochCount), criterion, metadataURI: String(q.metadataURI || '') };
      tx = { to: vault, value: '0', from: creator, data: encodeFunctionData({ abi: COMMUNITY_VAULT_ABI, functionName: 'fundCampaign', args: [req] }) };
    }
  }
  const net = (out, bps) => (out == null || bps == null ? null : ((out * BPS) / (BPS + BigInt(bps))).toString());
  return reply(200, {
    chainId,
    token: row.token,
    version: row.version,
    vault,
    kind,
    fundAsset: outAddr(fundAsset),
    rewardToken: outAddr(rewardToken),
    amountIn: amountIn.toString(),
    amountOut: amountOut?.toString() ?? null,
    swap: rewardToken !== fundAsset,
    slippageBps,
    minOut: minOut?.toString() ?? null,
    feeBps,
    budget: net(minOut, feeBps),
    perEpoch: minOut == null || feeBps == null ? null : (BigInt(net(minOut, feeBps)) / BigInt(epochCount)).toString(),
    epochCount,
    tx,
    error,
  });
}

// ─────────────────────────────── PlaceStaking ───────────────────────────────

function programStatus(p, now) {
  const start = new Date(p.start_time).getTime() / 1000;
  const end = start + Number(p.epoch_duration) * Number(p.epoch_count);
  const openFrom = start - Number(p.epoch_duration);
  if (now >= end) return { status: 'ended', epoch: Number(p.epoch_count), openFrom, end };
  if (now < start) return { status: now >= openFrom ? 'open' : 'upcoming', epoch: null, openFrom, end };
  return { status: 'live', epoch: Math.floor((now - start) / Number(p.epoch_duration)), openFrom, end };
}

/**
 * USD prices of staking and reward tokens: a pair asset at its pair price, a Place launch at its last pool price
 * times its pair price. Anything else has no price (null). Also the contract URI (logo) of Place launches.
 */
export async function tokenUsd(deps, chainId, addrs, meta) {
  const launches = await deps.db.query('select token, quote, price, contract_uri from launch_tokens where chain_id = $1 and token = any($2::text[])', [chainId, addrs]);
  const byToken = new Map(launches.map((r) => [r.token, r]));
  const quotes = [...new Set([...addrs.filter((a) => !byToken.has(a)), ...launches.map((r) => r.quote)])];
  await ensureTokenMeta(deps, chainId, quotes.filter((a) => a !== ETH && !meta.has(a)));
  const qmeta = new Map((await deps.db.query('select address, symbol from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, quotes])).map((m) => [m.address, m.symbol]));
  const qusd = await quoteUsd(deps, quotes.map((qt) => ({ quote: qt, symbol: qt === ETH ? 'ETH' : qmeta.get(qt) })));
  const out = new Map();
  for (const a of addrs) {
    const l = byToken.get(a);
    if (l) out.set(a, l.price != null && qusd.get(l.quote) != null ? Number(l.price) * qusd.get(l.quote) : null);
    else out.set(a, qusd.get(a) ?? null);
  }
  return { usd: out, uri: new Map(launches.map((r) => [r.token, r.contract_uri || null])) };
}

async function stakingView(deps, chainId, rows, now) {
  const addrs = [...new Set(rows.flatMap((p) => [p.staking_token, p.reward_currency]).filter((a) => a !== ETH))];
  await ensureTokenMeta(deps, chainId, addrs);
  const meta = new Map((await deps.db.query('select address, symbol, name, decimals from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, addrs])).map((m) => [m.address, m]));
  const { usd, uri } = await tokenUsd(deps, chainId, [...new Set(rows.flatMap((p) => [p.staking_token, p.reward_currency]))], meta);
  const tokenInfo = (a) =>
    a === ETH
      ? { address: 'eth', symbol: 'ETH', decimals: 18, usd: usd.get(a) ?? null }
      : { address: a, symbol: meta.get(a)?.symbol ?? null, name: meta.get(a)?.name ?? null, decimals: meta.get(a)?.decimals ?? 18, usd: usd.get(a) ?? null, contractURI: uri.get(a) ?? null };
  return rows.map((p) => {
    const s = programStatus(p, now);
    return {
      id: p.vault_id,
      staking: p.staking,
      creator: p.creator,
      fromLaunchVault: p.vault === p.creator || (p.community_vault != null && p.community_vault === p.creator), // creator vault (0.2.0) or Community Pool (0.3.0)
      launchedOnPlace: Boolean(p.launch_token),
      stakingToken: tokenInfo(p.staking_token),
      rewardToken: tokenInfo(p.reward_currency),
      startTime: iso(p.start_time),
      epochDuration: Number(p.epoch_duration),
      epochCount: Number(p.epoch_count),
      rewardPerEpoch: p.reward_per_epoch,
      totalReward: p.total_reward,
      protocolFee: p.protocol_fee,
      feeBps: Number(p.fee_bps),
      earlyExit: Number(p.early_exit_mode) === 1,
      penaltyBps: Number(p.penalty_bps),
      totalStaked: p.total_staked,
      claimed: p.claimed,
      stakers: Number(p.stakers || 0),
      status: s.status,
      currentEpoch: s.epoch,
      depositsOpenAt: iso(s.openFrom * 1000),
      endsAt: iso(s.end * 1000),
      createdAt: iso(p.created_at),
      createdTx: p.created_tx,
      position: p.my_staked != null ? { staked: p.my_staked, claimed: p.my_claimed } : null,
    };
  });
}

const STAKING_SELECT = `
  select p.*, p.reward_per_epoch::text as reward_per_epoch, p.total_reward::text as total_reward, p.protocol_fee::text as protocol_fee,
    p.total_staked::text as total_staked, p.claimed::text as claimed, lt.token as launch_token, lt.vault,
    (select le.community_vault from launch_economy le where le.chain_id = p.chain_id and le.token = p.staking_token) as community_vault,
    (select count(*)::int from staking_positions sp where sp.chain_id = p.chain_id and sp.vault_id = p.vault_id and sp.staked > 0) as stakers`;

/** Programs for one token (token page). */
export async function stakingForToken(deps, chainId, token, now) {
  const rows = await deps.db.query(
    `${STAKING_SELECT} from staking_programs p left join launch_tokens lt on lt.chain_id = p.chain_id and lt.token = p.staking_token
     where p.chain_id = $1 and p.staking_token = $2 and not p.hidden order by p.created_at desc limit 50`,
    [chainId, token]
  );
  return stakingView(deps, chainId, rows, now);
}

async function listStaking({ query: q }, deps) {
  const { chainId } = chainParts(q);
  if (deps.refresh) await deps.refresh(chainId).catch(() => {});
  const params = [chainId];
  const where = ['p.chain_id = $1', 'not p.hidden'];
  if (q.token) {
    params.push(addressOf(q.token, 'token'));
    where.push(`p.staking_token = $${params.length}`);
  }
  if (q.creator) {
    params.push(addressOf(q.creator, 'creator'));
    where.push(`(p.creator = $${params.length} or lt.current_creator = $${params.length})`);
  }
  let mine = ', null as my_staked, null as my_claimed';
  let join = '';
  if (q.account) {
    params.push(addressOf(q.account, 'account'));
    mine = ', me.staked::text as my_staked, me.claimed::text as my_claimed';
    join = `left join staking_positions me on me.chain_id = p.chain_id and me.vault_id = p.vault_id and me.account = $${params.length}`;
    if (q.mine === '1') where.push('me.account is not null');
  }
  const limit = Math.min(Number(q.limit) || 50, 200);
  const rows = await deps.db.query(
    `${STAKING_SELECT}${mine} from staking_programs p left join launch_tokens lt on lt.chain_id = p.chain_id and lt.token = p.staking_token ${join}
     where ${where.join(' and ')} order by p.created_at desc limit ${limit}`,
    params
  );
  const now = deps.now();
  return reply(200, { chainId, staking: stakingAddress(chainId), programs: await stakingView(deps, chainId, rows, now) }, q.account ? 'no-store' : 'public, max-age=10');
}

async function stakingPosition({ query: q }, deps) {
  const { chainId, d } = chainParts(q);
  const id = String(q.id || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) fail('id must be a staking program id (bytes32)');
  const account = addressOf(q.account, 'account');
  const [p] = await deps.db.query(`${STAKING_SELECT} from staking_programs p left join launch_tokens lt on lt.chain_id = p.chain_id and lt.token = p.staking_token where p.chain_id = $1 and p.vault_id = $2`, [chainId, id]);
  if (!p) fail('Unknown staking program (or not indexed yet)', 404);
  const client = deps.client(chainId);
  const now = deps.now();
  const staking = p.staking;
  const read = (functionName, args) => retry(() => client.readContract({ address: staking, abi: PLACE_STAKING_ABI, functionName, args }));
  const [userState, lotsPage] = await Promise.all([read('getUserState', [id, account]), read('getUserLots', [id, account, 0n, 100n])]);
  const [lots] = lotsPage;
  const start = Math.floor(new Date(p.start_time).getTime() / 1000);
  const dur = Number(p.epoch_duration);
  const ended = Math.max(0, Math.min(Number(p.epoch_count), Math.floor((now - start) / dur)));
  const epochs = [...Array(ended).keys()].map(BigInt);
  let claimable = [];
  if (epochs.length) {
    const res = await retry(() =>
      client.multicall({
        contracts: epochs.flatMap((e) => [
          { address: staking, abi: PLACE_STAKING_ABI, functionName: 'isClaimed', args: [id, account, e] },
          { address: staking, abi: PLACE_STAKING_ABI, functionName: 'previewClaim', args: [id, account, [e]] },
        ]),
        allowFailure: true,
      })
    );
    claimable = epochs
      .map((e, i) => ({ epoch: Number(e), claimed: res[2 * i].result === true, reward: res[2 * i + 1].status === 'success' ? res[2 * i + 1].result : 0n }))
      .filter((x) => !x.claimed && x.reward > 0n);
  }
  const total = claimable.reduce((s, x) => s + x.reward, 0n);
  const [s] = await stakingView(deps, chainId, [{ ...p, my_staked: null }], now);
  return reply(
    200,
    {
      chainId,
      program: s,
      account,
      staked: userState[1].toString(),
      lots: lots.map((l, i) => ({ lotId: i, amount: l.remainingAmount.toString(), eligibleAt: iso(Number(l.eligibleAt) * 1000), unlockAt: iso(Number(l.unlockAt) * 1000), unlocked: Number(l.unlockAt) <= now })).filter((l) => l.amount !== '0'),
      claimable: { total: total.toString(), epochs: claimable.map((x) => ({ epoch: x.epoch, reward: x.reward.toString() })) },
      tx: {
        claim: claimable.length ? { to: staking, value: '0', data: encodeFunctionData({ abi: PLACE_STAKING_ABI, functionName: 'claim', args: [id, claimable.map((x) => BigInt(x.epoch)), account] }) } : null,
      },
      stakingContract: p.staking || stakingAddress(chainId) || d.staking,
    },
    'no-store'
  );
}

export const ECONOMY_ROUTES = {
  'GET launch/fund-quote': fundQuote,
  'GET launch/staking': listStaking,
  'GET launch/staking/position': stakingPosition,
};
