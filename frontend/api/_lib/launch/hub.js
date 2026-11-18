// The Rewards hub in the API: every reward stream of the PlaceRewardsDistributor (0.3.0), for any token on the
// chain, sorted into four kinds of reward and three sources. Staking programs are listed by `launch/staking`.
//
//   GET launch/hub ?chain[&account&token]
//       every stream: type (holders, traders, nft), source (economy = the token's own tax, pool = the token's
//       Community Pool, creator = the token's creator or the collection's owner from a wallet, community = any
//       other wallet), whether Place builds its daily tables (`supported`), daily budget and pool with USD values,
//       days done, and with `account` what that wallet can claim and which streams it funded. `fees`: the stream
//       fee of the distributor and the staking fee config (the version createVault expects).
//   GET launch/hub/stream ?chain&id[&account]
//       one stream with its last 30 days (collected, table status, IPFS link) and the calls anyone can make:
//       closeStream when a day is due, reclaimUnallocated for the funder 30 days after the last day.
//   GET launch/hub/asset ?chain&address[&account]
//       what the create form needs about a token or collection: name, decimals, whether it is an NFT collection,
//       launched on Place (and which release), launched through the Place NFT factory, the reward types it
//       allows and whether `account` may fund a campaign from its Community Pool.
//
// Tables (rewardsPublisher.js) follow the same rule as `supported`:
//   holders  any ERC-20 (Place launches from the indexed transfers, others from Alchemy transfers + balanceOf)
//   traders  Place 0.3.0 launches only: volumes come from the Place hook's Trade events
//   nft      collections created through a Place NFT factory only: the hub factory (nft_collections) or the
//            NFT launchpad 0.3.1 (nft_launch_collections); ownerOf at the end of the day
import { encodeFunctionData } from 'viem';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI } from '../../../src/launch/abi.js';
import { launchDeployment, launchReleases, deployedReleases } from '../../../src/launch/deployments.js';
import { reply, fail, chainOf, addressOf, iso } from '../place/http.js';
import { ensureTokenMeta } from '../place/tokenMeta.js';
import { retry } from '../place/chain.js';
import { EPOCH, releaseGeneration } from './indexer.js';
import { metaOf, STREAM_SELECT, streamById, accountRewards } from './rewards.js';
import { tokenUsd, stakingAddress } from './economy.js';

export const RECLAIM_DELAY = 30 * EPOCH;
export const HUB_TYPES = ['staking', 'holders', 'traders', 'nft'];
export const HUB_SOURCES = ['economy', 'pool', 'creator', 'community'];

export const UNSUPPORTED = {
  traders: 'Trader rewards are counted from Place trade data, so only tokens launched on Place qualify',
  nft: 'NFT holder rewards are only for collections launched on Place',
};

function chainParts(q) {
  const chainId = chainOf(q);
  if (!launchDeployment(chainId)) fail(`Place Launch is not deployed on chain ${chainId}`);
  return chainId;
}

const generationOf = (chainId, version) => releaseGeneration(version || launchReleases(chainId).find((r) => releaseGeneration(r.version) === 1)?.version || '0.1.0');

/**
 * Type, source and support of one stream. Pure. ctx: placeTokens Map(token → { generation, current_creator,
 * original_creator }), collections Map(address → creator), nfts Set (ERC-721 addresses), poolStreams Set (ids).
 */
export function classifyStream(s, ctx) {
  const place = ctx.placeTokens.get(s.token) || null;
  const collectionOwner = ctx.collections.get(s.token) ?? null;
  const placeCollection = collectionOwner != null;
  const isNft = placeCollection || ctx.nfts.has(s.token);
  const kind = Number(s.kind) === 1 ? 'traders' : 'holders';
  const type = kind === 'traders' ? 'traders' : isNft ? 'nft' : 'holders';
  let source = 'community';
  if (s.economy) source = 'economy';
  else if (ctx.poolStreams.has(s.stream_id)) source = 'pool';
  else if (place && s.funder && (s.funder === place.current_creator || s.funder === place.original_creator)) source = 'creator';
  else if (placeCollection && s.funder === collectionOwner) source = 'creator';
  let unsupported = null;
  if (type === 'traders' && !(place && place.generation >= 3)) unsupported = UNSUPPORTED.traders;
  else if (type === 'nft' && !placeCollection) unsupported = UNSUPPORTED.nft;
  return { type, kind, source, official: source !== 'community', placeToken: Boolean(place), placeCollection, isNft, supported: !unsupported, unsupported };
}

