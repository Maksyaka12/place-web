// Place Launch API, served by the Place router under /api/place/launch/*:
//
//   GET launch/tokens   ?chain&sort=new|trending|volume|liquidity|mcap|active&category=crypto|stocks&quote&creator&q&limit&offset   the feed
//   GET launch/token    ?chain&address                     token page: market, economics, trades, holders, campaigns
//   GET launch/candles  ?chain&address&interval=1m|5m|15m|1h|4h|1d[&from&to&limit]
//   GET launch/trades   ?chain[&address|trader&limit&before=block:logIndex]   (no filter: the live feed)
//   GET launch/holders  ?chain&address[&limit&offset]
//   GET launch/creator  ?chain&address[&token&slippageBps]  creator panel: vault baskets, claim, process(), fund tools
//                       (0.1.0 legacy tokens keep the old buyback / rewards panel)
//   GET launch/predict  ?chain&creator&kind&quote&name&symbol[&uri&editable&website&x&telegram&suffix&salt&xShares&…]
//   GET launch/pairs    ?chain                             launch pairs with start price and USD price
//   GET launch/stats    ?chain                             dashboard totals: launches, traders, volume, top market cap
//   GET launch/profile  ?address | ?addresses=a,b          creator profiles
//   POST launch/profile {address, profile, issuedAt, signature}   save a profile signed by its wallet
//   GET launch/fund-quote, launch/staking, launch/staking/position   0.2.0 economy (./economy.js)
//
// Reads come from the indexer's tables. Before answering, market endpoints let the indexer catch up with the
// chain (deps.refresh, at most every few seconds), so trades show up seconds after they land.
import { encodeFunctionData, getAddress } from 'viem';
import { LAUNCH_FACTORY_ABI } from '../../../src/launch/abi.js';
import { LEGACY_CREATOR_VAULT_ABI } from '../../../src/launch/abi.legacy.js';
import { launchDeployment, launchReleases, releaseByVersion, LAUNCH_SUPPLY } from '../../../src/launch/deployments.js';
import { KEEPER_ROUTES } from './keeper.js';
import { ECONOMY_ROUTES, vaultPanelV2, vaultPublicState, burnHistory, stakingForToken, revertReason } from './economy.js';
import { CANDLE_INTERVALS, fillCandles, units, change } from '../../../src/launch/market.js';
import { predictLaunch, mineSalt, requiredEnding } from '../../../src/launch/vanity.js';
import { campaignStatus } from '../../../src/place/status.js';
import { reply, fail, chainOf, addressOf, limits, iso, str } from '../place/http.js';
import { ensureTokenMeta } from '../place/tokenMeta.js';
import { retry } from '../place/chain.js';
import { quoteUsd } from './prices.js';
import { pairCategory, PAIR_CATEGORIES } from '../../../src/launch/pairs.js';
import { cleanProfile, profileMessage, PROFILE_SIGNATURE_MAX_AGE_MS } from '../../../src/launch/profile.js';

const ETH = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const DAY = 86_400;
const MAX_SUFFIX = 2; // hex chars the server mines before the factory's 01 (16^4 tries); longer endings: mine in the browser
const KIND_ID = { erc20: 1, b20: 2 };

export const LAUNCH_ROUTES = {
  'GET launch/tokens': listTokens,
  'GET launch/token': getToken,
  'GET launch/candles': getCandles,
  'GET launch/trades': getTrades,
  'GET launch/holders': getHolders,
  'GET launch/creator': getCreator,
  'GET launch/predict': predict,
  'GET launch/pairs': getPairs,
  'GET launch/stats': getStats,
  'GET launch/profile': getProfile,
  'POST launch/profile': saveProfile,
  ...ECONOMY_ROUTES,
  ...KEEPER_ROUTES,
};

function launchChain(q) {
  const chainId = chainOf(q);
  const d = launchDeployment(chainId);
  if (!d) fail(`Place Launch is not deployed on chain ${chainId}`);
  return { chainId, d };
}

const quoteParam = (v) => (v === 'eth' || v === 'ETH' ? ETH : addressOf(v, 'quote'));
const outQuote = (a) => (a === ETH ? 'eth' : a);
// Not people: the pool, every release's hook, PlaceStaking (staked tokens sit there) and the burn address.
const notPeople = (chainId) => {
  const list = launchReleases(chainId);
  return [ETH, DEAD, list[0].poolManager, ...list.map((r) => r.hook), ...list.map((r) => r.staking).filter(Boolean)];
};
const currentVersion = (chainId) => launchDeployment(chainId).version;
const legacyVersion = (chainId) => launchReleases(chainId).find((r) => r.legacy)?.version ?? currentVersion(chainId);

/**
 * The last block the indexer has read for this chain. Read after the data, so everything up to it is in the
 * answer; the site adds live swaps from later blocks on top (src/launch/live.js) without counting any twice.
 */
async function indexedBlock(db, chainId) {
  const [r] = await db.query("select max(last_block)::text as b from indexer_cursors where chain_id = $1 and contract like 'events:%'", [chainId]);
  return r?.b == null ? null : Number(r.b);
}

async function fresh(deps, chainId) {
  if (deps.refresh) await deps.refresh(chainId).catch(() => {}); // stale data beats no data
}

