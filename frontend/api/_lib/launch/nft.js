// NFT launchpad (PlaceNftFactory 0.3.1): indexer part and API.
//
// Indexer: read inside the shared range loop (place/indexer.js), like the launchpad. The factory is a static
// address of the shared cursor; every collection it made is a dynamic source of the same range, so a collection's
// first mint in its creation range is never missed. Every write is idempotent (rows keyed by block and log index,
// totals change only when that row is new).
//
// API, under /api/place/launch/*:
//   GET launch/collections        ?chain[&token&official=1&creator&holder&pool=1&q&sort=new|minted|pool&limit&offset]
//   GET launch/collection         ?chain&address[&account]   settings, totals, live pool state, holders, mints, log;
//                                                            with account: its NFTs, claimable, credit, minted
//   GET launch/collection/holders ?chain&address[&limit&offset]
//   GET launch/nft/account        ?chain&account             owned NFTs, created collections, claimable, claims
//   GET launch/nft/pairs          ?chain                     pair tokens a collection can use, and reward tokens
//   GET launch/nft/pair           ?chain&address             can this token be a pair (and why not)
// Before the 0.3.1 deploy every endpoint answers { deployed: false } with empty lists, never an error.
import { parseEventLogs, parseAbi } from 'viem';
import { NFT_FACTORY_ABI, NFT_COLLECTION_ABI } from '../../../src/launch/nftAbi.js';
import { nftDeployment, releaseByVersion } from '../../../src/launch/deployments.js';
import { poolKey } from '../../../src/launch/swap.js';
import { pairIcon } from '../../../src/launch/pairs.js';
import { reply, fail, chainOf, addressOf, limits, iso } from '../place/http.js';
import { retry } from '../place/chain.js';
import { metaOf, rewardRegistry, rewardTokenCategory } from './rewards.js';
import { releaseGeneration } from './indexer.js';

const ETH = '0x0000000000000000000000000000000000000000';
const ADDRESS_CHUNK = Number(process.env.PLACE_LOGS_MAX_ADDRESSES || 10);
const DAY = 86_400;
export const ACC = 10n ** 36n;
export const PLATFORM_BPS = 2_000;
export const POOL_DAYS = 30;
const KINDS = ['unique', 'edition'];
const ECONOMY_EVENTS = new Set(['RevenueSplit', 'HoldersFunded', 'HoldersConverted', 'ConversionDeferred', 'HoldersClaimed', 'Paid', 'TokensBurned']);

