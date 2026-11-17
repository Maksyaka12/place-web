// The Stocks page: every Coinbase tokenized stock on Base, with its price, its onchain liquidity (the value of the
// tokenized supply), whether it is launch ready, and how many Place launches pair with it.
//
//   GET launch/stocks   ?chain   stocks, totals and categories
//
// A stock is launch ready on the same terms the pair list is built on: it has supply, nothing paused, a price,
// and at least $10k of supply in circulation. Prices: the Chainlink NAV from the Coinbase API while it is fresh,
// else the token's DEX price (GeckoTerminal); a stale NAV is still shown as the last price but never makes a
// stock launch ready.
import { launchDeployment } from '../../../src/launch/deployments.js';
import { pairCategory } from '../../../src/launch/pairs.js';
import { STOCK_CATEGORIES, stockCategory, stockTicker } from '../../../src/launch/stockCategories.js';
import { reply, fail, chainOf } from '../place/http.js';
import { navPrice } from './prices.js';

const STOCKS_API = 'https://api.coinbase.com/v1/tokenized-stocks';
const GECKO = 'https://api.geckoterminal.com/api/v2/simple/networks/base/token_price';
export const MIN_LIQUIDITY_USD = 10_000;
const TTL_MS = 5 * 60_000;

let cache = null; // { at, stocks }

async function fetchJson(fetchFn, url) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every tokenized stock with a price, cached for a few minutes. */
async function loadStocks(fetchFn, now) {
  if (cache && now - cache.at < TTL_MS) return cache.stocks;
  const tokens = [];
  let page = '';
  do {
    const body = await fetchJson(fetchFn, `${STOCKS_API}?page_size=500${page ? `&page_token=${encodeURIComponent(page)}` : ''}`);
    tokens.push(...(body.tokens || []));
    page = body.next_page_token || '';
  } while (page);

  const fresh = new Map();
  for (const t of tokens) {
    const usd = navPrice(t, now);
    if (usd) fresh.set(String(t.contract_address).toLowerCase(), usd);
  }
  // Stocks with supply but no fresh NAV: the DEX price, 30 addresses per request.
  const left = tokens.filter((t) => Number(t.total_supply) > 0 && !fresh.has(String(t.contract_address).toLowerCase())).map((t) => String(t.contract_address).toLowerCase());
  const dex = new Map();
  for (let i = 0; i < left.length; i += 30) {
    try {
      const body = await fetchJson(fetchFn, `${GECKO}/${left.slice(i, i + 30).join(',')}`);
      for (const [a, v] of Object.entries(body?.data?.attributes?.token_prices || {})) if (Number(v) > 0) dex.set(a.toLowerCase(), Number(v));
    } catch {
      // keep what we have
    }
  }

  const stocks = tokens.map((t) => {
    const address = String(t.contract_address).toLowerCase();
    const live = fresh.get(address) ?? dex.get(address) ?? null;
    const supply = Number(t.total_supply) || 0;
    const liquidityUsd = live == null ? 0 : supply * live;
    const paused = Boolean(t.paused_features?.length);
    return {
      address,
      symbol: t.symbol,
      ticker: stockTicker(t.symbol),
      name: String(t.name || '').replace(/\s*\(Coinbase Tokenized Stock\)\s*$/i, ''),
      icon: t.icon_url || null,
      category: stockCategory(t.symbol),
      priceUsd: live ?? (t.nav_price > 0 ? Number(t.nav_price) : null),
      priceSource: fresh.has(address) ? 'nav' : dex.has(address) ? 'dex' : t.nav_price > 0 ? 'last-nav' : null,
      supply,
      liquidityUsd,
      paused,
      launchReady: supply > 0 && !paused && live != null && liquidityUsd >= MIN_LIQUIDITY_USD,
      firstMint: t.first_mint_date || null,
    };
  });
  cache = { at: now, stocks };
  return stocks;
}

async function getStocks({ query: q }, deps) {
  const chainId = chainOf(q);
  if (!launchDeployment(chainId)) fail(`Place Launch is not deployed on chain ${chainId}`);
  const now = deps.now() * 1000;
  let stocks;
  try {
    stocks = await loadStocks(deps.fetchFn || fetch, now);
  } catch (e) {
    fail(`Tokenized stocks are unavailable right now (${e.message})`, 502);
  }

  // Pairs registered on this chain and how many launches each one has.
  const rows = await deps.db.query(
    `select q.quote, q.registered, m.symbol,
            (select count(*)::int from launch_tokens t where t.chain_id = q.chain_id and t.quote = q.quote) as launches
     from launch_quotes q left join token_meta m on m.chain_id = q.chain_id and m.address = q.quote
     where q.chain_id = $1`,
    [chainId]
  );
  const pairs = new Map(rows.map((r) => [r.quote, r]));
  const pairedTokens = rows.filter((r) => pairCategory(r.symbol) === 'stocks').reduce((n, r) => n + r.launches, 0);

  const list = stocks
    .map((s) => {
      const p = pairs.get(s.address);
      return { ...s, pair: Boolean(p?.registered), launches: p?.launches ?? 0 };
    })
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd || String(a.ticker).localeCompare(String(b.ticker)));

  const categories = STOCK_CATEGORIES.map((c) => {
    const members = list.filter((s) => s.category === c.id);
    return { id: c.id, label: c.label, count: members.length, icons: members.slice(0, 3).map((s) => ({ ticker: s.ticker, icon: s.icon })) };
  }).filter((c) => c.count > 0);

  return reply(
    200,
    {
      chainId,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      totals: {
        listed: list.length,
        launchReady: list.filter((s) => s.launchReady).length,
        liquid: list.filter((s) => s.liquidityUsd >= MIN_LIQUIDITY_USD).length,
        noSupply: list.filter((s) => !(s.supply > 0)).length,
        onchainLiquidityUsd: list.reduce((n, s) => n + s.liquidityUsd, 0),
        pairedTokens,
        pairs: list.filter((s) => s.pair).length,
      },
      categories,
      stocks: list,
    },
    'public, max-age=120'
  );
}

export const STOCKS_ROUTES = { 'GET launch/stocks': getStocks };