/** Pair assets with symbol, decimals and USD price. */
async function pairInfo(deps, chainId) {
  const rows = await deps.db.query(
    `select quote from launch_quotes where chain_id = $1 union select distinct quote from launch_tokens where chain_id = $1`,
    [chainId]
  );
  const quotes = rows.map((r) => r.quote);
  await ensureTokenMeta(deps, chainId, quotes);
  const meta = new Map(
    (await deps.db.query('select address, name, symbol, decimals from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, quotes])).map((m) => [m.address, m])
  );
  const info = new Map(
    quotes.map((qt) => [qt, qt === ETH ? { symbol: 'ETH', name: 'Ether', decimals: 18 } : { symbol: meta.get(qt)?.symbol ?? null, name: meta.get(qt)?.name ?? null, decimals: meta.get(qt)?.decimals ?? null }])
  );
  const usd = await quoteUsd(deps, quotes.map((qt) => ({ quote: qt, symbol: info.get(qt).symbol })));
  for (const [qt, i] of info) i.usd = usd.get(qt) ?? null;
  return info;
}

const TOKEN_SELECT = `
  select t.*, t.launch_supply::text as launch_supply, t.quote_reserve::text as quote_reserve, t.token_out::text as token_out,
    t.dev_buy_in::text as dev_buy_in, t.dev_buy_out::text as dev_buy_out, t.init_sqrt_price::text as init_sqrt_price,
    t.sqrt_price::text as sqrt_price, q.decimals as quote_decimals, (ha.address is not null) as asset_hidden,
    coalesce(v.volume, 0)::text as volume_24h, coalesce(v.trades, 0) as trades_24h, p.price as price_24h,
    coalesce(vh.volume, 0)::text as volume_1h, coalesce(va.volume, 0)::text as volume_all,
    (select count(*)::int from launch_balances b where b.chain_id = t.chain_id and b.token = t.token and b.balance > 0
       and not (b.account = any($3::text[]))) as holders,
    (select balance::text from launch_balances b where b.chain_id = t.chain_id and b.token = t.token and b.account = '${DEAD}') as burned,
    qp.usd as quote_usd, e.version, e.burn_bps, e.community_bps
  from launch_tokens t
  left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token
  left join launch_quotes q on q.chain_id = t.chain_id and q.quote = t.quote
  left join hidden_assets ha on ha.chain_id = t.chain_id and ha.address = t.token
  left join unnest($4::text[], $5::float8[]) as qp(quote, usd) on qp.quote = t.quote
  left join lateral (select sum(s.quote_amount) as volume, count(*)::int as trades from launch_swaps s
                     where s.chain_id = t.chain_id and s.token = t.token and s.at > $2) v on true
  left join lateral (select sum(s.quote_amount) as volume from launch_swaps s
                     where s.chain_id = t.chain_id and s.token = t.token and s.at > $2::timestamptz + interval '23 hours') vh on true
  left join lateral (select sum(s.quote_amount) as volume from launch_swaps s
                     where s.chain_id = t.chain_id and s.token = t.token) va on true
  left join lateral (select s.price from launch_swaps s where s.chain_id = t.chain_id and s.token = t.token and s.at <= $2
                     order by s.block desc, s.log_index desc limit 1) p on true`;

function tokenParams(chainId, d, now, pairs) {
  const quotes = [...pairs.keys()];
  return [chainId, new Date((now - DAY) * 1000).toISOString(), notPeople(chainId), quotes, quotes.map((qt) => pairs.get(qt).usd)];
}

/** Release and economics of a token row: 0.2.0 baskets, or the 0.1.0 buyback / rewards shares (legacy). */
function economicsOf(r) {
  const chainId = Number(r.chain_id);
  const version = r.version || legacyVersion(chainId);
  const legacy = version !== currentVersion(chainId);
  const xShares = JSON.parse(r.x_shares || '[]');
  const hook = releaseByVersion(chainId, version).hook;
  if (legacy) return { version, legacy, hook, economics: { version, legacy, buybackBps: r.buyback_bps, buybackBurn: r.buyback_burn, rewardsBps: r.rewards_bps, xShares } };
  const burnBps = Number(r.burn_bps || 0);
  const communityBps = Number(r.community_bps || 0);
  return { version, legacy, hook, economics: { version, legacy, burnBps, communityBps, creatorBps: 10_000 - burnBps - communityBps, xShares } };
}

function tokenView(r, pairs) {
  const quote = pairs.get(r.quote) || {};
  const qd = Number(r.quote_decimals ?? quote.decimals ?? 18);
  const usd = r.quote_usd == null ? null : Number(r.quote_usd);
  const price = r.price == null ? null : Number(r.price);
  const supply = units(r.launch_supply, 18);
  const burned = units(r.burned ?? 0, 18);
  const quoteReserve = units(r.quote_reserve, qd);
  const tokenReserve = units(BigInt(r.launch_supply) - BigInt(r.token_out), 18);
  const ref = r.price_24h != null ? Number(r.price_24h) : r.created_at && Date.now() - new Date(r.created_at).getTime() < DAY * 1000 ? firstPrice(r) : null;
  const toUsd = (v) => (v == null || usd == null ? null : v * usd);
  const fdv = price == null ? null : price * supply;
  const marketCap = price == null ? null : price * (supply - burned);
  const liquidity = price == null ? quoteReserve : quoteReserve + tokenReserve * price;
  const volume24h = units(r.volume_24h, qd);
  const volume1h = units(r.volume_1h ?? 0, qd);
  const volumeAll = units(r.volume_all ?? 0, qd);
  return {
    chainId: Number(r.chain_id),
    address: r.token,
    kind: r.kind,
    name: r.name,
    symbol: r.symbol,
    decimals: 18,
    contractURI: r.contract_uri || null,
    links: JSON.parse(r.extra || '{}'),
    metadataEditable: r.metadata_editable,
    quote: { address: outQuote(r.quote), symbol: quote.symbol ?? null, decimals: qd, usd, category: pairCategory(quote.symbol) },
    poolId: r.pool_id,
    vault: r.vault,
    creator: r.current_creator,
    originalCreator: r.original_creator,
    pendingCreator: r.pending_creator || null,
    ...economicsOf(r),
    devBuy: r.dev_buy_in ? { funding: outQuote(r.dev_buy_funding), amountIn: r.dev_buy_in, amountOut: r.dev_buy_out } : null,
    price,
    priceUsd: toUsd(price),
    change24h: change(ref, price),
    supply,
    burned,
    fdv,
    fdvUsd: toUsd(fdv),
    marketCap,
    marketCapUsd: toUsd(marketCap),
    liquidity: { quote: quoteReserve, token: tokenReserve, value: liquidity, valueUsd: toUsd(liquidity) },
    volume24h,
    volume24hUsd: toUsd(volume24h),
    volume1h,
    volume1hUsd: toUsd(volume1h),
    volumeAll,
    volumeAllUsd: toUsd(volumeAll),
    trades24h: Number(r.trades_24h || 0),
    trades: Number(r.swaps || 0),
    holders: Number(r.holders || 0),
    lastTradeAt: iso(r.last_trade_at),
    createdAt: iso(r.created_at),
    createdBlock: str(r.created_block),
    createdTx: r.created_tx,
    hidden: Boolean(r.hidden || r.asset_hidden),
  };
}

// For a token younger than a day, its 24 h change is measured from the opening price.
function firstPrice(r) {
  if (r.init_sqrt_price == null) return null;
  const s = Number(BigInt(r.init_sqrt_price)) / 2 ** 96;
  const raw = s * s;
  const scale = 10 ** (18 - Number(r.quote_decimals ?? 18));
  return r.token_is_currency0 ? raw * scale : scale / raw;
}

// ─────────────────────────────── feed and token page ───────────────────────────────

async function listTokens({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  await fresh(deps, chainId);
  const { limit, offset } = limits(q);
  const pairs = await pairInfo(deps, chainId);
  const params = tokenParams(chainId, d, deps.now(), pairs);
  const where = ['t.chain_id = $1'];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.quote) add('t.quote = ?', quoteParam(q.quote));
  if (q.creator) add('t.current_creator = ?', addressOf(q.creator, 'creator'));
  if (q.kind) add('t.kind = ?', ['b20', 'erc20'].includes(q.kind) ? q.kind : fail('kind must be b20 or erc20'));
  if (q.q) {
    const text = String(q.q).trim().slice(0, 42);
    params.push(`%${text.replace(/[%_]/g, '')}%`, text.toLowerCase());
    where.push(`(t.name ilike $${params.length - 1} or t.symbol ilike $${params.length - 1} or t.token = $${params.length})`);
  }
  if (q.category) {
    if (!PAIR_CATEGORIES.includes(q.category)) fail('category must be crypto or stocks');
    const crypto = [...pairs].filter(([, p]) => pairCategory(p.symbol) === 'crypto').map(([qt]) => qt);
    add(q.category === 'crypto' ? 't.quote = any(?::text[])' : 'not (t.quote = any(?::text[]))', crypto);
  }
  if (q.includeHidden !== '1') where.push('not t.hidden and ha.address is null');
  const usd = (col) => `coalesce(${col}, 0) / power(10, coalesce(q.decimals, 18)) * coalesce(qp.usd, 0)`;
  const liquidityUsd = `(${usd('t.quote_reserve')} + (t.launch_supply - t.token_out) / 1e18 * coalesce(t.price, 0) * coalesce(qp.usd, 0))`;
  const orders = {
    new: 't.created_at desc, t.token',
    // Trending weighs the last hour six times the rest of the day, so fresh activity rises first.
    trending: `(${usd('vh.volume')} * 5 + ${usd('v.volume')}) desc, coalesce(v.trades, 0) desc, t.created_at desc`,
    volume: `${usd('v.volume')} desc, coalesce(v.trades, 0) desc, t.created_at desc`,
    liquidity: `${liquidityUsd} desc, t.created_at desc`,
    mcap: `coalesce(t.price, 0) * coalesce(qp.usd, 0) desc, t.created_at desc`,
    active: 't.last_trade_at desc nulls last, t.created_at desc',
  };
  const sort = q.sort || 'new';
  if (!orders[sort]) fail('sort must be new, trending, volume, liquidity, mcap or active');
  const rows = await deps.db.query(`${TOKEN_SELECT} where ${where.join(' and ')} order by ${orders[sort]} limit ${limit + 1} offset ${offset}`, params);
  const indexed = await indexedBlock(deps.db, chainId);
  return reply(200, { chainId, sort, indexedBlock: indexed, tokens: rows.slice(0, limit).map((r) => tokenView(r, pairs)), nextOffset: rows.length > limit ? offset + limit : null }, 'public, max-age=5');
}

async function loadToken(deps, chainId, d, address) {
  const pairs = await pairInfo(deps, chainId);
  const [row] = await deps.db.query(`${TOKEN_SELECT} where t.chain_id = $1 and t.token = $6`, [...tokenParams(chainId, d, deps.now(), pairs), address]);
  if (!row) fail('Not a Place Launch token (or not indexed yet)', 404);
  return { row, pairs, token: tokenView(row, pairs) };
}

async function getToken({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  const address = addressOf(q.address);
  await fresh(deps, chainId);
  const { row, token } = await loadToken(deps, chainId, d, address);
  const now = deps.now();
  const ago = (s) => new Date((now - s) * 1000).toISOString();
  const [vol] = await deps.db.query(
    `select coalesce(sum(quote_amount) filter (where at > $3), 0)::text as h1, coalesce(sum(quote_amount) filter (where at > $4), 0)::text as d7,
            coalesce(sum(quote_amount), 0)::text as total,
            count(*) filter (where at > $5 and side = 'buy')::int as buys24h, count(*) filter (where at > $5 and side = 'sell')::int as sells24h,
            count(distinct trader) filter (where at > $5)::int as traders24h
     from launch_swaps where chain_id = $1 and token = $2`,
    [chainId, address, ago(3600), ago(7 * DAY), ago(DAY)]
  );
  const qd = token.quote.decimals;
  const trades = await tradeRows(deps.db, { chainId, token: address, limit: 20 });
  const holders = await holderRows(deps.db, d, { chainId, row, limit: 20, offset: 0 });
  const rewardTokens = (await deps.db.query('select distinct reward_token from campaigns where chain_id = $1 and target = $2', [chainId, address])).map((r) => r.reward_token).filter((x) => x !== ETH);
  await ensureTokenMeta(deps, chainId, rewardTokens);
  const campaigns = await deps.db.query(
    `select c.campaign_id::text as id, c.hub, c.pool::text as pool, c.snapshot_at, c.claim_end, c.merkle_root, c.stage, c.claimed::text as claimed, c.created_at, c.created_tx,
            c.creator, c.reward_token, c.rules_hash, c.total_allocated::text as total_allocated, c.fee::text as fee, rm.symbol as r_symbol, rm.decimals as r_decimals
     from campaigns c left join token_meta rm on rm.chain_id = c.chain_id and rm.address = c.reward_token
     where c.chain_id = $1 and c.target = $2 and not c.hidden order by c.created_at desc limit 50`,
    [chainId, address]
  );
  const announcements = await deps.db.query(
    'select announcement_id, creator, description, uri, tx, at from launch_announcements where chain_id = $1 and token = $2 order by at desc limit 20',
    [chainId, address]
  );
  const vaultTotals = await vaultSummary(deps.db, chainId, row.vault);
  const burns = await burnHistory(deps.db, chainId, row.vault);
  const live = token.legacy ? null : await vaultPublicState(deps, chainId, row.vault, now);
  const staking = await stakingForToken(deps, chainId, address, now);
  return reply(
    200,
    {
      indexedBlock: await indexedBlock(deps.db, chainId),
      token,
      volume: { h1: units(vol.h1, qd), h24: token.volume24h, d7: units(vol.d7, qd), all: units(vol.total, qd) },
      activity24h: { buys: vol.buys24h, sells: vol.sells24h, traders: vol.traders24h },
      trades: trades.map((t) => tradeView(t, qd)),
      holders,
      vault: row.vault ? { address: row.vault, ...vaultTotals } : null,
      burns,
      // Community fund and the daily process() (0.2.0); null for legacy tokens or when the chain cannot be read.
      fund: live ? { ...live.fund, quote: live.quote, defaultCampaign: live.defaultCampaign, process: live.process, burnReserve: live.burn.reserve } : null,
      staking,
      campaigns: campaigns.map((c) => ({
        id: c.id,
        hub: c.hub,
        pool: c.pool,
        fee: c.fee,
        rewardToken: outQuote(c.reward_token),
        rewardSymbol: c.reward_token === ETH ? 'ETH' : c.r_symbol ?? null,
        rewardDecimals: c.reward_token === ETH ? 18 : c.r_decimals ?? null,
        fromVault: c.creator === row.vault,
        // Official = from the token's creator or its community fund; everyone else is the community.
        section: c.creator === row.vault || c.creator === row.current_creator || c.creator === row.original_creator ? 'official' : 'community',
        creator: c.creator,
        status: campaignStatus(c, now),
        snapshotAt: iso(c.snapshot_at),
        claimEnd: iso(c.claim_end),
        merkleRoot: c.merkle_root,
        totalAllocated: c.total_allocated,
        claimed: c.claimed,
        createdAt: iso(c.created_at),
        createdTx: c.created_tx,
      })),
      announcements: announcements.map((a) => ({ id: a.announcement_id, creator: a.creator, description: a.description, uri: a.uri, tx: a.tx, at: iso(a.at) })),
    },
    'public, max-age=5'
  );
}

// ─────────────────────────────── candles, trades, holders ───────────────────────────────

async function getCandles({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  const address = addressOf(q.address);
  const interval = CANDLE_INTERVALS[q.interval || '5m'];
  if (!interval) fail(`interval must be one of ${Object.keys(CANDLE_INTERVALS).join(', ')}`);
  await fresh(deps, chainId);
  const { row, token } = await loadToken(deps, chainId, d, address);
  const now = deps.now();
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
  const to = q.to ? Number(q.to) : now;
  const created = Math.floor(new Date(row.created_at).getTime() / 1000);
  const from = Math.max(q.from ? Number(q.from) : to - interval * (limit - 1), created);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) fail('Bad from/to');
  if ((to - from) / interval > 5000) fail('Too many candles: narrow from/to or use a longer interval');
  const qd = token.quote.decimals;
  const rows = await deps.db.query(
    `select (floor(extract(epoch from at) / $3) * $3)::bigint as t,
            (array_agg(price order by block, log_index))[1] as o, max(price) as h, min(price) as l,
            (array_agg(price order by block desc, log_index desc))[1] as c, sum(quote_amount)::text as v, count(*)::int as trades
     from launch_swaps where chain_id = $1 and token = $2 and at >= $4 and at < $5 group by 1 order by 1`,
    [chainId, address, interval, new Date(Math.floor(from / interval) * interval * 1000).toISOString(), new Date((Math.floor(to / interval) + 1) * interval * 1000).toISOString()]
  );
  const [prev] = await deps.db.query(
    'select price from launch_swaps where chain_id = $1 and token = $2 and at < $3 order by block desc, log_index desc limit 1',
    [chainId, address, new Date(Math.floor(from / interval) * interval * 1000).toISOString()]
  );
  const prevClose = prev ? Number(prev.price) : firstPrice(row);
  const candles = fillCandles(
    rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: units(r.v, qd), trades: r.trades })),
    { interval, from, to, prevClose }
  );
  const indexed = await indexedBlock(deps.db, chainId);
  return reply(200, { chainId, token: address, indexedBlock: indexed, interval: q.interval || '5m', quote: token.quote, price: token.price, candles }, 'public, max-age=5');
}