/** Days of a stream: status, days started so far, first and last moment. Pure. */
export function streamDays(s, now) {
  const current = Math.floor(now / EPOCH);
  const start = Number(s.start_epoch);
  const count = Number(s.epoch_count) || 0;
  const end = count ? start + count : null;
  const status = current < start ? 'upcoming' : end != null && current >= end ? 'ended' : 'live';
  const done = status === 'upcoming' ? 0 : status === 'ended' ? count : Math.min(count || Infinity, current - start + 1);
  return { status, done, current, startsAt: iso(start * EPOCH * 1000), endsAt: end == null ? null : iso(end * EPOCH * 1000), nextCloseAt: iso((current + 1) * EPOCH * 1000) };
}

/** What `classifyStream` needs for a list of streams. */
async function classifyContext(deps, chainId, rows) {
  const tokens = [...new Set(rows.map((r) => r.token))];
  if (!tokens.length) return { placeTokens: new Map(), collections: new Map(), nfts: new Set(), poolStreams: new Set() };
  await ensureTokenMeta(deps, chainId, tokens);
  const [launches, collections, nfts, pool] = await Promise.all([
    deps.db.query(
      `select t.token, t.quote, t.current_creator, t.original_creator, e.version, e.community_vault from launch_tokens t
       left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1 and t.token = any($2::text[])`,
      [chainId, tokens]
    ),
    deps.db.query(`select address, creator from nft_collections where chain_id = $1 and address = any($2::text[])
       union all select address, creator from nft_launch_collections where chain_id = $1 and address = any($2::text[])`, [chainId, tokens]),
    deps.db.query('select address from token_meta where chain_id = $1 and address = any($2::text[]) and is_nft', [chainId, tokens]),
    deps.db.query(`select ref from launch_vault_events where chain_id = $1 and kind = 'fund_stream' and ref = any($2::text[])`, [chainId, rows.map((r) => r.stream_id)]),
  ]);
  return {
    placeTokens: new Map(launches.map((l) => [l.token, { ...l, generation: generationOf(chainId, l.version) }])),
    collections: new Map(collections.map((c) => [c.address, c.creator])),
    nfts: new Set(nfts.map((n) => n.address)),
    poolStreams: new Set(pool.map((p) => p.ref)),
  };
}

/** Live fees: the distributor's stream fee and the staking fee config. Nulls when the chain cannot be read. */
async function hubFees(deps, chainId) {
  const d = launchDeployment(chainId);
  const staking = stakingAddress(chainId);
  const out = { distributor: d.rewardsDistributor ?? null, streamFeeBps: null, staking, stakingFeeBps: null, stakingFeeVersion: null };
  if (!deps.client) return out;
  try {
    const client = deps.client(chainId);
    const res = await retry(() =>
      client.multicall({
        contracts: [
          ...(out.distributor ? [{ address: out.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'streamFeeBps' }] : []),
          ...(staking ? [{ address: staking, abi: PLACE_STAKING_ABI, functionName: 'feeConfig' }] : []),
        ],
        allowFailure: true,
      })
    );
    let i = 0;
    if (out.distributor) {
      if (res[i].status === 'success') out.streamFeeBps = Number(res[i].result);
      i++;
    }
    if (staking && res[i]?.status === 'success') {
      out.stakingFeeBps = Number(res[i].result[0]);
      out.stakingFeeVersion = res[i].result[2].toString();
    }
  } catch {
    // fees stay unknown; the create form reads them again before it sends
  }
  return out;
}

const units = (raw, decimals) => Number(raw) / 10 ** decimals;

/** The card of one stream (no epochs). */
function hubStreamView(s, c, info, now, lastDay, mine, quote = null) {
  const days = streamDays(s, now);
  const token = info(s.token);
  if (c.isNft) token.decimals = 0;
  const reward = info(s.reward_token);
  const perDay = s.economy ? (lastDay ?? 0n).toString() : s.reward_per_epoch;
  const pool = s.economy ? s.funded : (BigInt(s.reward_per_epoch) * BigInt(s.epoch_count || 0)).toString();
  const usd = (raw) => (reward.usd == null ? null : units(raw, reward.decimals) * reward.usd);
  return {
    id: s.stream_id,
    distributor: s.distributor,
    ...c,
    token,
    rewardToken: reward,
    quote: quote ? info(quote) : null, // pair asset of a Place launch: trader minimums are in it
    funder: s.funder,
    criterion: s.criterion,
    startEpoch: Number(s.start_epoch),
    epochCount: Number(s.epoch_count) || null,
    rewardPerEpoch: s.reward_per_epoch,
    perDay,
    perDayUsd: usd(perDay),
    pool,
    poolUsd: usd(pool),
    funded: s.funded,
    allocated: s.allocated,
    claimed: s.claimed,
    unallocated: (BigInt(s.funded) - BigInt(s.allocated)).toString(),
    lastClosedEpoch: s.last_closed_epoch == null ? null : Number(s.last_closed_epoch),
    status: days.status,
    daysDone: days.done,
    startsAt: days.startsAt,
    endsAt: days.endsAt,
    nextCloseAt: days.nextCloseAt,
    metadataURI: s.metadata_uri || null,
    createdAt: iso(s.created_at),
    createdTx: s.created_tx,
    mine: mine || null,
  };
}