const events = (abi) => abi.filter((x) => x.type === 'event');
const FACTORY_EVENTS = events(NFT_FACTORY_ABI);
const COLLECTION_EVENTS = events(NFT_COLLECTION_ABI);
const lower = (a) => (a == null ? a : String(a).toLowerCase());
const isoOf = (seconds) => new Date(Number(seconds) * 1000).toISOString();
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const byOrder = (a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
const outAddr = (a) => (a == null ? null : a === ETH ? 'eth' : a);

const READS = ['name', 'symbol', 'kind', 'maxSupply', 'maxPerWallet', 'mintStart', 'mintEnd', 'mintPrice', 'token', 'tokenPayments', 'rewardToken', 'royaltyBps', 'economy', 'contractURI', 'baseURI', 'uriSuffix', 'owner', 'launchPool', 'official', 'metadataFrozen'];

// ─────────────────────────────── indexer ───────────────────────────────

/** The factory, when the NFT launchpad is deployed on this chain (its logs come with the shared getLogs). */
export function nftStaticAddresses(chainId) {
  const n = nftDeployment(chainId);
  return n ? [n.factory] : [];
}

/** The NFT launchpad's start block, or null before the deploy. */
export function nftStartBlock(chainId) {
  return nftDeployment(chainId)?.startBlock ?? null;
}

/** Reads the settings of collections created in this range (one multicall). */
async function readCollections(client, addresses) {
  const calls = addresses.flatMap((a) => READS.map((functionName) => ({ address: a, abi: NFT_COLLECTION_ABI, functionName })));
  const res = await retry(() => client.multicall({ contracts: calls, allowFailure: true }));
  const out = new Map();
  addresses.forEach((a, i) => {
    const r = Object.fromEntries(READS.map((k, j) => [k, res[i * READS.length + j]?.status === 'success' ? res[i * READS.length + j].result : null]));
    out.set(a, r);
  });
  return out;
}

/**
 * Decodes the NFT part of one range and fetches what it needs (collection logs, settings of new collections, block
 * times, contract URIs that changed). Returns { logs (decoded, sorted, each with nft: true), ctx } for applyNftLog.
 */
export async function collectNftLogs({ db, client, chainId, fromBlock, toBlock, staticLogs }) {
  const n = nftDeployment(chainId);
  if (!n || toBlock < n.startBlock) return { logs: [], ctx: null };
  const created = parseEventLogs({ abi: FACTORY_EVENTS, logs: staticLogs.filter((l) => lower(l.address) === n.factory), strict: false }).filter((l) => l.eventName === 'CollectionCreated');
  const freshAddrs = created.map((l) => lower(l.args.collection));
  const fresh = freshAddrs.length ? await readCollections(client, freshAddrs) : new Map();
  const known = (await db.query('select address from nft_launch_collections where chain_id = $1', [chainId])).map((r) => r.address);
  const all = [...new Set([...known, ...freshAddrs])];
  const raw = [];
  for (let i = 0; i < all.length; i += ADDRESS_CHUNK) raw.push(...(await client.getLogs({ address: all.slice(i, i + ADDRESS_CHUNK), fromBlock, toBlock })));
  const dynamic = parseEventLogs({ abi: COLLECTION_EVENTS, logs: raw, strict: false }).filter((l) => l.eventName);
  const logs = [...created, ...dynamic].sort(byOrder);
  if (!logs.length) return { logs: [], ctx: null };
  for (const l of logs) l.nft = true;
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, (await retry(() => client.getBlock({ blockNumber: b }))).timestamp])));
  const uriChanged = [...new Set(dynamic.filter((l) => l.eventName === 'ContractURIUpdated').map((l) => lower(l.address)))];
  const uris = new Map();
  if (uriChanged.length) {
    const res = await retry(() => client.multicall({ contracts: uriChanged.map((a) => ({ address: a, abi: NFT_COLLECTION_ABI, functionName: 'contractURI' })), allowFailure: true }));
    uriChanged.forEach((a, i) => res[i]?.status === 'success' && uris.set(a, res[i].result));
  }
  return { logs, ctx: { chainId, factory: n.factory, fresh, times, uris } };
}

const poolText = (k) => (k && Number(k.tickSpacing) !== 0 ? json({ currency0: lower(k.currency0), currency1: lower(k.currency1), fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: lower(k.hooks) }) : null);

