// Launch pairs: which pair assets count as crypto and which as tokenized stocks. Shared by
// the API (the category filter of the feed) and the site (the All / Crypto / Stocks tabs and the pair picker).
//
// The factory's quote registry holds both: ETH, USDC and the Coinbase-wrapped majors are crypto; everything
// else on the launch list is one of the 288 Coinbase stock tokens (B20), so "not crypto" means "stocks".
export const CRYPTO_SYMBOLS = ['ETH', 'WETH', 'USDC', 'EURC', 'cbBTC', 'cbETH', 'cbDOGE', 'cbXRP', 'cbLTC', 'cbADA', 'cbZEC', 'cbHYPE'];

const CRYPTO = new Set(CRYPTO_SYMBOLS.map((s) => s.toLowerCase()));

/** 'crypto' or 'stocks' for a pair asset, by its symbol (ETH is the zero address, symbol 'ETH'). */
export function pairCategory(symbol) {
  if (!symbol) return 'crypto';
  return CRYPTO.has(String(symbol).toLowerCase()) ? 'crypto' : 'stocks';
}

export const PAIR_CATEGORIES = ['crypto', 'stocks'];