/** USD prices on top of metaOf. */
async function infoWithUsd(deps, chainId, addrs) {
  const info = await metaOf(deps, chainId, addrs);
  const { usd } = await tokenUsd(deps, chainId, [...new Set(addrs)], new Map());
  return (a) => ({ ...info(a), usd: usd.get(a) ?? null });
}

async function listHub({ query: q }, deps) {
  const chainId = chainParts(q);
  if (deps.refresh) await deps.refresh(chainId).catch(() => {});
  const account = q.account ? addressOf(q.account, 'account') : null;
  const params = [chainId, deployedReleases(chainId).filter((r) => r.rewardsDistributor).map((r) => r.rewardsDistributor.toLowerCase())];
  let where = 's.chain_id = $1 and s.distributor = any($2::text[])';
  if (q.token) {
    params.push(addressOf(q.token, 'token'));
    where += ` and s.token = $${params.length}`;
  }
  const rows = await deps.db.query(`${STREAM_SELECT} where ${where} order by s.created_block desc limit 500`, params);
  const now = deps.now();
  const ctx = await classifyContext(deps, chainId, rows);
  const info = await infoWithUsd(deps, chainId, [...rows.flatMap((r) => [r.token, r.reward_token]), ...[...ctx.placeTokens.values()].map((p) => p.quote)]);
  // The last closed day of Economy streams: what the tax funded that day (difference of the running totals).
  const last = rows.some((r) => r.economy)
    ? await deps.db.query(
        `select stream_id, total_funded::text as total from (
           select stream_id, total_funded, row_number() over (partition by stream_id order by epoch desc) as n from reward_epochs where chain_id = $1 and stream_id = any($2::text[])
         ) x where n <= 2 order by stream_id, n`,
        [chainId, rows.filter((r) => r.economy).map((r) => r.stream_id)]
      )
    : [];
  const lastDay = new Map();
  for (const r of rows.filter((x) => x.economy)) {
    const [a, b] = last.filter((l) => l.stream_id === r.stream_id);
    if (a) lastDay.set(r.stream_id, BigInt(a.total) - BigInt(b?.total ?? 0));
  }
  let claims = new Map();
  if (account) {
    const r = await accountRewards(deps, chainId, account);
    claims = new Map(r.rewards.map((x) => [x.streamId, x]));
  }
  const streams = rows.map((s) => {
    const c = classifyStream(s, ctx);
    const mine = account ? { claimable: claims.get(s.stream_id)?.claimable ?? '0', earned: claims.get(s.stream_id)?.cumulative ?? '0', funded: s.funder === account } : null;
    return hubStreamView(s, c, info, now, lastDay.get(s.stream_id), mine, ctx.placeTokens.get(s.token)?.quote);
  });
  return reply(200, { chainId, epoch: Math.floor(now / EPOCH), fees: await hubFees(deps, chainId), streams }, account ? 'no-store' : 'public, max-age=10');
}

