// Launch pairs: which pair assets count as crypto and which as tokenized stocks. Shared by
// the API (the category filter of the feed) and the site (the All / Crypto / Stocks tabs and the pair picker).
//
// The factory's quote registry holds both: ETH, USDC and the Coinbase-wrapped majors are crypto; everything
// else on the launch list is a Coinbase stock token (B20), so "not crypto" means "stocks".
export const CRYPTO_SYMBOLS = ['ETH', 'WETH', 'USDC', 'EURC', 'cbBTC', 'cbETH', 'cbDOGE', 'cbXRP', 'cbLTC', 'cbADA', 'cbZEC', 'cbHYPE'];

const CRYPTO = new Set(CRYPTO_SYMBOLS.map((s) => s.toLowerCase()));

/** 'crypto' or 'stocks' for a pair asset, by its symbol (ETH is the zero address, symbol 'ETH'). */
export function pairCategory(symbol) {
  if (!symbol) return 'crypto';
  return CRYPTO.has(String(symbol).toLowerCase()) ? 'crypto' : 'stocks';
}

export const PAIR_CATEGORIES = ['crypto', 'stocks'];

// Icons for pair assets: the main crypto by ticker, tokenized stocks from the Coinbase Tokenized Stocks API (it
// redirects to the current icon of the ticker). Anything else shows its initials.
const CRYPTO_ICONS = {
  eth: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  weth: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  usdc: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  cbbtc: 'https://assets.coingecko.com/coins/images/40143/small/cbbtc.webp',
};

/** The icon URL of a pair asset, or null. */
export function pairIcon(pair) {
  const symbol = String(pair?.symbol || '');
  if (CRYPTO_ICONS[symbol.toLowerCase()]) return CRYPTO_ICONS[symbol.toLowerCase()];
  if (pairCategory(symbol) === 'stocks' && /^[A-Za-z0-9.]+c$/.test(symbol)) {
    return `https://api.coinbase.com/v1/tokenized-stocks/images/${encodeURIComponent(symbol)}`;
  }
  return null;
}
