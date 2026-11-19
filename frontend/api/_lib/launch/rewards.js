// Place Launch 0.3.0 in the API: Economy launches, burn in the token, daily reward streams of the
// PlaceRewardsDistributor and the community vault.
//
//   GET launch/reward-tokens ?chain&quote=<address|eth>
//       what a launch on this pair may pay holder / trader rewards in: the pair itself (source 'pair'), the
//       launched token (address 'self', source 'self') and every listed route target of the reward token
//       registry (source 'route'); each with its picker tab (category: majors, stocks or crypto; none for 'self'),
//       an icon URL when one is known (logo), the contractURI of tokens launched on Place and placeLaunch
//   GET launch/rewards ?chain&account
//       what the account can claim from every stream (cumulative amount, proof, already claimed) and one
//       ready claimMany transaction per distributor; amounts of tables not published yet are `pending`
//
// The token page (`economy`, `burn`, `rewards`, `revenue` in launch/token) and the creator panel (vault and
// community pool in launch/creator) use the helpers exported here.
import { encodeFunctionData } from 'viem';
import { CREATOR_VAULT_ABI, COMMUNITY_VAULT_ABI, FEE_ESCROW_ABI, REWARDS_DISTRIBUTOR_ABI } from '../../../src/launch/abi.js';
import { launchDeployment, deployedReleases, releaseByVersion } from '../../../src/launch/deployments.js';
import { reply, fail, chainOf, addressOf, iso } from '../place/http.js';
import { ensureTokenMeta } from '../place/tokenMeta.js';
import { retry } from '../place/chain.js';
import { EPOCH } from './indexer.js';
import { rates, ratesPercent } from './taxMath.js';
import { CRYPTO_SYMBOLS, pairCategory, pairIcon } from '../../../src/launch/pairs.js';
import { stockCategory } from '../../../src/launch/stockCategories.js';

const ETH = '0x0000000000000000000000000000000000000000';
const outAddr = (a) => (a === ETH ? 'eth' : a);
const lower = (a) => (a == null ? a : String(a).toLowerCase());
const STREAM_KIND = ['holders', 'traders'];
export const PERCENT = 1_000_000; // shares in the API: percent with 6 decimals from 1e8 shares

function chainParts(q) {
  const chainId = chainOf(q);
  const d = launchDeployment(chainId);
  if (!d) fail(`Place Launch is not deployed on chain ${chainId}`);
  return { chainId, d };
}

/** The reward token registry new launches use: the current release's, or the newest deployed one's before it exists. */
export function rewardRegistry(chainId) {
  const d = launchDeployment(chainId);
  if (d?.rewardTokenRegistry) return d.rewardTokenRegistry;
  return deployedReleases(chainId).find((r) => r.rewardTokenRegistry)?.rewardTokenRegistry ?? null;
}