async function hubStream({ query: q }, deps) {
  const chainId = chainParts(q);
  const id = String(q.id || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) fail('id must be a stream id (bytes32)');
  const account = q.account ? addressOf(q.account, 'account') : null;
  const now = deps.now();
  const found = await streamById(deps, chainId, id, now);
  if (!found) fail('Unknown stream (or not indexed yet)', 404);
  const { row, view } = found;
  const ctx = await classifyContext(deps, chainId, [row]);
  const quote = ctx.placeTokens.get(row.token)?.quote ?? null;
  const info = await infoWithUsd(deps, chainId, [row.token, row.reward_token, ...(quote ? [quote] : [])]);
  const c = classifyStream(row, ctx);
  let mine = null;
  if (account) {
    const r = await accountRewards(deps, chainId, account, { token: row.token });
    const item = r.rewards.find((x) => x.streamId === id) || null;
    mine = { item, pending: r.pending.find((p) => p.streamId === id) || null, funded: row.funder === account };
  }
  const days = streamDays(row, now);
  const lastEpoch = row.economy || !Number(row.epoch_count) ? null : Number(row.start_epoch) + Number(row.epoch_count) - 1;
  const closedTo = row.last_closed_epoch == null ? Number(row.start_epoch) - 1 : Number(row.last_closed_epoch);
  const dueTo = Math.min(days.current - 1, lastEpoch ?? Infinity);
  const tx = (functionName) => ({ to: row.distributor, value: '0', data: encodeFunctionData({ abi: REWARDS_DISTRIBUTOR_ABI, functionName, args: [id] }) });
  const reclaimAt = lastEpoch == null ? null : (lastEpoch + 1) * EPOCH + RECLAIM_DELAY;
  const unallocated = BigInt(row.funded) - BigInt(row.allocated);
  const card = hubStreamView(row, c, info, now, null, null, quote);
  return reply(
    200,
    {
      chainId,
      stream: { ...view, ...card, epochs: view.epochs },
      mine,
      actions: {
        close: dueTo > closedTo && dueTo >= Number(row.start_epoch) ? { days: dueTo - closedTo, tx: tx('closeStream') } : null,
        reclaim:
          reclaimAt == null
            ? null
            : { at: iso(reclaimAt * 1000), ready: now >= reclaimAt && unallocated > 0n, amount: unallocated.toString(), to: row.funder, tx: tx('reclaimUnallocated') },
      },
    },
    account ? 'no-store' : 'public, max-age=10'
  );
}

async function hubAsset({ query: q }, deps) {
  const chainId = chainParts(q);
  const address = addressOf(q.address, 'address');
  const account = q.account ? addressOf(q.account, 'account') : null;
  const code = deps.client ? await retry(() => deps.client(chainId).getCode({ address })).catch(() => null) : '0x00';
  if (!code || code === '0x') fail('This address is not a token contract on this chain', 404);
  await ensureTokenMeta(deps, chainId, [address]);
  const [meta] = await deps.db.query('select name, symbol, decimals, is_nft from token_meta where chain_id = $1 and address = $2', [chainId, address]);
  const [launch] = await deps.db.query(
    `select t.token, t.quote, t.current_creator, t.original_creator, t.contract_uri, e.version, e.launch_type, e.community_vault from launch_tokens t
     left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1 and t.token = $2`,
    [chainId, address]
  );
  const [collection] = await deps.db.query(
    `select creator, created_at from nft_collections where chain_id = $1 and address = $2
     union all select creator, created_at from nft_launch_collections where chain_id = $1 and address = $2`,
    [chainId, address]
  );
  const isNft = Boolean(collection || meta?.is_nft);
  const generation = launch ? generationOf(chainId, launch.version) : null;
  const quoteInfo = launch ? (await metaOf(deps, chainId, [launch.quote]))(launch.quote) : null;
  const allowed = {
    staking: !isNft,
    holders: !isNft,
    traders: !isNft && generation >= 3,
    nft: isNft && Boolean(collection),
  };
  const reasons = {
    staking: isNft ? 'Staking takes ERC-20 tokens' : null,
    holders: isNft ? 'This is an NFT collection: choose NFT holders' : null,
    traders: isNft ? 'NFTs have no trading volume on Place' : allowed.traders ? null : UNSUPPORTED.traders,
    nft: !isNft ? 'This is a token, not an NFT collection' : allowed.nft ? null : UNSUPPORTED.nft,
  };
  const creator = launch?.current_creator ?? null;
  return reply(
    200,
    {
      chainId,
      address,
      name: meta?.name ?? null,
      symbol: meta?.symbol ?? null,
      decimals: isNft ? 0 : meta?.decimals ?? 18,
      isNft,
      place: launch
        ? { generation, version: launch.version, launchType: launch.launch_type || null, creator, quote: quoteInfo, communityVault: launch.community_vault || null, contractURI: launch.contract_uri || null }
        : null,
      placeCollection: collection ? { creator: collection.creator, createdAt: iso(collection.created_at) } : null,
      allowed,
      reasons,
      pool: {
        available: Boolean(launch?.community_vault && generation >= 3),
        isCreator: Boolean(account && creator && account === creator),
        types: ['staking', 'holders', ...(generation >= 3 ? ['traders'] : [])],
        note: 'The Community Pool funds staking, holder and trader rewards of its own token. NFT holder rewards are paid from a wallet.',
      },
    },
    'no-store'
  );
}

export const HUB_ROUTES = {
  'GET launch/hub': listHub,
  'GET launch/hub/stream': hubStream,
  'GET launch/hub/asset': hubAsset,
};