/** Applies one decoded NFT log inside the indexer's transaction. */
export async function applyNftLog(q, log, ctx) {
  const { chainId } = ctx;
  const a = log.args;
  const at = isoOf(ctx.times.get(log.blockNumber) ?? 0n);
  const tx = lower(log.transactionHash);
  const c = lower(log.address);
  const key = [chainId, log.blockNumber.toString(), log.logIndex];
  if (log.eventName === 'CollectionCreated') {
    if (c !== ctx.factory) return;
    const addr = lower(a.collection);
    const r = ctx.fresh.get(addr) || {};
    const e = r.economy || {};
    await q(
      `insert into nft_launch_collections (chain_id, address, factory, creator, owner, token, reward_token, official, kind, idx, name, symbol,
         contract_uri, base_uri, uri_suffix, max_supply, max_per_wallet, mint_start, mint_end, mint_price, token_payments, royalty_bps,
         creator_bps, holders_bps, burn_bps, launch_pool, metadata_frozen, created_block, created_tx, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
       on conflict (chain_id, address) do nothing`,
      [
        chainId,
        addr,
        c,
        lower(a.creator),
        lower(r.owner || a.creator),
        a.token === ETH ? null : lower(a.token),
        lower(r.rewardToken ?? ETH),
        a.official,
        KINDS[Number(a.kind)] || 'unique',
        Number(a.index),
        r.name ?? null,
        r.symbol ?? null,
        r.contractURI ?? null,
        r.baseURI ?? null,
        r.uriSuffix ?? null,
        Number(r.maxSupply ?? 0),
        Number(r.maxPerWallet ?? 0),
        String(r.mintStart ?? 0),
        String(r.mintEnd ?? 0),
        String(r.mintPrice ?? 0),
        Boolean(r.tokenPayments),
        Number(r.royaltyBps ?? 0),
        Number(e.creatorBps ?? 10_000),
        Number(e.holdersBps ?? 0),
        Number(e.burnBps ?? 0),
        poolText(r.launchPool),
        Boolean(r.metadataFrozen),
        log.blockNumber.toString(),
        tx,
        at,
      ]
    );
    return;
  }
  if (c === ctx.factory) return; // owner settings of the factory: nothing to store
  const where = 'chain_id = $1 and address = $2';
  switch (log.eventName) {
    case 'Transfer': {
      const id = a.tokenId.toString();
      if (lower(a.from) === ETH) {
        await q(
          `insert into nft_launch_items (chain_id, collection, token_id, owner, minted_at) values ($1, $2, $3, $4, $5)
           on conflict (chain_id, collection, token_id) do update set owner = excluded.owner`,
          [chainId, c, id, lower(a.to), at]
        );
      } else {
        await q('update nft_launch_items set owner = $4 where chain_id = $1 and collection = $2 and token_id = $3', [chainId, c, id, lower(a.to)]);
      }
      return;
    }
    case 'Minted': {
      const asset = lower(a.asset);
      const ins = await q(
        `insert into nft_launch_mints (chain_id, block, log_index, collection, minter, first_id, quantity, asset, paid, tx, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing returning paid`,
        [...key, c, lower(a.to), a.firstTokenId.toString(), Number(a.quantity), asset, a.paid.toString(), tx, at]
      );
      if (ins.length) {
        const col = asset === ETH ? 'paid_eth' : 'paid_token';
        await q(
          `update nft_launch_collections set total_minted = greatest(total_minted, $3), ${col} = ${col} + $4, last_mint_at = $5 where ${where}`,
          [chainId, c, Number(a.firstTokenId) + Number(a.quantity) - 1, a.paid.toString(), at]
        );
      }
      return;
    }
    case 'MintSet':
      await q(`update nft_launch_collections set mint_price = $3, mint_start = $4, mint_end = $5, token_payments = $6 where ${where}`, [chainId, c, a.price.toString(), a.start.toString(), a.end.toString(), a.tokenPayments]);
      return;
    case 'RoyaltySet':
      await q(`update nft_launch_collections set royalty_bps = $3 where ${where}`, [chainId, c, Number(a.bps)]);
      return;
    case 'BaseURISet':
      await q(`update nft_launch_collections set base_uri = $3, uri_suffix = $4 where ${where}`, [chainId, c, a.baseURI, a.uriSuffix]);
      return;
    case 'MetadataFrozen':
      await q(`update nft_launch_collections set metadata_frozen = true where ${where}`, [chainId, c]);
      return;
    case 'ContractURIUpdated':
      if (ctx.uris.has(c)) await q(`update nft_launch_collections set contract_uri = $3 where ${where}`, [chainId, c, ctx.uris.get(c)]);
      return;
    case 'OwnershipTransferred':
      if (lower(a.newOwner) !== ETH) await q(`update nft_launch_collections set owner = $3 where ${where}`, [chainId, c, lower(a.newOwner)]);
      return;
    default:
      break;
  }
  if (!ECONOMY_EVENTS.has(log.eventName)) return;
  let account = null;
  let asset = null;
  let amount = null;
  let data = null;
  switch (log.eventName) {
    case 'RevenueSplit':
      asset = lower(a.asset);
      amount = a.platform + a.creator + a.holders + a.burn;
      data = { platform: a.platform, creator: a.creator, holders: a.holders, burn: a.burn, royalty: a.royalty };
      break;
    case 'HoldersFunded':
      amount = a.amount;
      data = { rewardRate: a.rewardRate, periodFinish: a.periodFinish };
      break;
    case 'HoldersConverted':
      asset = lower(a.asset);
      amount = a.amountIn;
      data = { rewardOut: a.rewardOut };
      break;
    case 'ConversionDeferred':
      asset = lower(a.asset);
      amount = a.amount;
      break;
    case 'HoldersClaimed':
      account = lower(a.account);
      amount = a.amount;
      break;
    case 'Paid':
      account = lower(a.creator);
      asset = lower(a.asset);
      amount = a.creatorAmount + a.platformAmount;
      data = { creator: a.creatorAmount, platform: a.platformAmount, platformRecipient: lower(a.platform) };
      break;
    case 'TokensBurned':
      amount = a.amount;
      data = { ethIn: a.ethIn };
      break;
    default:
      return;
  }
  const ins = await q(
    `insert into nft_launch_events (chain_id, block, log_index, collection, kind, account, asset, amount, data, tx, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing returning kind`,
    [...key, c, log.eventName, account, asset, amount == null ? null : amount.toString(), data ? json(data) : null, tx, at]
  );
  if (!ins.length) return;
  if (log.eventName === 'HoldersFunded') {
    await q(`update nft_launch_collections set holders_funded = holders_funded + $3, reward_rate = $4, period_finish = $5 where ${where}`, [chainId, c, a.amount.toString(), a.rewardRate.toString(), a.periodFinish.toString()]);
  } else if (log.eventName === 'HoldersClaimed') {
    await q(`update nft_launch_collections set holders_claimed = holders_claimed + $3 where ${where}`, [chainId, c, a.amount.toString()]);
  } else if (log.eventName === 'TokensBurned') {
    await q(`update nft_launch_collections set burned = burned + $3 where ${where}`, [chainId, c, a.amount.toString()]);
  }
}