export async function metaOf(deps, chainId, addrs) {
  const erc = [...new Set(addrs.filter((a) => a && a !== ETH))];
  await ensureTokenMeta(deps, chainId, erc);
  const rows = erc.length ? await deps.db.query('select address, symbol, name, decimals from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, erc]) : [];
  const launches = erc.length ? await deps.db.query('select token, symbol, name, contract_uri from launch_tokens where chain_id = $1 and token = any($2::text[])', [chainId, erc]) : [];
  const m = new Map(rows.map((r) => [r.address, { symbol: r.symbol, name: r.name, decimals: r.decimals == null ? 18 : Number(r.decimals) }]));
  for (const l of launches) m.set(l.token, { symbol: l.symbol, name: l.name, decimals: 18, contractURI: l.contract_uri || null });
  return (a) => (a === ETH ? { address: 'eth', symbol: 'ETH', name: 'Ether', decimals: 18 } : { address: a, symbol: m.get(a)?.symbol ?? null, name: m.get(a)?.name ?? null, decimals: m.get(a)?.decimals ?? 18, contractURI: m.get(a)?.contractURI ?? null });
}

// ─────────────────────────────── reward tokens for the launch form ───────────────────────────────

const MAJORS = new Set(CRYPTO_SYMBOLS.map((x) => x.toLowerCase()));

/**
 * The picker tab of a reward token: 'majors' (ETH, USDC and the Coinbase-wrapped majors), 'stocks' (a tokenized stock:
 * a known ticker, or a stock pair asset of the factory) or 'crypto' (any other token, Place launches included).
 */
export function rewardTokenCategory(symbol, { quote = false } = {}) {
  const sym = String(symbol || '');
  if (MAJORS.has(sym.toLowerCase())) return 'majors';
  if (stockCategory(sym) || (quote && pairCategory(sym) === 'stocks')) return 'stocks';
  return 'crypto';
}

/** Reward token options of a pair: the pair, the token itself ('self'), listed routes from the pair. */
export async function rewardTokenOptions(deps, chainId, quote) {
  const registry = rewardRegistry(chainId);
  const routes = registry
    ? await deps.db.query('select to_token from launch_reward_routes where chain_id = $1 and registry = $2 and from_token = $3 and active order by to_token', [chainId, registry, quote])
    : [];
  const targets = routes.map((r) => r.to_token).filter((a) => a !== quote);
  const info = await metaOf(deps, chainId, [quote, ...targets]);
  const erc = [quote, ...targets].filter((a) => a !== ETH);
  const quotes = new Set(erc.length ? (await deps.db.query('select quote from launch_quotes where chain_id = $1 and quote = any($2::text[]) and registered', [chainId, erc])).map((r) => r.quote) : []);
  const launched = new Set(erc.length ? (await deps.db.query('select token from launch_tokens where chain_id = $1 and token = any($2::text[])', [chainId, erc])).map((r) => r.token) : []);
  const view = (a, source) => {
    const { address, symbol, name, decimals, contractURI } = info(a);
    const category = rewardTokenCategory(symbol, { quote: a === quote || quotes.has(a) });
    return {
      address,
      symbol,
      name,
      decimals,
      source,
      category,
      logo: category === 'crypto' ? null : pairIcon({ symbol }),
      contractURI: contractURI ?? null,
      placeLaunch: launched.has(a),
    };
  };
  return [
    view(quote, 'pair'),
    { address: 'self', symbol: null, name: null, decimals: 18, source: 'self', category: null, logo: null, contractURI: null, placeLaunch: true },
    ...targets.map((a) => view(a, 'route')),
  ];
}

async function getRewardTokens({ query: q }, deps) {
  const { chainId } = chainParts(q);
  const quote = q.quote === 'eth' || q.quote === 'ETH' || q.quote == null || q.quote === '' ? ETH : addressOf(q.quote, 'quote');
  return reply(200, { chainId, quote: outAddr(quote), registry: rewardRegistry(chainId), tokens: await rewardTokenOptions(deps, chainId, quote) }, 'public, max-age=30');
}

// ─────────────────────────────── economics of a token ───────────────────────────────

const share = (v) => (v == null ? null : Number(v) / PERCENT); // 1e8 → percent
const ratePct = (v) => (v == null ? null : Number(v) / PERCENT); // tax rate 1e8 = 100% → percent

/** The frozen 0.3.0 economics of a token row (launch_economy columns), for the token page and the feed. */
export function economyView(r) {
  if (!r.launch_type) return null;
  const buy = ratePct(r.buy_tax_rate);
  const sell = ratePct(r.sell_tax_rate);
  const shares = { creator: share(r.creator_share), holders: share(r.holders_share), traders: share(r.traders_share), burn: share(r.burn_share), community: share(r.community_share) };
  // Of each trade, exactly as the hook splits it (the platform takes 30% of the tax, the baskets the rest).
  const tax = {
    creatorAllocationShare: r.creator_share ?? 0,
    holderAllocationShare: r.holders_share ?? 0,
    traderAllocationShare: r.traders_share ?? 0,
    burnAllocationShare: r.burn_share ?? 0,
    communityAllocationShare: r.community_share ?? 0,
  };
  const side = (rate) => {
    if (rate == null) return null;
    try {
      return ratesPercent(rates(rate, tax));
    } catch {
      return null;
    }
  };
  return {
    launchType: r.launch_type,
    buyTax: buy,
    sellTax: sell,
    shares,
    perTrade: { buy: side(r.buy_tax_rate), sell: side(r.sell_tax_rate) },
    minHolding: r.min_holding == null ? null : String(r.min_holding),
    minTraderDailyVolume: r.min_trader_volume == null ? null : String(r.min_trader_volume),
    rewardToken: r.reward_token ? outAddr(r.reward_token) : null,
    creatorVault: r.creator_vault || null,
    communityVault: r.community_vault || null,
    antiSnipe: r.anti_snipe,
    configVersion: r.config_version == null ? null : String(r.config_version),
  };
}

// ─────────────────────────────── burn ───────────────────────────────

/** Burn of a 0.3.0 token: what waits in FeeEscrow (live), what was credited and burned, history, the burn tx. */
export async function burnView(deps, chainId, token, version, limit = 50) {
  const r = releaseByVersion(chainId, version);
  const [s] = await deps.db.query(
    `select (select coalesce(sum(amount), 0)::text from launch_tax_credits where chain_id = $1 and token = $2 and kind = 'burn') as credited,
            (select coalesce(sum(amount), 0)::text from launch_burns where chain_id = $1 and token = $2) as burned,
            (select count(*)::int from launch_burns where chain_id = $1 and token = $2) as n`,
    [chainId, token]
  );
  const rows = await deps.db.query(`select caller, amount::text as amount, tx, at from launch_burns where chain_id = $1 and token = $2 order by block desc, log_index desc limit ${Number(limit)}`, [chainId, token]);
  let pendingBurn = null;
  if (r?.feeEscrow) {
    try {
      pendingBurn = (await retry(() => deps.client(chainId).readContract({ address: r.feeEscrow, abi: FEE_ESCROW_ABI, functionName: 'pendingBurn', args: [token] }))).toString();
    } catch {
      pendingBurn = null; // chain not readable: the page shows credited − burned instead
    }
  }
  const fallback = (BigInt(s.credited) - BigInt(s.burned)).toString();
  return {
    feeEscrow: r?.feeEscrow ?? null,
    pendingBurn: pendingBurn ?? fallback,
    pendingLive: pendingBurn != null,
    credited: s.credited,
    burned: s.burned,
    count: s.n,
    list: rows.map((b) => ({ caller: b.caller, amount: b.amount, tx: b.tx, at: iso(b.at) })),
    tx: r?.feeEscrow ? { to: r.feeEscrow, value: '0', data: encodeFunctionData({ abi: FEE_ESCROW_ABI, functionName: 'burn', args: [token] }) } : null,
  };
}

/** Lifetime tax credits of a 0.3.0 token per basket (creator revenue, protocol revenue…), in the pair asset. */
export async function revenueView(db, chainId, token) {
  const rows = await db.query(`select kind, coalesce(sum(amount), 0)::text as total from launch_tax_credits where chain_id = $1 and token = $2 group by kind`, [chainId, token]);
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
  return { protocol: by.protocol ?? '0', antiSnipe: by.anti_snipe ?? '0', creator: by.creator ?? '0', holders: by.holders ?? '0', traders: by.traders ?? '0', community: by.community ?? '0', burnTokens: by.burn ?? '0' };
}

// ─────────────────────────────── reward streams ───────────────────────────────

export const STREAM_SELECT = `
  select s.*, s.start_epoch::text as start_epoch, s.epoch_count::text as epoch_count, s.reward_per_epoch::text as reward_per_epoch,
    s.criterion::text as criterion, s.fee::text as fee, s.last_closed_epoch::text as last_closed_epoch, s.funded::text as funded,
    s.allocated::text as allocated, s.claimed::text as claimed, s.reclaimed::text as reclaimed, s.root_epoch::text as root_epoch,
    (select coalesce(sum(e.collected), 0) from reward_epochs e where e.chain_id = s.chain_id and e.stream_id = s.stream_id)::text as collected,
    (select coalesce(sum(x.amount), 0) from reward_stream_events x where x.chain_id = s.chain_id and x.stream_id = s.stream_id and x.kind = 'converted')::text as converted_in
  from reward_streams s`;

/** What waits in the pair asset for a conversion into the reward token (economy streams paying another token). */
export const pendingInput = (s) => (s.economy && s.reward_token !== s.source ? BigInt(s.collected) - BigInt(s.converted_in) : 0n);

export function streamView(s, info, now, epochs = null) {
  const current = Math.floor(now / EPOCH);
  const start = Number(s.start_epoch);
  const count = Number(s.epoch_count);
  const end = count ? start + count : null;
  const status = current < start ? 'upcoming' : end != null && current >= end ? 'ended' : 'live';
  return {
    id: s.stream_id,
    distributor: s.distributor,
    token: s.token,
    kind: STREAM_KIND[Number(s.kind)] ?? String(s.kind),
    economy: s.economy,
    official: s.economy || Boolean(s.from_vault),
    rewardToken: info(s.reward_token),
    source: s.source ? outAddr(s.source) : null,
    funder: s.funder,
    criterion: s.criterion,
    startEpoch: start,
    epochCount: count || null,
    rewardPerEpoch: s.reward_per_epoch,
    status,
    currentEpoch: current,
    nextCloseAt: iso((current + 1) * EPOCH * 1000),
    lastClosedEpoch: s.last_closed_epoch == null ? null : Number(s.last_closed_epoch),
    funded: s.funded,
    allocated: s.allocated,
    claimed: s.claimed,
    reclaimed: s.reclaimed,
    unallocated: (BigInt(s.funded) - BigInt(s.allocated)).toString(),
    pendingConversion: pendingInput(s).toString(),
    root: s.root,
    rootEpoch: s.root_epoch == null ? null : Number(s.root_epoch),
    rootURI: s.root_uri,
    metadataURI: s.metadata_uri || null,
    createdAt: iso(s.created_at),
    createdTx: s.created_tx,
    ...(epochs ? { epochs } : {}),
  };
}

/** Every stream of a token (Economy baskets and funded campaigns) with its last closed epochs and tables. */
export async function streamsForToken(deps, chainId, token, now, { communityVault = null, epochLimit = 14 } = {}) {
  const rows = await deps.db.query(`${STREAM_SELECT} where s.chain_id = $1 and s.token = $2 order by s.economy desc, s.created_block desc limit 50`, [chainId, token]);
  return streamsWithEpochs(deps, chainId, rows, now, { communityVault, epochLimit });
}

/** One stream by id with its last closed epochs and tables (rewards hub), or null. */
export async function streamById(deps, chainId, id, now, { epochLimit = 30 } = {}) {
  const rows = await deps.db.query(`${STREAM_SELECT} where s.chain_id = $1 and s.stream_id = $2`, [chainId, id]);
  const [s] = await streamsWithEpochs(deps, chainId, rows, now, { epochLimit });
  return s ? { view: s, row: rows[0] } : null;
}

async function streamsWithEpochs(deps, chainId, rows, now, { communityVault = null, epochLimit = 14 } = {}) {
  if (!rows.length) return [];
  const info = await metaOf(deps, chainId, rows.map((r) => r.reward_token));
  const ids = rows.map((r) => r.stream_id);
  const epochs = await deps.db.query(
    `select e.stream_id, e.epoch::text as epoch, e.collected::text as collected, e.total_funded::text as total_funded, e.tx, e.at,
            t.status, t.budget::text as budget, t.eligible, t.uri, t.cumulative_total::text as cumulative_total
     from reward_epochs e left join reward_tables t on t.chain_id = e.chain_id and t.stream_id = e.stream_id and t.epoch = e.epoch
     where e.chain_id = $1 and e.stream_id = any($2::text[]) order by e.epoch desc`,
    [chainId, ids]
  );
  const fromVault = communityVault
    ? new Set((await deps.db.query(`select ref from launch_vault_events where chain_id = $1 and vault = $2 and kind = 'fund_stream'`, [chainId, communityVault])).map((r) => r.ref))
    : new Set();
  return rows.map((s) => {
    const list = epochs
      .filter((e) => e.stream_id === s.stream_id)
      .slice(0, epochLimit)
      .map((e) => ({
        epoch: Number(e.epoch),
        day: iso(Number(e.epoch) * EPOCH * 1000).slice(0, 10),
        collected: e.collected,
        totalFunded: e.total_funded,
        closedAt: iso(e.at),
        closeTx: e.tx,
        table: e.status ? { status: e.status, budget: e.budget, eligible: e.eligible, uri: e.uri, cumulativeTotal: e.cumulative_total } : null,
      }));
    return streamView({ ...s, from_vault: fromVault.has(s.stream_id) }, info, now, list);
  });
}

// ─────────────────────────────── rewards of an account ───────────────────────────────

/**
 * Claimable rewards of `account` over every stream: per stream the newest published table that has the account
 * (its cumulative amount and proof), what the distributor already paid, and pending amounts of newer tables.
 */
export async function accountRewards(deps, chainId, account, { token = null } = {}) {
  const params = [chainId, account];
  let tokenFilter = '';
  if (token) {
    params.push(token);
    tokenFilter = ` and s.token = $${params.length}`;
  }
  // The published leaf of each stream: the table whose root is the stream's current root.
  const rows = await deps.db.query(
    `select s.stream_id, s.distributor, s.token, s.kind, s.reward_token, s.root, a.epoch::text as epoch, a.cumulative::text as cumulative, a.proof,
            (select coalesce(max(c.cumulative), 0) from reward_claims c where c.chain_id = s.chain_id and c.stream_id = s.stream_id and c.account = $2)::text as claimed
     from reward_streams s
     join reward_tables t on t.chain_id = s.chain_id and t.stream_id = s.stream_id and t.root = s.root
     join reward_allocations a on a.chain_id = t.chain_id and a.stream_id = t.stream_id and a.epoch = t.epoch and a.account = $2
     where s.chain_id = $1${tokenFilter}`,
    params
  );
  // Tables built or sent but not published yet: the account's cumulative there minus the published one.
  const pending = await deps.db.query(
    `select a.stream_id, max(a.cumulative)::text as cumulative from reward_allocations a
     join reward_tables t on t.chain_id = a.chain_id and t.stream_id = a.stream_id and t.epoch = a.epoch and t.status in ('built', 'sent')
     join reward_streams s on s.chain_id = a.chain_id and s.stream_id = a.stream_id
     where a.chain_id = $1 and a.account = $2${tokenFilter} group by a.stream_id`,
    params
  );
  // The distributor's own claimedBy, when the chain answers (the index may lag a few seconds behind a claim).
  if (rows.length && deps.client) {
    try {
      const res = await retry(() =>
        deps.client(chainId).multicall({
          contracts: rows.map((r) => ({ address: r.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claimedBy', args: [r.stream_id, account] })),
          allowFailure: true,
        })
      );
      res.forEach((x, i) => {
        if (x.status === 'success' && BigInt(x.result) > BigInt(rows[i].claimed)) rows[i].claimed = x.result.toString();
      });
    } catch {
      // keep the indexed value
    }
  }
  const tokens = [...new Set([...rows.map((r) => r.token), ...rows.map((r) => r.reward_token)])];
  const info = await metaOf(deps, chainId, tokens);
  const published = new Map(rows.map((r) => [r.stream_id, r]));
  const items = rows.map((r) => {
    const claimable = BigInt(r.cumulative) - BigInt(r.claimed);
    return {
      streamId: r.stream_id,
      distributor: r.distributor,
      token: info(r.token),
      kind: STREAM_KIND[Number(r.kind)] ?? String(r.kind),
      rewardToken: info(r.reward_token),
      epoch: Number(r.epoch),
      cumulative: r.cumulative,
      claimed: r.claimed,
      claimable: (claimable > 0n ? claimable : 0n).toString(),
      proof: JSON.parse(r.proof),
    };
  });
  const pendingList = pending
    .map((p) => {
      const base = published.get(p.stream_id);
      const more = BigInt(p.cumulative) - BigInt(base?.cumulative ?? 0);
      return { streamId: p.stream_id, amount: more > 0n ? more.toString() : '0' };
    })
    .filter((p) => p.amount !== '0');
  const due = items.filter((i) => i.claimable !== '0');
  const byDistributor = new Map();
  for (const i of due) byDistributor.set(i.distributor, [...(byDistributor.get(i.distributor) || []), i]);
  const txs = [...byDistributor].map(([distributor, list]) => ({
    to: distributor,
    value: '0',
    streams: list.map((i) => i.streamId),
    data: encodeFunctionData({
      abi: REWARDS_DISTRIBUTOR_ABI,
      functionName: 'claimMany',
      args: [list.map((i) => ({ streamId: i.streamId, account, cumulativeAmount: BigInt(i.cumulative), proof: i.proof }))],
    }),
  }));
  // Totals per reward token (smallest units), for the "Claim all" button.
  const totals = {};
  for (const i of due) {
    const k = i.rewardToken.address;
    totals[k] = (BigInt(totals[k] ?? 0) + BigInt(i.claimable)).toString();
  }
  return { rewards: items, pending: pendingList, totals, claimMany: txs };
}

async function getRewards({ query: q }, deps) {
  const { chainId } = chainParts(q);
  const account = addressOf(q.account, 'account');
  const token = q.token ? addressOf(q.token, 'token') : null;
  if (deps.refresh) await deps.refresh(chainId).catch(() => {});
  const today = token ? await accountToday(deps, chainId, account, token) : null;
  return reply(200, { chainId, account, ...(await accountRewards(deps, chainId, account, { token })), today }, 'no-store');
}

/** Where the account stands today for one token: its indexed balance and its counted volume of the current UTC day. */
async function accountToday(deps, chainId, account, token) {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const epoch = Math.floor(now / EPOCH);
  const [bal] = await deps.db.query('select balance::text as balance from launch_balances where chain_id = $1 and token = $2 and account = $3', [chainId, token, account]);
  const [vol] = await deps.db.query('select volume::text as volume from launch_trader_volume where chain_id = $1 and token = $2 and epoch = $3 and trader = $4', [chainId, token, epoch, account]);
  return { epoch, balance: bal?.balance ?? '0', volume: vol?.volume ?? '0', closesAt: iso((epoch + 1) * EPOCH * 1000) };
}

// ─────────────────────────────── creator panel (0.3.0) ───────────────────────────────

async function simulate(client, address, abi, functionName, args, account) {
  try {
    const { result } = await client.simulateContract({ address, abi, functionName, args, account });
    return { ok: true, result };
  } catch (e) {
    const hit = typeof e?.walk === 'function' ? e.walk((x) => x?.data?.errorName) : null;
    return { ok: false, error: hit ? `${hit.data.errorName}(${(hit.data.args || []).map(String).join(', ')})` : e?.shortMessage || e?.message || String(e) };
  }
}

const COMMUNITY_READS = ['pendingFees', 'lastFundSpendAt', 'settings', 'quote', 'currentCreator', 'token'];
// 0.3.1 only: a 0.3.0 vault has none of these, so they are read apart and may fail.
const COMMUNITY_READS_031 = ['nftFactory', 'priceGuard', 'lastNftCampaignAt', 'NFT_CAMPAIGN_COOLDOWN', 'MAX_NFT_CAMPAIGN_BPS', 'totalBurned'];

/** Collections of the NFT launchpad paired with `token`: official first, then the most minted; why each can or cannot get a pool campaign. */
export async function poolNftCollections(db, chainId, token, factory) {
  let rows;
  try {
    rows = await db.query(
      `select address, factory, name, symbol, official, kind, total_minted, mint_price::text as mint_price from nft_launch_collections
       where chain_id = $1 and token = $2 order by official desc, total_minted desc, created_at asc limit 50`,
      [chainId, token]
    );
  } catch {
    return []; // the NFT launchpad tables are not migrated yet
  }
  return rows.map((r) => {
    const reason =
      factory && r.factory !== factory
        ? 'Made by another NFT factory'
        : !r.official
          ? 'Not official: only collections of the token’s creator'
          : r.mint_price === '0'
            ? 'Free mint: only paid collections'
            : Number(r.total_minted) === 0
              ? 'Nothing minted yet'
              : null;
    return { address: r.address, name: r.name, symbol: r.symbol, official: r.official, kind: r.kind, totalMinted: Number(r.total_minted), mintPrice: r.mint_price, eligible: reason == null, reason };
  });
}

/** What the creator can do with the pool beyond streams and staking (0.3.1): NFT holder campaigns and buyback & burn. */
async function poolActions031(deps, chainId, vault, v, now) {
  const client = deps.client(chainId);
  let x;
  try {
    const res = await retry(() => client.multicall({ contracts: COMMUNITY_READS_031.map((functionName) => ({ address: vault, abi: COMMUNITY_VAULT_ABI, functionName })), allowFailure: true }));
    if (res.some((r) => r.status !== 'success')) return { supported: false, reason: 'This Community Pool was made by Place Launch 0.3.0: NFT campaigns and buybacks came with 0.3.1' };
    x = Object.fromEntries(COMMUNITY_READS_031.map((k, i) => [k, res[i].result]));
  } catch {
    return { supported: false, reason: 'Could not read the community vault' };
  }
  const factory = lower(x.nftFactory);
  const last = Number(x.lastNftCampaignAt);
  const nextAt = last === 0 ? 0 : last + Number(x.NFT_CAMPAIGN_COOLDOWN);
  const nftOn = factory !== ETH;
  const buybackOn = lower(x.priceGuard) !== ETH && lower(v.settings.rewardRegistry) !== ETH;
  return {
    supported: true,
    nft: {
      available: nftOn,
      reason: nftOn ? null : 'This pool has no NFT factory',
      factory: nftOn ? factory : null,
      maxBps: Number(x.MAX_NFT_CAMPAIGN_BPS),
      cooldown: Number(x.NFT_CAMPAIGN_COOLDOWN),
      lastAt: last ? iso(last * 1000) : null,
      nextAt: nextAt > now ? iso(nextAt * 1000) : null,
      collections: nftOn ? await poolNftCollections(deps.db, chainId, lower(v.token), factory) : [],
    },
    buyback: {
      available: buybackOn,
      reason: buybackOn ? null : 'Buybacks need the PlacePriceGuard and the reward token registry',
      priceGuard: lower(x.priceGuard),
      totalBurned: x.totalBurned.toString(),
    },
  };
}

/** Community Pool of a 0.3.0 token: balance, default campaign state and the calls the creator (or anyone) can make. */
export async function communityPanel(deps, chainId, vault, now, { creator = null } = {}) {
  if (!vault) return null;
  const client = deps.client(chainId);
  let v;
  try {
    const res = await retry(() => client.multicall({ contracts: COMMUNITY_READS.map((functionName) => ({ address: vault, abi: COMMUNITY_VAULT_ABI, functionName })), allowFailure: false }));
    v = Object.fromEntries(COMMUNITY_READS.map((k, i) => [k, res[i]]));
    v.fund = await retry(() => client.readContract({ address: vault, abi: COMMUNITY_VAULT_ABI, functionName: 'fundBalance', args: [v.quote] }));
  } catch {
    return { address: vault, error: 'Could not read the community vault' };
  }
  const s = v.settings;
  const quote = lower(v.quote);
  const nextAt = Number(v.lastFundSpendAt) + Number(s.defaultCampaignDelay);
  const minimum = BigInt(s.defaultCampaignMinimum || 0n);
  const total = v.fund + v.pendingFees;
  const def = await simulate(client, vault, COMMUNITY_VAULT_ABI, 'startDefaultCampaign', [], creator || lower(v.currentCreator));
  const tx = (functionName, args = []) => ({ to: vault, value: '0', data: encodeFunctionData({ abi: COMMUNITY_VAULT_ABI, functionName, args }) });
  const history = await deps.db.query(
    `select kind, amount::text as amount, amount2::text as amount2, account, ref, data, tx, at from launch_vault_events where chain_id = $1 and vault = $2 order by block desc, log_index desc limit 30`,
    [chainId, vault]
  );
  return {
    address: vault,
    quote: outAddr(quote),
    balance: v.fund.toString(),
    pendingFees: v.pendingFees.toString(),
    afterCollect: total.toString(),
    settings: {
      distributor: lower(s.distributor),
      staking: lower(s.staking),
      rewardRegistry: lower(s.rewardRegistry),
      defaultCampaignDelay: Number(s.defaultCampaignDelay),
      defaultCampaignEpochs: Number(s.defaultCampaignEpochs),
      defaultCampaignMinimum: minimum.toString(),
      defaultMinHolding: s.defaultMinHolding.toString(),
    },
    lastFundSpendAt: iso(Number(v.lastFundSpendAt) * 1000),
    defaultCampaign: {
      nextAt: iso(nextAt * 1000),
      due: nextAt <= now && total >= (minimum || 1n),
      canStart: def.ok,
      reason: def.ok ? null : def.error,
      tx: tx('startDefaultCampaign'),
    },
    collectTx: tx('collect'),
    creator: lower(v.currentCreator),
    actions: await poolActions031(deps, chainId, vault, v, now),
    // fundCampaign / fundStaking / fundNftCampaign / buybackAndBurn need amounts and a quote: GET launch/fund-quote
    // returns the encoded call.
    fundQuote: `launch/fund-quote?token=<token>&rewardToken=<address|eth>&amountIn=<units>&kind=holders|traders|staking|nft|buyback`,
    history: history.map((h) => ({ kind: h.kind, amount: h.amount, amount2: h.amount2, account: h.account, ref: h.ref, data: h.data ? JSON.parse(h.data) : null, tx: h.tx, at: iso(h.at) })),
  };
}

const CREATOR_READS = ['pendingFees', 'creatorOwed', 'xOwedTotal', 'payoutAddress', 'currentCreator', 'quote'];

/** The creator panel of a 0.3.0 token: creator vault (claim, X shares) and the Community Pool. */
export async function vaultPanelV3(deps, chainId, row, now) {
  const client = deps.client(chainId);
  let v;
  try {
    const res = await retry(() => client.multicall({ contracts: CREATOR_READS.map((functionName) => ({ address: row.vault, abi: CREATOR_VAULT_ABI, functionName })), allowFailure: false }));
    v = Object.fromEntries(CREATOR_READS.map((k, i) => [k, res[i]]));
  } catch {
    return { address: row.vault, version: 'v3', error: 'Could not read the vault', community: await communityPanel(deps, chainId, row.community_vault, now) };
  }
  const creator = lower(v.currentCreator);
  const claim = await simulate(client, row.vault, CREATOR_VAULT_ABI, 'claim', [], creator);
  const tx = (functionName, args = []) => ({ to: row.vault, value: '0', data: encodeFunctionData({ abi: CREATOR_VAULT_ABI, functionName, args }) });
  return {
    version: 'v3',
    address: row.vault,
    creator,
    payout: lower(v.payoutAddress),
    quote: outAddr(lower(v.quote)),
    balances: { pendingFees: v.pendingFees.toString(), creatorOwed: v.creatorOwed.toString(), xOwed: v.xOwedTotal.toString() },
    claim: claim.ok ? { paid: claim.result.toString(), tx: { ...tx('claim'), from: creator } } : { error: claim.error },
    collectTx: tx('collect'),
    community: await communityPanel(deps, chainId, row.community_vault, now, { creator }),
  };
}

export const REWARDS_ROUTES = {
  'GET launch/reward-tokens': getRewardTokens,
  'GET launch/rewards': getRewards,
};