async function tradeRows(db, { chainId, token, trader, limit, before }) {
  const params = [chainId];
  const where = ['s.chain_id = $1'];
  if (token) {
    params.push(token);
    where.push(`s.token = $${params.length}`);
  }
  if (trader) {
    params.push(trader);
    where.push(`s.trader = $${params.length}`);
  }
  if (before) {
    const [b, i] = String(before).split(':');
    if (!/^\d+$/.test(b) || !/^\d+$/.test(i || '')) fail('before must be block:logIndex');
    params.push(b, Number(i));
    where.push(`(s.block, s.log_index) < ($${params.length - 1}::bigint, $${params.length})`);
  }
  return db.query(
    `select s.*, s.token_amount::text as token_amount, s.quote_amount::text as quote_amount, s.fee::text as fee, s.block::text as block
     from launch_swaps s where ${where.join(' and ')} order by s.block desc, s.log_index desc limit ${limit}`,
    params
  );
}

function tradeView(t, qd) {
  return {
    token: t.token,
    side: t.side,
    trader: t.trader,
    router: t.router,
    tokenAmount: t.token_amount,
    quoteAmount: t.quote_amount,
    tokens: units(t.token_amount, 18),
    quote: units(t.quote_amount, qd),
    fee: t.fee,
    price: Number(t.price),
    tx: t.tx,
    block: t.block,
    logIndex: Number(t.log_index),
    cursor: `${t.block}:${t.log_index}`,
    at: iso(t.at),
  };
}