// ─────────────────────────────── views ───────────────────────────────

/** Where a collection's mint stands at `now` (unix seconds). */
export function mintStatus(r, now) {
  const start = Number(r.mint_start || 0);
  const end = Number(r.mint_end || 0);
  if (Number(r.max_supply) > 0 && Number(r.total_minted) >= Number(r.max_supply)) return 'sold-out';
  if (end && now >= end) return 'ended';
  if (start && now < start) return 'upcoming';
  return 'live';
}

/**
 * The holders pool at `now`: reward token per UTC day (whole pool and per NFT), what is still to be paid, the last
 * paying day. rewardRate is scaled by 1e36; a portion accrues at 00:00 UTC of each day up to periodFinish.
 */
export function poolState({ rewardRate, periodFinish, supply }, now) {
  const rate = BigInt(rewardRate || 0);
  const finish = Number(periodFinish || 0);
  const today = Math.floor(now / DAY);
  const active = rate > 0n && finish > today;
  const perDay = rate / ACC;
  const n = BigInt(supply || 0);
  const daysLeft = active ? finish - today : 0;
  return {
    active,
    perDay: active ? perDay.toString() : '0',
    perNftPerDay: active && n > 0n ? (rate / n / ACC).toString() : '0',
    accruedToday: rate > 0n && finish >= today && today > finish - POOL_DAYS ? perDay.toString() : '0',
    left: active ? ((rate * BigInt(daysLeft)) / ACC).toString() : '0',
    daysLeft,
    endsAt: finish ? isoOf(finish * DAY) : null,
    nextAccrualAt: active ? isoOf((today + 1) * DAY) : null,
  };
}

function collectionView(r, info, now) {
  const token = r.token ? info(r.token) : null;
  const reward = info(r.reward_token || ETH);
  return {
    address: r.address,
    name: r.name,
    symbol: r.symbol,
    kind: r.kind,
    official: r.official,
    creator: r.creator,
    owner: r.owner,
    index: Number(r.idx),
    token: token ? { ...token, logo: token.contractURI ? null : pairIcon({ symbol: token.symbol }), placeLaunch: Boolean(r.place_launch) } : null,
    rewardToken: reward,
    contractURI: r.contract_uri,
    baseURI: r.base_uri,
    uriSuffix: r.uri_suffix,
    maxSupply: Number(r.max_supply),
    maxPerWallet: Number(r.max_per_wallet),
    mintStart: Number(r.mint_start),
    mintEnd: Number(r.mint_end),
    mintPrice: String(r.mint_price),
    tokenPayments: r.token_payments,
    royaltyBps: Number(r.royalty_bps),
    economy: { platformBps: PLATFORM_BPS, creatorBps: Number(r.creator_bps), holdersBps: Number(r.holders_bps), burnBps: Number(r.burn_bps) },
    metadataFrozen: r.metadata_frozen,
    launchPool: r.launch_pool ? JSON.parse(r.launch_pool) : null,
    totalMinted: Number(r.total_minted),
    holders: Number(r.holders_count ?? 0),
    status: mintStatus(r, now),
    paid: { eth: String(r.paid_eth), token: String(r.paid_token) },
    burned: String(r.burned),
    pool: {
      funded: String(r.holders_funded),
      claimed: String(r.holders_claimed),
      rewardRate: String(r.reward_rate),
      periodFinish: Number(r.period_finish),
      ...poolState({ rewardRate: r.reward_rate, periodFinish: r.period_finish, supply: r.total_minted }, now),
    },
    lastMintAt: iso(r.last_mint_at),
    createdAt: iso(r.created_at),
    createdTx: r.created_tx,
    createdBlock: Number(r.created_block),
  };
}

