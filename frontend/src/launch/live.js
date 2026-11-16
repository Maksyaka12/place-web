// Live launchpad: the browser subscribes to PoolManager Swap events of every launch pool the page knows
// about (one WebSocket subscription, filtered by pool id) and to the factory's Launched event. Swaps land
// here within a block (200 ms on Base), long before the indexer and API see them.
//
// The API says which block it has indexed up to (`indexedBlock` in market answers). The site shows the API's
// numbers plus the live swaps from later blocks, so nothing is counted twice and nothing jumps back when the
// next poll arrives. The merge functions below are pure and tested in tests/launchLive.test.js.
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createPublicClient, webSocket, http, parseAbiItem } from 'viem';
import { PLACE_CHAIN, PLACE_CHAIN_ID, placeClient } from '../place/chain.js';
import { launchDeployment } from './deployments.js';
import { priceFromSqrt, swapSide, units, CANDLE_INTERVALS } from './market.js';

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const WSS = {
  84532: env.VITE_LAUNCH_WSS || 'wss://base-sepolia-rpc.publicnode.com',
  8453: env.VITE_LAUNCH_WSS || 'wss://base-rpc.publicnode.com',
};
const SWAP = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
const LAUNCHED = parseAbiItem('event Launched(address indexed token, bytes32 indexed poolId, address indexed originalCreator, address quoteToken, uint256 launchSupply, int24 tickSpacing)');
const KEEP = 200; // live trades kept per pool
const ETH = '0x0000000000000000000000000000000000000000';
const lc = (a) => String(a || '').toLowerCase();

// ─────────────────────────────── pure merge functions ───────────────────────────────

/** A decoded Swap log of a known pool → one trade, in the shape the API's trades have. */
export function tradeFromLog(log, info, nowMs = Date.now()) {
  const tokenIsCurrency0 = BigInt(lc(info.token)) < BigInt(lc(info.quote) === 'eth' ? ETH : lc(info.quote));
  const s = swapSide({ amount0: log.args.amount0, amount1: log.args.amount1 }, tokenIsCurrency0);
  const qd = info.quoteDecimals;
  const block = Number(log.blockNumber);
  return {
    token: lc(info.token),
    poolId: lc(log.args.id),
    side: s.side,
    trader: null,
    tokens: units(s.tokenAmount, 18),
    quote: units(s.quoteAmount, qd),
    quoteIn: units(s.quoteIn, qd),
    tokenOut: units(s.tokenOut, 18),
    price: priceFromSqrt(log.args.sqrtPriceX96, tokenIsCurrency0, qd),
    tx: log.transactionHash,
    block,
    logIndex: Number(log.logIndex),
    cursor: `${block}:${Number(log.logIndex)}`,
    at: new Date(nowMs).toISOString(),
    name: info.name ?? null,
    symbol: info.symbol ?? null,
    contractURI: info.contractURI ?? null,
    quoteSymbol: info.quoteSymbol ?? null,
    valueUsd: info.usd == null ? null : units(s.quoteAmount, qd) * info.usd,
    live: true,
  };
}

/** Live trades the API answer does not include yet (blocks after its indexedBlock), oldest first. */
export function freshTrades(trades, indexedBlock) {
  if (!trades?.length || indexedBlock == null) return [];
  return trades.filter((t) => t.block > indexedBlock);
}

/** A token from the API with fresh live trades applied: price, caps, liquidity, volumes, counts, 24 h change. */
export function liveToken(token, fresh) {
  if (!token || !fresh?.length) return token;
  const last = fresh[fresh.length - 1];
  const price = last.price;
  const usd = token.quote?.usd ?? null;
  const toUsd = (v) => (v == null || usd == null ? null : v * usd);
  const sum = (k) => fresh.reduce((s, t) => s + (t[k] || 0), 0);
  const supply = token.supply ?? 1e9;
  const burned = token.burned ?? 0;
  const vol = sum('quote');
  const quoteRes = (token.liquidity?.quote ?? 0) + sum('quoteIn');
  const tokenRes = (token.liquidity?.token ?? supply) - sum('tokenOut');
  const ref = token.change24h != null && token.price ? token.price / (1 + token.change24h / 100) : null;
  const liquidity = quoteRes + tokenRes * price;
  return {
    ...token,
    price,
    priceUsd: toUsd(price),
    fdv: price * supply,
    fdvUsd: toUsd(price * supply),
    marketCap: price * (supply - burned),
    marketCapUsd: toUsd(price * (supply - burned)),
    change24h: ref ? ((price - ref) / ref) * 100 : token.change24h,
    liquidity: { ...token.liquidity, quote: quoteRes, token: tokenRes, value: liquidity, valueUsd: toUsd(liquidity) },
    volume24h: (token.volume24h ?? 0) + vol,
    volume24hUsd: toUsd((token.volume24h ?? 0) + vol),
    volume1h: (token.volume1h ?? 0) + vol,
    volume1hUsd: toUsd((token.volume1h ?? 0) + vol),
    volumeAll: (token.volumeAll ?? 0) + vol,
    volumeAllUsd: toUsd((token.volumeAll ?? 0) + vol),
    trades24h: (token.trades24h ?? 0) + fresh.length,
    trades: (token.trades ?? 0) + fresh.length,
    lastTradeAt: last.at,
    liveTick: { cursor: last.cursor, side: last.side },
  };
}

