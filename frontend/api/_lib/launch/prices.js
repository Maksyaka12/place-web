// USD prices of launch pairs, for market caps and the "trending by volume" sort across pairs.
// Source: Coinbase's public spot price (no key), cached in quote_prices for a minute; on failure the last
// cached value is used. Testnet pairs are priced as their mainnet asset (Sepolia ETH as ETH).
// Mainnet: the priceUpdater bot's Chainlink reads should feed this table instead.
const ETH = '0x0000000000000000000000000000000000000000';
const TTL_MS = 60_000;
const STABLE = new Set(['USDC', 'USDBC', 'USDT', 'DAI']);

/** The Coinbase ticker for a pair asset, '1' for USD stables, or null when Place has no price for it. */
export function priceSymbol(quote, symbol) {
  if (quote === ETH) return 'ETH';
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  if (STABLE.has(s)) return '1';
  if (s === 'WETH') return 'ETH';
  if (s.startsWith('CB') && s.length > 2) return s.slice(2); // cbBTC → BTC, cbDOGE → DOGE
  return null; // tokenized stocks and others: no USD price yet
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
  await Promise.all(
    stale.map(async (s) => {
      try {
        const res = await (deps.fetchFn || fetch)(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, { signal: AbortSignal.timeout(4000) });
        const body = await res.json();
        const usd = Number(body?.data?.amount);
        if (!res.ok || !Number.isFinite(usd) || usd <= 0) return;
        await deps.db.query(
          `insert into quote_prices (symbol, usd, updated_at) values ($1, $2, now())
           on conflict (symbol) do update set usd = excluded.usd, updated_at = excluded.updated_at`,
          [s, usd]
        );
        cached.set(s, { symbol: s, usd, updated_at: new Date() });
      } catch {
        // keep the cached value, if any
      }
    })
  );
  for (const [quote, s] of wanted) out.set(quote, cached.has(s) ? Number(cached.get(s).usd) : null);
  return out;
}
