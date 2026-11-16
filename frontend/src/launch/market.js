// Market math for launch pools (Uniswap v4, one locked position held by the hook). Pure functions shared by
// the indexer, the API and the site.
//
// Swap amounts are from the swapper's side, as PoolManager's Swap event reports them: negative = paid in,
// positive = received. Fees never touch the pool (the hook takes them in the quote), so the pool's quote
// reserve is exactly the net quote that swaps put in, and its token reserve is the seed minus net tokens out.
export const Q96 = 2n ** 96n;
export const CANDLE_INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

/**
 * Price of one whole launch token in whole quote units, from the pool's sqrtPriceX96.
 * Launch tokens always have 18 decimals.
 */
export function priceFromSqrt(sqrtPriceX96, tokenIsCurrency0, quoteDecimals, tokenDecimals = 18) {
  const s = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
  const raw1per0 = s * s; // currency1 raw units per currency0 raw unit
  if (raw1per0 === 0) return 0;
  const scale = 10 ** (tokenDecimals - Number(quoteDecimals));
  return tokenIsCurrency0 ? raw1per0 * scale : scale / raw1per0;
}

/** One decoded Swap → what the trader did. */
export function swapSide({ amount0, amount1 }, tokenIsCurrency0) {
  const tokenDelta = BigInt(tokenIsCurrency0 ? amount0 : amount1);
  const quoteDelta = BigInt(tokenIsCurrency0 ? amount1 : amount0);
  const abs = (v) => (v < 0n ? -v : v);
  return {
    side: tokenDelta > 0n ? 'buy' : 'sell',
    tokenAmount: abs(tokenDelta),
    quoteAmount: abs(quoteDelta),
    // change of the pool's reserves
    quoteIn: -quoteDelta,
    tokenOut: tokenDelta,
  };
}

/** Whole-unit number from a raw integer amount (for display and USD math only). */
export function units(raw, decimals) {
  if (raw == null) return null;
  return Number(BigInt(raw)) / 10 ** Number(decimals);
}

/**
 * Fills a sparse list of candles ({t, o, h, l, c, v, trades}, t in unix seconds, ascending) so every bucket
 * between `from` and `to` exists: an empty bucket is flat at the previous close with zero volume.
 * `prevClose` seeds buckets before the first trade in range.
 */
export function fillCandles(rows, { interval, from, to, prevClose = null }) {
  const byT = new Map(rows.map((r) => [Number(r.t), r]));
  const out = [];
  let last = prevClose;
  const start = Math.floor(from / interval) * interval;
  for (let t = start; t <= to; t += interval) {
    const r = byT.get(t);
    if (r) {
      out.push({ t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, trades: r.trades });
      last = r.c;
    } else if (last != null) {
      out.push({ t, o: last, h: last, l: last, c: last, v: 0, trades: 0 });
    }
  }
  return out;
}

/** Percent change from `before` to `after`, or null when there is no reference price. */
export function change(before, after) {
  if (!before || after == null) return null;
  return ((after - before) / before) * 100;
}