/** API trades (newest first) with fresh live trades on top, without duplicates. */
export function liveTradeList(trades = [], fresh = [], limit = 50) {
  if (!fresh.length) return trades;
  const seen = new Set(trades.map((t) => t.cursor));
  const add = fresh.filter((t) => !seen.has(t.cursor)).reverse();
  return [...add, ...trades].slice(0, limit);
}

/** Candles (oldest first, quote units) with fresh trades folded into their buckets; new buckets start flat. */
export function liveCandles(candles = [], fresh = [], interval = '5m') {
  if (!fresh.length) return candles;
  const iv = CANDLE_INTERVALS[interval] || 300;
  const out = candles.map((c) => ({ ...c }));
  for (const t of fresh) {
    const bucket = Math.floor(new Date(t.at).getTime() / 1000 / iv) * iv;
    let last = out[out.length - 1];
    if (last && bucket < last.t) continue;
    if (!last || bucket > last.t) {
      const open = last ? last.c : t.price;
      if (last) for (let b = last.t + iv; b < bucket; b += iv) out.push({ t: b, o: open, h: open, l: open, c: open, v: 0, trades: 0 });
      last = { t: bucket, o: open, h: open, l: open, c: open, v: 0, trades: 0 };
      out.push(last);
    }
    last.h = Math.max(last.h, t.price);
    last.l = Math.min(last.l, t.price);
    last.c = t.price;
    last.v += t.quote;
    last.trades += 1;
  }
  return out;
}

// ─────────────────────────────── the live store ───────────────────────────────

const pools = new Map(); // poolId → trades (oldest first)
const listeners = new Set();
let version = 0;
const emit = () => {
  version += 1;
  listeners.forEach((l) => l());
};
const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function addLiveTrade(t) {
  const list = pools.get(t.poolId) || [];
  if (list.some((x) => x.cursor === t.cursor)) return;
  const next = [...list, t].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).slice(-KEEP);
  pools.set(t.poolId, next);
  emit();
}

/** Re-renders on every live swap; returns a getter for one pool's live trades. */
export function useLiveVersion() {
  return useSyncExternalStore(subscribe, () => version);
}

export function liveTradesOf(poolId) {
  return pools.get(lc(poolId)) || [];
}

