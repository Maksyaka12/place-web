// The Stocks page API: prices, onchain liquidity, launch readiness, categories and pair counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlace } from '../api/_lib/place/api.js';
import { stockCategory, stockTicker, STOCK_CATEGORIES } from '../src/launch/stockCategories.js';
import { freshDb, CHAIN } from './launchFixture.js';

const NOW = 1_794_844_800; // seconds
const iso = (s) => new Date(s * 1000).toISOString();
const NVDA = '0xb2000000000000000000000000000000000000a1';
const AAPL = '0xb2000000000000000000000000000000000000a2';
const RKT = '0xb2000000000000000000000000000000000000a3';
const TSLA = '0xb2000000000000000000000000000000000000a4';

const STOCKS = [
  // fresh NAV, $1.6M of supply: launch ready
  { contract_address: NVDA, symbol: 'NVDAc', name: 'NVIDIA Corporation (Coinbase Tokenized Stock)', icon_url: 'https://x/nvda.png', total_supply: 10_000, nav_price: 160, nav_price_updated_at: iso(NOW - 3600) },
  // stale NAV, priced on the DEX at $200 × 40 = $8k: under the $10k bar
  { contract_address: AAPL, symbol: 'AAPLc', name: 'Apple Inc.', total_supply: 40, nav_price: 190, nav_price_updated_at: iso(NOW - 30 * 86400) },
  // no supply: last NAV shown as the price, never ready
  { contract_address: RKT, symbol: 'RKTc', name: 'Rocket Companies, Inc.', total_supply: 0, nav_price: 17, nav_price_updated_at: iso(NOW - 30 * 86400) },
  // paused: not ready even with supply and a price
  { contract_address: TSLA, symbol: 'TSLAc', name: 'Tesla, Inc.', total_supply: 1000, nav_price: 380, nav_price_updated_at: iso(NOW - 60), paused_features: ['transfer'] },
];

test('stock categories: every ticker sits in one category', () => {
  const seen = new Map();
  for (const c of STOCK_CATEGORIES) for (const t of c.tickers) {
    assert.ok(!seen.has(t), `${t} is in ${seen.get(t)} and ${c.id}`);
    seen.set(t, c.id);
  }
  assert.equal(stockTicker('BRK.Bc'), 'BRK.B');
  assert.equal(stockCategory('NVDAc'), 'big-tech');
  assert.equal(stockCategory('NOPEc'), null);
});

test('launch/stocks: liquidity, readiness, totals and categories', async () => {
  const db = await freshDb();
  const calls = [];
  const deps = {
    db,
    now: () => NOW,
    fetchFn: async (url) => {
      calls.push(url);
      if (url.startsWith('https://api.coinbase.com/v1/tokenized-stocks')) return { ok: true, json: async () => ({ tokens: STOCKS }) };
      if (url.includes('geckoterminal')) return { ok: true, json: async () => ({ data: { attributes: { token_prices: { [AAPL]: '200' } } } }) };
      throw new Error(`unexpected ${url}`);
    },
  };
  const r = await handlePlace({ method: 'GET', path: 'launch/stocks', query: { chain: String(CHAIN) } }, deps);
  assert.equal(r.status, 200);
  const by = new Map(r.body.stocks.map((s) => [s.ticker, s]));

  assert.equal(by.get('NVDA').liquidityUsd, 1_600_000);
  assert.equal(by.get('NVDA').launchReady, true);
  assert.equal(by.get('NVDA').name, 'NVIDIA Corporation', 'the Coinbase suffix is dropped');
  assert.equal(by.get('NVDA').category, 'big-tech');
  assert.equal(by.get('AAPL').priceUsd, 200);
  assert.equal(by.get('AAPL').priceSource, 'dex');
  assert.equal(by.get('AAPL').launchReady, false);
  assert.equal(by.get('RKT').priceUsd, 17);
  assert.equal(by.get('RKT').priceSource, 'last-nav');
  assert.equal(by.get('RKT').liquidityUsd, 0);
  assert.equal(by.get('TSLA').launchReady, false, 'paused stocks are not launch ready');
  assert.deepEqual(r.body.stocks.map((s) => s.ticker), ['NVDA', 'TSLA', 'AAPL', 'RKT'], 'most liquid first');

  assert.deepEqual(r.body.totals, { listed: 4, launchReady: 1, liquid: 2, noSupply: 1, onchainLiquidityUsd: 1_600_000 + 380_000 + 8000, pairedTokens: 0, pairs: 0 });
  assert.ok(r.body.categories.every((c) => c.count > 0));
  assert.equal(calls.filter((u) => u.includes('geckoterminal')).length, 1, 'one DEX request for the stocks with supply and no fresh NAV');
});