async function getTrades({ query: q }, deps) {
  const { chainId } = launchChain(q);
  // Without address or trader: the live feed of the whole launchpad (dashboard ticker).
  const token = q.address ? addressOf(q.address) : null;
  const trader = q.trader ? addressOf(q.trader, 'trader') : null;
  await fresh(deps, chainId);
  const { limit } = limits(q, 200, 50);
  const rows = await tradeRows(deps.db, { chainId, token, trader, limit: limit + 1, before: q.before });
  const pairs = await pairInfo(deps, chainId);
  const tokens = new Map(
    (
      await deps.db.query(
        `select t.token, t.name, t.symbol, t.contract_uri, t.quote, coalesce(q.decimals, 18) as d, (ha.address is not null or t.hidden) as hidden
         from launch_tokens t left join launch_quotes q on q.chain_id = t.chain_id and q.quote = t.quote
         left join hidden_assets ha on ha.chain_id = t.chain_id and ha.address = t.token
         where t.chain_id = $1 and t.token = any($2::text[])`,
        [chainId, [...new Set(rows.map((r) => r.token))]]
      )
    ).map((r) => [r.token, r])
  );
  const page = rows.slice(0, limit);
  const trades = page
    .filter((t) => token || trader || !tokens.get(t.token)?.hidden)
    .map((t) => {
      const info = tokens.get(t.token) || {};
      const quote = pairs.get(info.quote) || {};
      const view = tradeView(t, Number(info.d ?? 18));
      return {
        ...view,
        name: info.name ?? null,
        symbol: info.symbol ?? null,
        contractURI: info.contract_uri || null,
        quoteSymbol: quote.symbol ?? null,
        valueUsd: quote.usd == null ? null : view.quote * quote.usd,
      };
    });
  const indexed = await indexedBlock(deps.db, chainId);
  return reply(200, { chainId, indexedBlock: indexed, trades, next: rows.length > limit ? `${page[page.length - 1].block}:${page[page.length - 1].log_index}` : null }, 'public, max-age=5');
}