/** Every live trade, newest last (for the dashboard ticker). */
export function allLiveTrades() {
  return [...pools.values()].flat().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// ─────────────────────────────── React hooks ───────────────────────────────

/** A token with the live swaps after `indexedBlock` applied. */
export function useLiveToken(token, indexedBlock) {
  useLiveVersion();
  if (!token?.poolId) return token;
  return liveToken(token, freshTrades(liveTradesOf(token.poolId), indexedBlock));
}

export function useLiveTokens(tokens, indexedBlock) {
  useLiveVersion();
  return (tokens || []).map((t) => (t?.poolId ? liveToken(t, freshTrades(liveTradesOf(t.poolId), indexedBlock)) : t));
}

export function useLiveTrades(trades, indexedBlock, poolId, limit = 50) {
  useLiveVersion();
  const fresh = freshTrades(poolId ? liveTradesOf(poolId) : allLiveTrades(), indexedBlock);
  return liveTradeList(trades, fresh, limit);
}

export function useLiveCandles(candles, indexedBlock, poolId, interval) {
  useLiveVersion();
  return liveCandles(candles, freshTrades(liveTradesOf(poolId), indexedBlock), interval);
}

// ─────────────────────────────── the subscription ───────────────────────────────

let users = 0;
let manager = null;

/** Starts the live subscription while a launchpad page is open (one for the whole app). */
export function useLaunchLive() {
  const queryClient = useQueryClient();
  useEffect(() => {
    users += 1;
    if (!manager) manager = startManager(queryClient);
    return () => {
      users -= 1;
      if (users === 0 && manager) {
        manager.stop();
        manager = null;
      }
    };
  }, [queryClient]);
}

/** Every launch token the query cache holds, by pool id, with what tradeFromLog needs. */
function knownPools(queryClient) {
  const found = new Map();
  const add = (t) => {
    if (!t?.poolId || !t.quote) return;
    found.set(lc(t.poolId), {
      token: t.address,
      quote: t.quote.address,
      quoteDecimals: t.quote.decimals,
      quoteSymbol: t.quote.symbol,
      usd: t.quote.usd,
      name: t.name,
      symbol: t.symbol,
      contractURI: t.contractURI,
    });
  };
  for (const q of queryClient.getQueryCache().getAll()) {
    const [p, , area, kind] = q.queryKey;
    const data = q.state.data;
    if (p !== 'place' || area !== 'launch' || !data) continue;
    if (kind === 'tokens') (data.tokens || []).forEach(add);
    else if (kind === 'token') add(data.token);
    else if (kind === 'creator') (data.tokens || []).forEach((x) => add(x.token));
  }
  return found;
}

function startManager(queryClient) {
  const d = launchDeployment(PLACE_CHAIN_ID);
  if (!d || typeof window === 'undefined') return { stop() {} };
  let info = new Map();
  let unwatchSwaps = null;
  let unwatchLaunches = null;
  let client = null;
  let timer = null;
  let stopped = false;
  let usePolling = false;

  const makeClient = () =>
    usePolling
      ? createPublicClient({ chain: PLACE_CHAIN, transport: http(undefined), pollingInterval: 2_000 })
      : createPublicClient({ chain: PLACE_CHAIN, transport: webSocket(WSS[PLACE_CHAIN_ID], { retryCount: 5, keepAlive: true, reconnect: true }) });

  const onError = () => {
    // WebSocket refused or dropped for good: fall back to polling every 2 s over HTTP.
    if (usePolling || stopped) return;
    usePolling = true;
    client = null;
    resubscribe(true);
  };

  const traders = new Map();
  const fillTrader = (t) => {
    if (traders.has(t.tx)) return;
    traders.set(t.tx, null);
    placeClient()
      .getTransaction({ hash: t.tx })
      .then((tx) => {
        traders.set(t.tx, lc(tx.from));
        const list = pools.get(t.poolId);
        if (!list) return;
        pools.set(
          t.poolId,
          list.map((x) => (x.tx === t.tx ? { ...x, trader: lc(tx.from) } : x))
        );
        emit();
      })
      .catch(() => {});
  };

  const resubscribe = (force = false) => {
    if (stopped) return;
    const next = knownPools(queryClient);
    const same = next.size === info.size && [...next.keys()].every((k) => info.has(k));
    info = next;
    if (same && !force && unwatchSwaps) return;
    unwatchSwaps?.();
    unwatchSwaps = null;
    if (!client) client = makeClient();
    if (!unwatchLaunches) {
      unwatchLaunches = client.watchEvent({
        address: d.factory,
        event: LAUNCHED,
        onLogs: () => {
          // A new launch: the feed, the stats and the creator's list change.
          setTimeout(() => queryClient.invalidateQueries({ queryKey: ['place', PLACE_CHAIN_ID, 'launch'] }), 1500);
        },
        onError,
      });
    }
    if (!info.size) return;
    unwatchSwaps = client.watchEvent({
      address: d.poolManager,
      event: SWAP,
      args: { id: [...info.keys()] },
      onLogs: (logs) => {
        for (const log of logs) {
          const i = info.get(lc(log.args.id));
          if (!i) continue;
          const t = tradeFromLog(log, i);
          addLiveTrade(t);
          fillTrader(t);
        }
      },
      onError,
    });
  };

  const unsubscribeCache = queryClient.getQueryCache().subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => resubscribe(), 400);
  });
  resubscribe();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      unsubscribeCache();
      unwatchSwaps?.();
      unwatchLaunches?.();
    },
  };
}