const SELECT = `select c.*,
  (select count(distinct owner)::int from nft_launch_items i where i.chain_id = c.chain_id and i.collection = c.address) as holders_count,
  exists (select 1 from launch_tokens t where t.chain_id = c.chain_id and t.token = c.token) as place_launch
  from nft_launch_collections c`;

async function views(deps, chainId, rows) {
  const info = await metaOf(deps, chainId, rows.flatMap((r) => [r.token, r.reward_token]).filter(Boolean));
  const now = deps.now();
  return rows.map((r) => collectionView(r, info, now));
}

function nftChain(q) {
  const chainId = chainOf(q);
  return { chainId, n: nftDeployment(chainId) };
}

const notDeployed = (extra) => reply(200, { deployed: false, ...extra }, 'public, max-age=30');

async function listCollections({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  if (!n) return notDeployed({ collections: [], total: 0 });
  const { limit, offset } = limits(q, 100, 50);
  const where = ['c.chain_id = $1'];
  const args = [chainId];
  const add = (sql, v) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (q.token) add('c.token = ?', addressOf(q.token, 'token'));
  if (q.creator) add('c.creator = ?', addressOf(q.creator, 'creator'));
  if (q.owner) add('c.owner = ?', addressOf(q.owner, 'owner'));
  if (q.holder) add('exists (select 1 from nft_launch_items h where h.chain_id = c.chain_id and h.collection = c.address and h.owner = ?)', addressOf(q.holder, 'holder'));
  if (q.official === '1' || q.official === 'true') where.push('c.official');
  if (q.pool === '1' || q.pool === 'true') add('c.reward_rate > 0 and c.period_finish > ?', Math.floor(deps.now() / DAY));
  if (q.q) {
    const text = String(q.q).toLowerCase().slice(0, 64);
    args.push(`%${text}%`, text);
    where.push(`(lower(c.name) like $${args.length - 1} or lower(c.symbol) like $${args.length - 1} or c.address = $${args.length})`);
  }
  const order = q.sort === 'minted' ? 'c.total_minted desc, c.created_block desc' : q.sort === 'pool' ? 'c.holders_funded desc, c.created_block desc' : 'c.created_block desc, c.idx desc';
  const rows = await deps.db.query(`${SELECT} where ${where.join(' and ')} order by c.official desc, ${order} limit ${limit} offset ${offset}`, args);
  const [{ total }] = await deps.db.query(`select count(*)::int as total from nft_launch_collections c where ${where.join(' and ')}`, args);
  return reply(200, { deployed: true, factory: n.factory, collections: await views(deps, chainId, rows), total }, 'public, max-age=5');
}

/** Live state of a collection from the chain (null when the chain cannot be read). */
async function liveState(deps, chainId, c, account, ids) {
  const read = (functionName, args) => ({ address: c.address, abi: NFT_COLLECTION_ABI, functionName, args });
  const token = c.token && c.token.address !== 'eth' ? c.token.address : null;
  const calls = [
    read('totalSupply'),
    read('rewardRate'),
    read('periodFinish'),
    read('lastAccrualDay'),
    read('buybackPending'),
    read('pendingHolders', [ETH]),
    read('pendingHolders', [token || ETH]),
    read('creatorOwed', [ETH]),
    read('platformOwed', [ETH]),
    read('reserved', [ETH]),
    read('totalBurned'),
  ];
  const accountCalls = account ? [read('credit', [account]), read('mintedBy', [account]), ...ids.map((id) => read('claimable', [BigInt(id)]))] : [];
  try {
    const client = deps.client(chainId);
    const [res, balance] = await Promise.all([retry(() => client.multicall({ contracts: [...calls, ...accountCalls], allowFailure: true })), retry(() => client.getBalance({ address: c.address }))]);
    const v = (i) => (res[i]?.status === 'success' ? res[i].result : null);
    const s = (i) => (v(i) == null ? null : v(i).toString());
    const reserved = v(9);
    const live = {
      totalSupply: s(0),
      rewardRate: s(1),
      periodFinish: v(2) == null ? null : Number(v(2)),
      lastAccrualDay: v(3) == null ? null : Number(v(3)),
      buybackPending: s(4),
      pendingHoldersEth: s(5),
      pendingHoldersToken: token ? s(6) : '0',
      creatorOwedEth: s(7),
      platformOwedEth: s(8),
      unprocessedEth: reserved == null ? null : (balance > reserved ? balance - reserved : 0n).toString(),
      totalBurned: s(10),
    };
    if (live.rewardRate != null) Object.assign(live, poolState({ rewardRate: live.rewardRate, periodFinish: live.periodFinish, supply: live.totalSupply }, deps.now()));
    let you = null;
    if (account) {
      const base = calls.length;
      const perId = ids.map((id, i) => ({ id, claimable: s(base + 2 + i) ?? '0' }));
      const sum = perId.reduce((t, x) => t + BigInt(x.claimable), 0n);
      const credit = BigInt(v(base) ?? 0n);
      you = { ids: perId, credit: credit.toString(), claimable: (sum + credit).toString(), minted: v(base + 1) == null ? null : Number(v(base + 1)) };
    }
    return { live, you };
  } catch {
    return { live: null, you: account ? { ids: ids.map((id) => ({ id, claimable: null })), credit: null, claimable: null, minted: null } : null };
  }
}

async function getCollection({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  const address = addressOf(q.address);
  if (!n) return notDeployed({ address, collection: null });
  const account = q.account ? addressOf(q.account, 'account') : null;
  const [row] = await deps.db.query(`${SELECT} where c.chain_id = $1 and c.address = $2`, [chainId, address]);
  if (!row) fail('Collection not found', 404);
  const [collection] = await views(deps, chainId, [row]);
  const [holders, mints, log, mine] = await Promise.all([
    deps.db.query('select owner, count(*)::int as n from nft_launch_items where chain_id = $1 and collection = $2 group by owner order by n desc, owner limit 20', [chainId, address]),
    deps.db.query('select minter, first_id::text as first_id, quantity, asset, paid::text as paid, tx, at from nft_launch_mints where chain_id = $1 and collection = $2 order by block desc, log_index desc limit 20', [chainId, address]),
    deps.db.query('select kind, account, asset, amount::text as amount, data, tx, at from nft_launch_events where chain_id = $1 and collection = $2 order by block desc, log_index desc limit 30', [chainId, address]),
    account ? deps.db.query('select token_id::text as id from nft_launch_items where chain_id = $1 and collection = $2 and owner = $3 order by token_id limit 200', [chainId, address, account]) : [],
  ]);
  const { live, you } = await liveState(deps, chainId, collection, account, mine.map((r) => r.id));
  return reply(
    200,
    {
      deployed: true,
      collection,
      live,
      you,
      holders: holders.map((h) => ({ owner: h.owner, count: h.n })),
      mints: mints.map((m) => ({ minter: m.minter, firstId: m.first_id, quantity: m.quantity, asset: outAddr(m.asset), paid: m.paid, tx: m.tx, at: iso(m.at) })),
      log: log.map((e) => ({ kind: e.kind, account: e.account, asset: outAddr(e.asset), amount: e.amount, data: e.data ? JSON.parse(e.data) : null, tx: e.tx, at: iso(e.at) })),
    },
    account ? 'no-store' : 'public, max-age=5'
  );
}

async function getHolders({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  const address = addressOf(q.address);
  if (!n) return notDeployed({ address, holders: [], total: 0 });
  const { limit, offset } = limits(q, 100, 50);
  const rows = await deps.db.query(
    `select owner, count(*)::int as n, min(minted_at) as since from nft_launch_items where chain_id = $1 and collection = $2
     group by owner order by n desc, owner limit ${limit} offset ${offset}`,
    [chainId, address]
  );
  const [{ total }] = await deps.db.query('select count(distinct owner)::int as total from nft_launch_items where chain_id = $1 and collection = $2', [chainId, address]);
  return reply(200, { deployed: true, address, holders: rows.map((r) => ({ owner: r.owner, count: r.n, since: iso(r.since) })), total }, 'public, max-age=10');
}

/** Owned NFTs, created collections, what the wallet can claim in each collection and its claim history. */
async function getAccount({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  const account = addressOf(q.account, 'account');
  if (!n) return notDeployed({ account, owned: [], created: [], claimable: [], claims: [] });
  const [items, createdRows, creditRows, claims] = await Promise.all([
    deps.db.query('select collection, token_id::text as id from nft_launch_items where chain_id = $1 and owner = $2 order by collection, token_id limit 1000', [chainId, account]),
    deps.db.query(`${SELECT} where c.chain_id = $1 and (c.creator = $2 or c.owner = $2) order by c.created_block desc`, [chainId, account]),
    // Collections where the wallet held NFTs before (a seller keeps what its NFTs had accrued).
    deps.db.query(
      `select distinct collection from nft_launch_events where chain_id = $1 and kind = 'HoldersClaimed' and account = $2
       union select distinct m.collection from nft_launch_mints m where m.chain_id = $1 and m.minter = $2`,
      [chainId, account]
    ),
    deps.db.query("select collection, amount::text as amount, tx, at from nft_launch_events where chain_id = $1 and kind = 'HoldersClaimed' and account = $2 order by block desc, log_index desc limit 50", [chainId, account]),
  ]);
  const byCollection = new Map();
  for (const it of items) byCollection.set(it.collection, [...(byCollection.get(it.collection) || []), it.id]);
  const touched = [...new Set([...byCollection.keys(), ...creditRows.map((r) => r.collection)])];
  const rows = touched.length ? await deps.db.query(`${SELECT} where c.chain_id = $1 and c.address = any($2::text[])`, [chainId, touched]) : [];
  const list = await views(deps, chainId, rows);
  const created = await views(deps, chainId, createdRows);
  const claimable = [];
  for (const c of list) {
    const ids = byCollection.get(c.address) || [];
    const { you } = await liveState(deps, chainId, c, account, ids.slice(0, 200));
    claimable.push({ collection: c.address, ids: you?.ids || [], credit: you?.credit ?? null, claimable: you?.claimable ?? null, rewardToken: c.rewardToken });
  }
  return reply(200, {
    deployed: true,
    account,
    owned: list.filter((c) => byCollection.has(c.address)).map((c) => ({ collection: c, ids: byCollection.get(c.address) })),
    created,
    claimable: claimable.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n),
    claims: claims.map((r) => ({ collection: r.collection, amount: r.amount, tx: r.tx, at: iso(r.at) })),
  });
}

// ─────────────────────────────── pair and reward tokens ───────────────────────────────

/** Tokens with a registry route from ETH (the registry new collections use). */
async function routeTargets(deps, chainId) {
  const registry = rewardRegistry(chainId);
  if (!registry) return [];
  return (await deps.db.query('select to_token from launch_reward_routes where chain_id = $1 and registry = $2 and from_token = $3 and active order by to_token', [chainId, registry, ETH])).map((r) => r.to_token).filter((a) => a !== ETH);
}

/**
 * Place tokens that can pair a collection: 0.3.x tokens through their launch pool (ETH pair, or a pair the registry
 * routes ETH to), and older tokens only through a registry route to the token itself.
 */
async function placePairs(deps, chainId, routed, only) {
  const rows = await deps.db.query(
    `select t.token, t.quote, t.name, t.symbol, t.contract_uri, e.version from launch_tokens t
     left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token
     where t.chain_id = $1 ${only ? 'and t.token = $2' : ''} order by t.created_block desc limit 500`,
    only ? [chainId, only] : [chainId]
  );
  const out = [];
  for (const r of rows) {
    const gen = r.version ? releaseGeneration(r.version) : 1;
    const release = r.version ? releaseByVersion(chainId, r.version) : null;
    let launchPool = null;
    let reason = null;
    if (gen >= 3 && release?.hook && (r.quote === ETH || routed.has(r.quote))) launchPool = poolKey(r.token, r.quote, release.hook);
    else if (!routed.has(r.token)) reason = gen >= 3 ? 'Its pair asset has no route from ETH yet' : 'Tokens launched before 0.3.0 need a route from ETH';
    out.push({ address: r.token, symbol: r.symbol, name: r.name, decimals: 18, contractURI: r.contract_uri || null, placeLaunch: true, category: 'crypto', logo: null, launchPool, eligible: !reason, reason });
  }
  return out;
}

async function getPairs({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  const targets = await routeTargets(deps, chainId);
  const routed = new Set(targets);
  const info = await metaOf(deps, chainId, targets);
  const place = await placePairs(deps, chainId, routed);
  const placeSet = new Set(place.map((p) => p.address));
  const quotes = new Set(targets.length ? (await deps.db.query('select quote from launch_quotes where chain_id = $1 and quote = any($2::text[]) and registered', [chainId, targets])).map((r) => r.quote) : []);
  const routedView = (a) => {
    const m = info(a);
    const category = rewardTokenCategory(m.symbol, { quote: quotes.has(a) });
    return { address: a, symbol: m.symbol, name: m.name, decimals: m.decimals, contractURI: m.contractURI ?? null, placeLaunch: placeSet.has(a), category, logo: category === 'crypto' ? null : pairIcon({ symbol: m.symbol }), launchPool: null, eligible: true, reason: null };
  };
  const pairs = [...place.filter((p) => p.eligible), ...targets.filter((a) => !placeSet.has(a)).map(routedView)];
  const rewardTokens = [{ address: 'eth', symbol: 'ETH', name: 'Ether', decimals: 18, category: 'majors', logo: pairIcon({ symbol: 'ETH' }), source: 'route' }, ...targets.map((a) => ({ ...routedView(a), source: 'route' }))];
  return reply(200, { deployed: Boolean(n), registry: rewardRegistry(chainId), pairs, rewardTokens }, 'public, max-age=30');
}

const OWNABLE = parseAbi(['function owner() view returns (address)']);

/** One token as a pair: a Place token, a token with a route, or why it cannot be one yet. */
async function getPair({ query: q }, deps) {
  const { chainId, n } = nftChain(q);
  const address = addressOf(q.address);
  const targets = await routeTargets(deps, chainId);
  const routed = new Set(targets);
  const [place] = await placePairs(deps, chainId, routed, address);
  const info = await metaOf(deps, chainId, [address]);
  const m = info(address);
  const [reg] = await deps.db.query('select status, creator from project_registrations where chain_id = $1 and token = $2', [chainId, address]);
  let owner = null;
  try {
    owner = lower(await retry(() => deps.client(chainId).readContract({ address, abi: OWNABLE, functionName: 'owner' })));
  } catch {
    owner = null;
  }
  const base = { address, symbol: m.symbol, name: m.name, decimals: m.decimals, contractURI: m.contractURI ?? null, registered: reg ? { status: reg.status, creator: reg.creator } : null, owner };
  if (m.symbol == null && !place) return reply(200, { deployed: Boolean(n), pair: { ...base, eligible: false, reason: 'This address is not an ERC-20 token on this network' } });
  if (place) return reply(200, { deployed: Boolean(n), pair: { ...base, ...place, registered: base.registered, owner } });
  if (routed.has(address)) return reply(200, { deployed: Boolean(n), pair: { ...base, placeLaunch: false, category: rewardTokenCategory(m.symbol), logo: null, launchPool: null, eligible: true, reason: null } });
  return reply(200, {
    deployed: Boolean(n),
    pair: { ...base, placeLaunch: false, launchPool: null, eligible: false, reason: 'Place has no swap route from ETH to this token yet. Register the token: an admin adds the route once it has enough liquidity.' },
  });
}

export const NFT_ROUTES = {
  'GET launch/collections': listCollections,
  'GET launch/collection': getCollection,
  'GET launch/collection/holders': getHolders,
  'GET launch/nft/account': getAccount,
  'GET launch/nft/pairs': getPairs,
  'GET launch/nft/pair': getPair,
};

