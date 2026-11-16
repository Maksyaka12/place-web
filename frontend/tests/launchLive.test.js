// Live swaps on top of API data (src/launch/live.js): decode a Swap log, apply only swaps after the API's
// indexed block, never count one twice, fold them into candles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeFromLog, freshTrades, liveToken, liveTradeList, liveCandles } from '../src/launch/live.js';

const TOKEN = '0xb200000000000000000000edee389ab594913e01';
const POOL = '0x' + 'ab'.repeat(32);
const info = { token: TOKEN, quote: 'eth', quoteDecimals: 18, quoteSymbol: 'ETH', usd: 2000, symbol: 'PL2B', name: 'Place' };
const Q96 = 2n ** 96n;

// ETH (0x0) is currency0, the token currency1. Buying: the swapper pays ETH (amount0 < 0), gets tokens (amount1 > 0).
const log = ({ block, logIndex = 0, eth, tokens, sqrt }) => ({
  args: { id: POOL, amount0: -eth, amount1: tokens, sqrtPriceX96: sqrt },
  blockNumber: BigInt(block),
  logIndex,
  transactionHash: `0x${String(block).padStart(64, '0')}`,
});

const api = {
  address: TOKEN,
  poolId: POOL,
  quote: { address: 'eth', decimals: 18, usd: 2000, symbol: 'ETH' },
  price: 2e-9,
  priceUsd: 4e-6,
  change24h: 0,
  supply: 1e9,
  burned: 0,
  liquidity: { quote: 0.001, token: 999e6, value: 2.999, valueUsd: 5998 },
  volume24h: 0.01,
  volume1h: 0,
  volumeAll: 0.05,
  trades24h: 4,
  trades: 20,
};

test('a Swap log becomes a trade with side, amounts and the pool price', () => {
  // token1 per token0 = 1 / price → sqrtPriceX96 = sqrt(1 / 2.5e-9) · 2^96
  const sqrt = BigInt(Math.round(Math.sqrt(1 / 2.5e-9) * 2 ** 32)) * 2n ** 64n;
  const t = tradeFromLog(log({ block: 100, logIndex: 3, eth: 10n ** 15n, tokens: 4n * 10n ** 23n, sqrt }), info, Date.parse('2026-11-14T12:00:00Z'));
  assert.equal(t.side, 'buy');
  assert.equal(t.quote, 0.001);
  assert.ok(Math.abs(t.tokens - 400000) < 1e-6);
  assert.ok(Math.abs(t.price - 2.5e-9) / 2.5e-9 < 1e-6);
  assert.equal(t.cursor, '100:3');
  assert.equal(t.valueUsd, 2);
  assert.ok(Q96 > 0n);
});

test('only swaps after the indexed block apply, and each once', () => {
  const trades = [
    { block: 99, logIndex: 0, cursor: '99:0', price: 2.1e-9, quote: 0.001, quoteIn: 0.001, tokenOut: 4e5, side: 'buy', at: '2026-11-14T12:00:00Z' },
    { block: 101, logIndex: 1, cursor: '101:1', price: 2.4e-9, quote: 0.002, quoteIn: 0.002, tokenOut: 8e5, side: 'buy', at: '2026-11-14T12:00:01Z' },
  ];
  const fresh = freshTrades(trades, 100);
  assert.deepEqual(fresh.map((t) => t.cursor), ['101:1']);
  assert.deepEqual(freshTrades(trades, null), [], 'without indexedBlock nothing is guessed');

  const t = liveToken(api, fresh);
  assert.equal(t.price, 2.4e-9);
  assert.ok(Math.abs(t.priceUsd - 4.8e-6) < 1e-15);
  assert.ok(Math.abs(t.marketCapUsd - 4800) < 1e-6);
  assert.ok(Math.abs(t.change24h - 20) < 1e-9, 'change from the reference price the API used');
  assert.ok(Math.abs(t.volume24h - 0.012) < 1e-12);
  assert.ok(Math.abs(t.volumeAll - 0.052) < 1e-12);
  assert.equal(t.trades24h, 5);
  assert.ok(Math.abs(t.liquidity.quote - 0.003) < 1e-12);
  assert.equal(t.liquidity.token, 999e6 - 8e5);
  assert.deepEqual(t.liveTick, { cursor: '101:1', side: 'buy' });
  assert.equal(liveToken(api, []), api, 'no fresh swaps: the API object as is');

  const list = liveTradeList([{ cursor: '101:1' }, { cursor: '90:0' }], fresh);
  assert.deepEqual(list.map((x) => x.cursor), ['101:1', '90:0'], 'a swap the API already has is not added again');
  assert.deepEqual(liveTradeList([{ cursor: '90:0' }], fresh).map((x) => x.cursor), ['101:1', '90:0']);
});

test('candles: a swap updates its bucket, a later one opens a new bucket and fills the gap flat', () => {
  const t0 = Date.parse('2026-11-14T12:00:00Z') / 1000;
  const candles = [{ t: t0, o: 1, h: 1, l: 1, c: 1, v: 0.1, trades: 1 }];
  const fresh = [
    { price: 1.2, quote: 0.01, at: new Date((t0 + 30) * 1000).toISOString() },
    { price: 0.9, quote: 0.02, at: new Date((t0 + 1000) * 1000).toISOString() },
  ];
  const out = liveCandles(candles, fresh, '5m');
  assert.deepEqual(out[0], { t: t0, o: 1, h: 1.2, l: 1, c: 1.2, v: 0.11, trades: 2 });
  assert.equal(out.length, 4, 'two flat buckets in between, then the new one');
  assert.deepEqual(out[1], { t: t0 + 300, o: 1.2, h: 1.2, l: 1.2, c: 1.2, v: 0, trades: 0 });
  assert.deepEqual(out[3], { t: t0 + 900, o: 1.2, h: 1.2, l: 0.9, c: 0.9, v: 0.02, trades: 1 });
  assert.equal(candles[0].c, 1, 'the API candles are not mutated');
});
