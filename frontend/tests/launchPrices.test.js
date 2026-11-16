// USD prices of launch pairs: crypto from Coinbase spot, tokenized stocks from their NAV or DEX price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceSymbol, navPrice, quoteUsd, NAV_MAX_AGE_MS } from '../api/_lib/launch/prices.js';
import { pairIcon } from '../src/launch/pairs.js';

const ETH = '0x0000000000000000000000000000000000000000';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const AMD = '0xb2000000000000000000000d8ce462e99ee7a47b';
const ZEC = '0xb2000000000000000000008501b13360000cb2ec';

// quote_prices in memory
function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params) {
      if (sql.startsWith('select')) return params[0].filter((s) => rows.has(s)).map((s) => rows.get(s));
      rows.set(params[0], { symbol: params[0], usd: params[1], updated_at: new Date() });
      return [];
    },
  };
}

test('what prices each pair asset', () => {
  assert.equal(priceSymbol(ETH, 'ETH'), 'ETH');
  assert.equal(priceSymbol('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'), '1');
  assert.equal(priceSymbol('0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC'), 'BTC');
  assert.equal(priceSymbol(ZEC, 'cbZEC'), 'ZEC', 'Coinbase-wrapped crypto in B20 stays crypto');
  assert.equal(priceSymbol(NVDA, 'NVDAc'), `stock:${NVDA}`);
  assert.equal(priceSymbol('0x1111111111111111111111111111111111111111', 'NVDAc'), null, 'only B20 addresses are stocks');
  assert.equal(priceSymbol('0x1111111111111111111111111111111111111111', 'PEPE'), null);
});

test('a NAV counts only while it is fresh', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(navPrice({ nav_price: 159.1, nav_price_updated_at: '2026-11-16T10:00:00Z' }, now), 159.1);
  assert.equal(navPrice({ nav_price: 159.1, nav_price_updated_at: new Date(now - NAV_MAX_AGE_MS - 1).toISOString() }, now), null);
  assert.equal(navPrice({ nav_price: 159.1 }, now), null, 'no timestamp is not a fresh price');
  assert.equal(navPrice({}, now), null);
});

test('stocks: NAV first, DEX price for the rest, never the Coinbase spot ticker', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('tokenized-stocks')) {
      return { ok: true, json: async () => ({ tokens: [
        { contract_address: '0xB20000000000000000000078ee7ce2fE4908108C', nav_price: 159.13, nav_price_updated_at: new Date().toISOString() },
        { contract_address: AMD, symbol: 'AMDc' },
      ] }) };
    }
    if (String(url).includes('geckoterminal')) return { ok: true, json: async () => ({ data: { attributes: { token_prices: { [AMD]: '241.5' } } } }) };
    return { ok: true, json: async () => ({ data: { amount: '2000' } }) };
  };
  const db = memoryDb();
  const out = await quoteUsd({ db, fetchFn }, [
    { quote: NVDA, symbol: 'NVDAc' },
    { quote: AMD, symbol: 'AMDc' },
    { quote: ETH, symbol: 'ETH' },
  ]);
  assert.equal(out.get(NVDA), 159.13);
  assert.equal(out.get(AMD), 241.5);
  assert.equal(out.get(ETH), 2000);
  assert.ok(!urls.some((u) => /prices\/(AMD|NVDA)-USD/.test(u)), 'stocks never use the spot ticker');
  assert.ok(urls.find((u) => u.includes('geckoterminal')).includes(AMD) && !urls.find((u) => u.includes('geckoterminal')).includes(NVDA), 'only stocks without a NAV go to the DEX');

  // a second read within a minute comes from the cache
  urls.length = 0;
  await quoteUsd({ db, fetchFn }, [{ quote: NVDA, symbol: 'NVDAc' }]);
  assert.equal(urls.length, 0);
});

test('when every source fails, the last cached price stays', async () => {
  const db = memoryDb();
  db.rows.set(`stock:${NVDA}`, { symbol: `stock:${NVDA}`, usd: 150, updated_at: new Date(Date.now() - 3_600_000) });
  const out = await quoteUsd({ db, fetchFn: async () => { throw new Error('offline'); } }, [{ quote: NVDA, symbol: 'NVDAc' }, { quote: AMD, symbol: 'AMDc' }]);
  assert.equal(out.get(NVDA), 150);
  assert.equal(out.get(AMD), null);
});

test('pair icons: main crypto by ticker, stocks from the Coinbase API, others none', () => {
  assert.match(pairIcon({ symbol: 'ETH' }), /ethereum/);
  assert.match(pairIcon({ symbol: 'USDC' }), /usdc/);
  assert.equal(pairIcon({ symbol: 'NVDAc' }), 'https://api.coinbase.com/v1/tokenized-stocks/images/NVDAc');
  assert.equal(pairIcon({ symbol: 'BRK.Bc' }), 'https://api.coinbase.com/v1/tokenized-stocks/images/BRK.Bc');
  assert.equal(pairIcon({ symbol: 'cbDOGE' }), null);
  assert.equal(pairIcon({}), null);
});
