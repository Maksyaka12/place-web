// USD prices of launch pairs, for market caps and the "trending by volume" sort across pairs.
// Cached in quote_prices for a minute; on failure the last cached value is used. Testnet pairs are priced as their
// mainnet asset (Sepolia ETH as ETH).
// - Crypto: Coinbase's public spot price (no key).
// - Tokenized stocks (B20 `0xb2…` with a `…c` ticker): the Chainlink NAV from the Coinbase Tokenized Stocks API
//   while it is fresh, else the token's DEX price from GeckoTerminal. Both are the price of one token, multiplier
//   included. Never the Coinbase spot ticker: there `AMD` is a crypto asset, not the stock.
const ETH = '0x0000000000000000000000000000000000000000';
const TTL_MS = 60_000;
const STABLE = new Set(['USDC', 'USDBC', 'USDT', 'DAI']);
const STOCKS_API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';
const GECKO = 'https://api.geckoterminal.com/api/v2/simple/networks/base/token_price';
export const NAV_MAX_AGE_MS = 96 * 3_600_000; // covers a weekend: the feed holds the last close

const isStock = (quote, symbol) => /^0xb2/i.test(quote) && /c$/.test(String(symbol || '')) && !/^cb/i.test(String(symbol || ''));

/**
 * What prices a pair asset: a Coinbase ticker, '1' for USD stables, `stock:<address>` for a tokenized stock, or
 * null when Place has no price for it.
 */
export function priceSymbol(quote, symbol) {
  if (quote === ETH) return 'ETH';
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  if (STABLE.has(s)) return '1';
  if (s === 'WETH') return 'ETH';
  if (s.startsWith('CB') && s.length > 2) return s.slice(2); // cbBTC → BTC, cbDOGE → DOGE
  if (isStock(quote, symbol)) return `stock:${String(quote).toLowerCase()}`;
  return null;
}

/** The USD price of a tokenized-stock record from the Coinbase API: its NAV while fresh, else null. */
export function navPrice(t, now = Date.now()) {
  const at = Date.parse(t?.nav_price_updated_at || '');
  return t?.nav_price > 0 && Number.isFinite(at) && now - at <= NAV_MAX_AGE_MS ? Number(t.nav_price) : null;
}

/** USD prices for tokenized stocks by address: Map(address → usd). Missing = no price. */
async function stockPrices(fetchFn, addresses) {
  const out = new Map();
  try {
    const body = await (await fetchFn(STOCKS_API, { signal: AbortSignal.timeout(6000) })).json();
    for (const t of body?.tokens || []) {
      const a = String(t.contract_address || '').toLowerCase();
      const usd = navPrice(t);
      if (addresses.includes(a) && usd) out.set(a, usd);
    }
  } catch {
    // fall through to the DEX price
  }
  const left = addresses.filter((a) => !out.has(a));
  for (let i = 0; i < left.length; i += 30) {
    try {
      const chunk = left.slice(i, i + 30);
      const body = await (await fetchFn(`${GECKO}/${chunk.join(',')}`, { signal: AbortSignal.timeout(6000) })).json();
      for (const [a, v] of Object.entries(body?.data?.attributes?.token_prices || {})) if (Number(v) > 0) out.set(a.toLowerCase(), Number(v));
    } catch {
      // keep what we have
    }
  }
  return out;
}

async function cryptoPrice(fetchFn, ticker) {
  try {
    const res = await fetchFn(`https://api.coinbase.com/v2/prices/${ticker}-USD/spot`, { signal: AbortSignal.timeout(4000) });
    const usd = Number((await res.json())?.data?.amount);
    return res.ok && Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

/**
 * USD price per whole unit for each pair asset. `pairs`: [{quote, symbol}]. Returns Map(quote → number|null).
 * deps: { db, fetchFn }.
 */
export async function quoteUsd(deps, pairs) {
  const out = new Map();
  const wanted = new Map();
  for (const p of pairs) {
    const sym = priceSymbol(p.quote, p.symbol);
    if (sym === '1') out.set(p.quote, 1);
    else if (sym) wanted.set(p.quote, sym);
    else out.set(p.quote, null);
  }
  const symbols = [...new Set(wanted.values())];
  if (!symbols.length) return out;
  const cached = new Map(
    (await deps.db.query('select symbol, usd, updated_at from quote_prices where symbol = any($1::text[])', [symbols])).map((r) => [r.symbol, r])
  );
  const stale = symbols.filter((s) => !cached.has(s) || Date.now() - new Date(cached.get(s).updated_at).getTime() > TTL_MS);
  const fetchFn = deps.fetchFn || fetch;

  const fresh = new Map();
  const staleStocks = stale.filter((s) => s.startsWith('stock:'));
  if (staleStocks.length) {
    const prices = await stockPrices(fetchFn, staleStocks.map((s) => s.slice(6)));
    for (const [a, usd] of prices) fresh.set(`stock:${a}`, usd);
  }
  await Promise.all(
    stale.filter((s) => !s.startsWith('stock:')).map(async (s) => {
      const usd = await cryptoPrice(fetchFn, s);
      if (usd) fresh.set(s, usd);
    })
  );
  for (const [s, usd] of fresh) {
    await deps.db.query(
      `insert into quote_prices (symbol, usd, updated_at) values ($1, $2, now())
       on conflict (symbol) do update set usd = excluded.usd, updated_at = excluded.updated_at`,
      [s, usd]
    );
    cached.set(s, { symbol: s, usd, updated_at: new Date() });
  }
  for (const [quote, s] of wanted) out.set(quote, cached.has(s) ? Number(cached.get(s).usd) : null);
  return out;
}