async function holderRows(db, d, { chainId, row, limit, offset }) {
  const rows = await db.query(
    `select account, balance::text as balance from launch_balances where chain_id = $1 and token = $2 and balance > 0
     order by launch_balances.balance desc, account limit ${limit} offset ${offset}`,
    [chainId, row.token]
  );
  const tags = new Map([
    [d.poolManager, 'pool'],
    ...launchReleases(chainId).map((x) => [x.hook, 'hook']),
    ...launchReleases(chainId).filter((x) => x.staking).map((x) => [x.staking, 'staking']),
    [DEAD, 'burned'],
  ]);
  if (row.vault) tags.set(row.vault, 'vault');
  return rows.map((h) => ({
    account: h.account,
    balance: h.balance,
    share: Number((BigInt(h.balance) * 1_000_000n) / BigInt(row.launch_supply)) / 10_000, // percent of supply
    tag: tags.get(h.account) || (h.account === row.current_creator ? 'creator' : null),
  }));
}

async function getHolders({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  const address = addressOf(q.address);
  await fresh(deps, chainId);
  const [row] = await deps.db.query('select token, vault, current_creator, launch_supply::text as launch_supply from launch_tokens where chain_id = $1 and token = $2', [chainId, address]);
  if (!row) fail('Not a Place Launch token (or not indexed yet)', 404);
  const { limit, offset } = limits(q, 200, 50);
  const holders = await holderRows(deps.db, d, { chainId, row, limit, offset });
  const [{ n }] = await deps.db.query(
    'select count(*)::int as n from launch_balances where chain_id = $1 and token = $2 and balance > 0 and not (account = any($3::text[]))',
    [chainId, address, notPeople(chainId)]
  );
  return reply(200, { chainId, token: address, holders: n, list: holders, nextOffset: holders.length === limit ? offset + limit : null }, 'public, max-age=10');
}

// ─────────────────────────────── creator panel ───────────────────────────────

async function vaultSummary(db, chainId, vault) {
  if (!vault) return {};
  const [s] = await db.query(
    `select coalesce(sum(amount) filter (where kind = 'collected'), 0)::text as collected,
            coalesce(sum(amount) filter (where kind = 'bought_back'), 0)::text as bought_back_quote,
            coalesce(sum(amount2) filter (where kind = 'bought_back'), 0)::text as bought_back_tokens,
            coalesce(sum(amount) filter (where kind = 'creator_paid'), 0)::text as creator_paid,
            coalesce(sum(amount) filter (where kind = 'x_paid'), 0)::text as x_paid,
            coalesce(sum(amount) filter (where kind = 'campaign'), 0)::text as to_campaigns,
            count(*) filter (where kind in ('campaign', 'fund_campaign'))::int as campaigns,
            coalesce(sum(amount) filter (where kind = 'burned'), 0)::text as burned_quote,
            coalesce(sum(amount2) filter (where kind = 'burned'), 0)::text as burned_tokens,
            coalesce(sum((data::json->>'toCommunity')::numeric) filter (where kind = 'collected'), 0)::text as to_fund,
            count(*) filter (where kind = 'fund_staking')::int as staking_programs
     from launch_vault_events where chain_id = $1 and vault = $2`,
    [chainId, vault]
  );
  return {
    totals: {
      collected: s.collected,
      boughtBackQuote: s.bought_back_quote,
      boughtBackTokens: s.bought_back_tokens,
      creatorPaid: s.creator_paid,
      xPaid: s.x_paid,
      toCampaigns: s.to_campaigns,
      campaigns: s.campaigns,
      burnedQuote: s.burned_quote,
      burnedTokens: s.burned_tokens,
      toFund: s.to_fund,
      stakingPrograms: s.staking_programs,
    },
  };
}

export { revertReason };
const CREATOR_VAULT_ABI = LEGACY_CREATOR_VAULT_ABI; // the panel below is the 0.1.0 one

const VAULT_READS = ['buybackReserve', 'creatorOwed', 'xOwedTotal', 'rewardsAvailable', 'pendingFees', 'payoutAddress', 'currentCreator', 'lastCampaignAt', 'rewardsConfig', 'buybackBps', 'buybackBurn', 'rewardsBps'];

/** 0.1.0 (legacy) vault: live state, the claim quote (a dry run of claim(0) as the creator), rewards check. */
async function vaultPanel(deps, chainId, t, slippageBps, now) {
  const client = deps.client(chainId);
  const res = await retry(() =>
    client.multicall({ contracts: VAULT_READS.map((functionName) => ({ address: t.vault, abi: CREATOR_VAULT_ABI, functionName })), allowFailure: false })
  );
  const v = Object.fromEntries(VAULT_READS.map((k, i) => [k, res[i]]));
  const creator = v.currentCreator.toLowerCase();
  const sim = async (functionName, args, account) => {
    try {
      const { result } = await client.simulateContract({ address: t.vault, abi: CREATOR_VAULT_ABI, functionName, args, account });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: revertReason(e) };
    }
  };
  // claim(minOut) first collects the pending fees; the dry run returns exactly what it would pay and buy.
  const claim = await sim('claim', [0n], creator);
  const boughtBack = claim.ok ? claim.result[1] : null;
  const minOut = boughtBack == null ? null : (boughtBack * BigInt(10_000 - slippageBps)) / 10_000n;
  const pending = v.pendingFees;
  const rewardsAfterCollect = v.rewardsAvailable + (pending * BigInt(v.rewardsBps)) / 10_000n;
  const cfg = v.rewardsConfig;
  const nextAt = Number(v.lastCampaignAt) === 0 ? now : Number(v.lastCampaignAt) + Number(cfg.interval);
  const anyone = cfg.hub === ETH ? { ok: false, error: 'rewards disabled' } : await sim('startRewardsCampaign', [], t.vault);
  const byCreator = cfg.hub === ETH ? anyone : await sim('startRewardsCampaign', [], creator);
  return {
    version: 'legacy',
    address: t.vault,
    creator,
    payout: v.payoutAddress.toLowerCase(),
    economics: { buybackBps: Number(v.buybackBps), buybackBurn: v.buybackBurn, rewardsBps: Number(v.rewardsBps) },
    balances: {
      pendingFees: pending.toString(),
      buybackReserve: v.buybackReserve.toString(),
      creatorOwed: v.creatorOwed.toString(),
      xOwed: v.xOwedTotal.toString(),
      rewardsAvailable: v.rewardsAvailable.toString(),
    },
    claim: claim.ok
      ? {
          paid: claim.result[0].toString(),
          buybackQuoteIn: (v.buybackReserve + (pending * BigInt(v.buybackBps)) / 10_000n).toString(),
          boughtBack: boughtBack.toString(),
          buybackTo: v.buybackBurn ? 'burn' : 'payout',
          slippageBps,
          minOut: minOut.toString(),
          tx: { to: t.vault, value: '0', from: creator, data: encodeFunctionData({ abi: CREATOR_VAULT_ABI, functionName: 'claim', args: [minOut] }) },
        }
      : { error: claim.error },
    rewards: {
      available: rewardsAfterCollect.toString(),
      minimum: cfg.minAmount.toString(),
      interval: Number(cfg.interval),
      lastCampaignAt: Number(v.lastCampaignAt) ? iso(Number(v.lastCampaignAt) * 1000) : null,
      nextCampaignAt: iso(nextAt * 1000),
      canStart: anyone.ok,
      canStartAsCreator: byCreator.ok,
      campaignId: anyone.ok ? anyone.result.toString() : byCreator.ok ? byCreator.result.toString() : null,
      reason: anyone.ok ? null : anyone.error,
      tx: { to: t.vault, value: '0', data: encodeFunctionData({ abi: CREATOR_VAULT_ABI, functionName: 'startRewardsCampaign' }) },
      collectTx: { to: t.vault, value: '0', data: encodeFunctionData({ abi: CREATOR_VAULT_ABI, functionName: 'collect' }) },
    },
  };
}

async function getCreator({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  const creator = addressOf(q.address, 'address');
  const slippageBps = q.slippageBps == null ? 300 : Number(q.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) fail('slippageBps must be 0–5000');
  await fresh(deps, chainId);
  const pairs = await pairInfo(deps, chainId);
  const params = [...tokenParams(chainId, d, deps.now(), pairs), creator];
  let sql = `${TOKEN_SELECT} where t.chain_id = $1 and (t.current_creator = $6 or t.original_creator = $6)`;
  if (q.token) {
    params.push(addressOf(q.token, 'token'));
    sql += ` and t.token = $${params.length}`;
  }
  const rows = await deps.db.query(`${sql} order by t.created_at desc limit 50`, params);
  const now = deps.now();
  const tokens = [];
  for (const r of rows) {
    const t = tokenView(r, pairs);
    const panel = !(r.vault && r.current_creator === creator) ? null : t.legacy ? await vaultPanel(deps, chainId, r, slippageBps, now) : await vaultPanelV2(deps, chainId, r, now);
    const history = r.vault
      ? await deps.db.query(
          `select kind, amount::text as amount, amount2::text as amount2, account, ref, data, tx, at from launch_vault_events
           where chain_id = $1 and vault = $2 order by block desc, log_index desc limit 30`,
          [chainId, r.vault]
        )
      : [];
    tokens.push({
      token: t,
      isCurrentCreator: r.current_creator === creator,
      vault: panel,
      ...(await vaultSummary(deps.db, chainId, r.vault)),
      history: history.map((h) => ({ kind: h.kind, amount: h.amount, amount2: h.amount2, account: h.account, ref: h.ref, data: h.data ? JSON.parse(h.data) : null, tx: h.tx, at: iso(h.at) })),
    });
  }
  return reply(200, { chainId, creator, tokens });
}

// ─────────────────────────────── launch form ───────────────────────────────

const FACTORY_READS = ['configVersion', 'nativeLaunchFee', 'launchCreationEnabled', 'launchSupply'];

/**
 * Everything the launch form needs to send createLaunch: a creatorSalt mined so the token address ends with
 * 01 (plus an optional vanity suffix), the predicted token and vault, config version, fee, start price, and
 * the encoded call. The address is double-checked with the factory's own predictLaunchToken.
 */
async function predict({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  const creator = addressOf(q.creator, 'creator');
  const kind = q.kind || 'b20';
  if (!KIND_ID[kind]) fail('kind must be b20 or erc20');
  const quote = quoteParam(q.quote || 'eth');
  const name = String(q.name || '').trim();
  const symbol = String(q.symbol || '').trim();
  if (!name || name.length > 64) fail('name must be 1–64 characters');
  if (!/^[A-Za-z0-9$]{1,16}$/.test(symbol)) fail('symbol must be 1–16 letters or digits');
  const suffix = String(q.suffix || '').toLowerCase().replace(/^0x/, '');
  let ending;
  try {
    ending = requiredEnding(suffix);
  } catch (e) {
    fail(e.message);
  }
  if (ending.length - 2 > MAX_SUFFIX) fail(`suffix may have at most ${MAX_SUFFIX} hex characters before 01 (mine longer ones in the browser)`);
  const keys = [];
  const values = [];
  for (const k of ['website', 'x', 'telegram']) {
    if (q[k]) {
      if (!/^https:\/\/\S{3,200}$/.test(q[k])) fail(`${k} must be an https:// link`);
      keys.push(k);
      values.push(q[k]);
    }
  }
  const bps = (v, name) => {
    const n = v == null || v === '' ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) fail(`${name} must be 0–10000`);
    return n;
  };
  // Three baskets of the creator side: burn, community fund, the rest to the creator / X.
  const burnBps = bps(q.burnBps, 'burnBps');
  const communityBps = bps(q.communityBps, 'communityBps');
  if (burnBps + communityBps > 10_000) fail('burnBps + communityBps must be at most 10000');
  // X accounts that share the creator's part: "xId:bps,xId:bps" (numeric X user ids, at most 5).
  const xShares = String(q.xShares || '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [id, b] = pair.split(':');
      if (!/^\d{1,20}$/.test(id || '')) fail('xShares: X account ids are numbers');
      return { xId: BigInt(id), bps: bps(b, 'xShares bps') };
    });
  if (xShares.length > 5) fail('At most 5 X accounts can share the creator fee');
  if (new Set(xShares.map((x) => x.xId)).size !== xShares.length) fail('xShares: each X account once');
  if (xShares.some((x) => x.bps === 0)) fail('xShares: every share needs some bps');
  // X shares are bps of what is left for the creator after burn and community (PlaceCreatorVault.XShare).
  if (xShares.reduce((s, x) => s + x.bps, 0) > 10_000) fail('X shares add up to more than 100% of the creator part');
  const keepSalt = /^0x[0-9a-fA-F]{64}$/.test(String(q.salt || '')) ? String(q.salt).toLowerCase() : null;
  const now = deps.now();
  const client = deps.client(chainId);
  const reads = await retry(() =>
    client.multicall({
      contracts: [
        ...FACTORY_READS.map((functionName) => ({ address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName })),
        { address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'quoteConfig', args: [quote] },
        { address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'quoteLimits', args: [quote] },
      ],
      allowFailure: false,
    })
  );
  const [configVersion, nativeLaunchFee, enabled, supply, quoteConfig, quoteLimits] = reads;
  const [maxBurnPerProcess, defaultCampaignMinimum] = Array.isArray(quoteLimits) ? quoteLimits : [quoteLimits.maxBurnPerProcess, quoteLimits.defaultCampaignMinimum];
  const [registered, quoteDecimals, startTick] = quoteConfig;
  if (!registered) fail('This pair is not registered');
  const params = {
    tokenKind: KIND_ID[kind],
    tokenName: name,
    tokenSymbol: symbol,
    tokenContractURI: String(q.uri || ''),
    creatorSalt: `0x${'0'.repeat(64)}`,
    quoteToken: quote,
    expectedConfigVersion: configVersion,
    deadline: BigInt(now + 20 * 60),
    metadataEditable: q.editable === '1' || q.editable === 'true',
    metadataKeys: keys,
    metadataValues: values,
    economics: { burnBps, communityBps, xShares },
  };
  const initCodeHash = kind === 'erc20' ? await retry(() => client.readContract({ address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'launchTokenInitCodeHash', args: [params] })) : null;
  const base = { kind, creator, factory: d.factory, tokenDeployer: d.tokenDeployer, vaultImplementation: d.creatorVaultImplementation, initCodeHash };
  // A random start, so two forms open at once never mine the same salt.
  const start = BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}`) << 64n;
  // The form passes back the salt it already shows, so the address stays put while details change. It is
  // kept when it still gives the wanted ending (always for B20; for ERC-20 the address depends on the details).
  const kept = keepSalt ? { ...predictLaunch({ ...base, creatorSalt: keepSalt }), creatorSalt: keepSalt, tries: 0 } : null;
  const hit = kept && kept.token.endsWith(ending) ? { ...kept, tokenChecksum: getAddress(kept.token) } : mineSalt({ ...base, ending, start, maxTries: 1_000_000 });
  if (!hit) fail('No salt found, try a shorter suffix', 422);
  params.creatorSalt = hit.creatorSalt;
  const [onchain, used] = await retry(() =>
    client.multicall({
      contracts: [
        { address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'predictLaunchToken', args: [params, creator] },
        { address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'isLaunchSaltUsed', args: [hit.scopedSalt] },
      ],
      allowFailure: false,
    })
  );
  if (onchain.toLowerCase() !== hit.token) fail(`Prediction mismatch: factory says ${onchain}, Place computed ${hit.token}`, 500);
  if (used) fail('Salt already used, ask again', 409);
  const check = predictLaunch({ ...base, creatorSalt: hit.creatorSalt });
  const qd = Number(quoteDecimals);
  const startPrice = 1.0001 ** Number(startTick) * 10 ** (18 - qd); // quote per token (tick in the token0 frame)
  const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
  return reply(200, {
    chainId,
    token: hit.tokenChecksum,
    vault: check.vault,
    creatorSalt: hit.creatorSalt,
    scopedSalt: hit.scopedSalt,
    tries: hit.tries,
    ending,
    launchEnabled: enabled,
    configVersion: configVersion.toString(),
    nativeLaunchFee: nativeLaunchFee.toString(),
    supply: supply.toString(),
    quote: { address: outQuote(quote), decimals: qd, startTick: Number(startTick), maxBurnPerProcess: maxBurnPerProcess.toString(), defaultCampaignMinimum: defaultCampaignMinimum.toString() },
    startPrice,
    startFdv: startPrice * units(supply, 18),
    deadline: Number(params.deadline),
    launchParams: json(params),
    tx: { to: d.factory, value: nativeLaunchFee.toString(), from: creator, data: encodeFunctionData({ abi: LAUNCH_FACTORY_ABI, functionName: 'createLaunch', args: [params] }) },
  });
}

async function getPairs({ query: q }, deps) {
  const { chainId } = launchChain(q);
  const pairs = await pairInfo(deps, chainId);
  const rows = await deps.db.query(
    `select q.quote, q.decimals, q.start_tick, q.registered, q.rewards_min::text as rewards_min,
            l.max_burn_per_process::text as max_burn, l.default_campaign_minimum::text as default_min,
            (select count(*)::int from launch_tokens t where t.chain_id = q.chain_id and t.quote = q.quote) as launches
     from launch_quotes q left join launch_quote_limits l on l.chain_id = q.chain_id and l.quote = q.quote
     where q.chain_id = $1 order by launches desc, q.quote`,
    [chainId]
  );
  const supply = units(LAUNCH_SUPPLY, 18);
  return reply(
    200,
    {
      chainId,
      pairs: rows
        .filter((r) => r.registered || q.all === '1')
        .map((r) => {
          const p = pairs.get(r.quote) || {};
          const startPrice = 1.0001 ** Number(r.start_tick) * 10 ** (18 - Number(r.decimals));
          return {
            address: outQuote(r.quote),
            symbol: p.symbol ?? null,
            name: p.name ?? null,
            decimals: Number(r.decimals),
            registered: r.registered,
            usd: p.usd ?? null,
            startTick: Number(r.start_tick),
            startPrice,
            startFdv: startPrice * supply,
            startFdvUsd: p.usd == null ? null : startPrice * supply * p.usd,
            category: pairCategory(p.symbol),
            rewardsMinimum: r.rewards_min,
            maxBurnPerProcess: r.max_burn,
            defaultCampaignMinimum: r.default_min,
            launches: r.launches,
          };
        }),
    },
    'public, max-age=30'
  );
}


// ─────────────────────────────── dashboard and profiles ───────────────────────────────

/** Launchpad totals for the dashboard: launches, traders, volume (all time and 24 h, in USD), top market cap. */
async function getStats({ query: q }, deps) {
  const { chainId, d } = launchChain(q);
  await fresh(deps, chainId);
  const pairs = await pairInfo(deps, chainId);
  const [counts] = await deps.db.query(
    `select (select count(*)::int from launch_tokens t left join hidden_assets ha on ha.chain_id = t.chain_id and ha.address = t.token
             where t.chain_id = $1 and not t.hidden and ha.address is null) as tokens,
            (select count(distinct trader)::int from launch_swaps where chain_id = $1) as traders,
            (select count(*)::int from launch_swaps where chain_id = $1) as trades`,
    [chainId]
  );
  const since = new Date((deps.now() - DAY) * 1000).toISOString();
  const byQuote = await deps.db.query(
    `select t.quote, coalesce(sum(s.quote_amount), 0)::text as total, coalesce(sum(s.quote_amount) filter (where s.at > $2), 0)::text as day
     from launch_swaps s join launch_tokens t on t.chain_id = s.chain_id and t.token = s.token where s.chain_id = $1 group by t.quote`,
    [chainId, since]
  );
  let volumeUsd = 0;
  let volume24hUsd = 0;
  for (const r of byQuote) {
    const p = pairs.get(r.quote) || {};
    if (p.usd == null) continue;
    volumeUsd += units(r.total, p.decimals ?? 18) * p.usd;
    volume24hUsd += units(r.day, p.decimals ?? 18) * p.usd;
  }
  const params = tokenParams(chainId, d, deps.now(), pairs);
  const [top] = await deps.db.query(
    `${TOKEN_SELECT} where t.chain_id = $1 and not t.hidden and ha.address is null
     order by coalesce(t.price, 0) * (t.launch_supply - coalesce((select balance from launch_balances b where b.chain_id = t.chain_id and b.token = t.token and b.account = '${DEAD}'), 0)) / 1e18 * coalesce(qp.usd, 0) desc
     limit 1`,
    params
  );
  const topToken = top ? tokenView(top, pairs) : null;
  return reply(
    200,
    {
      chainId,
      indexedBlock: await indexedBlock(deps.db, chainId),
      tokens: counts.tokens,
      traders: counts.traders,
      trades: counts.trades,
      volumeUsd,
      volume24hUsd,
      topMarketCap: topToken ? { address: topToken.address, symbol: topToken.symbol, name: topToken.name, marketCapUsd: topToken.marketCapUsd, marketCap: topToken.marketCap, quote: topToken.quote } : null,
    },
    'public, max-age=10'
  );
}

const profileView = (r) =>
  r ? { address: r.address, name: r.name, avatar: r.avatar, website: r.website, x: r.x, telegram: r.telegram, bio: r.bio, updatedAt: iso(r.updated_at) } : null;

/** Public creator profile(s): `address`, or up to 50 comma-separated `addresses`. */
async function getProfile({ query: q }, deps) {
  if (q.addresses) {
    const list = [...new Set(String(q.addresses).split(',').filter(Boolean).slice(0, 50).map((a) => addressOf(a)))];
    const rows = await deps.db.query('select * from launch_profiles where address = any($1::text[])', [list]);
    return reply(200, { profiles: rows.map(profileView) }, 'public, max-age=30');
  }
  const address = addressOf(q.address);
  const [row] = await deps.db.query('select * from launch_profiles where address = $1', [address]);
  return reply(200, { address, profile: profileView(row) }, 'public, max-age=5');
}

/** Saves a profile signed by its wallet over profileMessage() (EOA or smart wallet, checked on chain). */
async function saveProfile(req, deps) {
  const b = req.body || {};
  const address = addressOf(b.address);
  const chainId = chainOf({ chain: b.chainId });
  let profile;
  try {
    profile = cleanProfile(b.profile);
  } catch (e) {
    fail(e.message);
  }
  const issued = Date.parse(b.issuedAt);
  if (Number.isNaN(issued) || Math.abs(deps.now() * 1000 - issued) > PROFILE_SIGNATURE_MAX_AGE_MS) fail('Signature expired, sign again', 401);
  const [prev] = await deps.db.query('select issued_at from launch_profiles where address = $1', [address]);
  if (prev && new Date(prev.issued_at).getTime() >= issued) fail('A newer profile is already saved', 409);
  const message = profileMessage({ address, profile, issuedAt: b.issuedAt });
  const valid = await deps
    .client(chainId)
    .verifyMessage({ address, message, signature: b.signature })
    .catch(() => false);
  if (!valid) fail('Signature check failed', 401);
  const [row] = await deps.db.query(
    `insert into launch_profiles (address, name, avatar, website, x, telegram, bio, issued_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (address) do update set name = excluded.name, avatar = excluded.avatar, website = excluded.website, x = excluded.x,
       telegram = excluded.telegram, bio = excluded.bio, issued_at = excluded.issued_at, updated_at = now()
     returning *`,
    [address, profile.name, profile.avatar, profile.website, profile.x, profile.telegram, profile.bio, new Date(issued).toISOString()]
  );
  return reply(200, { address, profile: profileView(row) });
}
