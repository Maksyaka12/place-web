import { WETH_ADDRESS } from './tokens.js';

// USD prices of tokens on Base. GeckoTerminal first (up to 30 tokens per request); tokens it does not price are
// asked from DEX Screener. ETH is priced as WETH. Returns { [lowercase address | 'eth']: usd }; unknown tokens
// are left out, so callers treat a missing price as "no USD value".

const GECKO = 'https://api.geckoterminal.com/api/v2/simple/networks/base/token_price';
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';

async function fromGecko(addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const data = await fetch(`${GECKO}/${chunk.join(',')}`).then((r) => r.json());
    const prices = data?.data?.attributes?.token_prices || {};
    for (const a of chunk) {
      const usd = Number(prices[a]);
      if (usd > 0) out[a] = usd;
    }
  }
  return out;
}

async function fromDexScreener(address) {
  const data = await fetch(`${DEXSCREENER}/${address}`).then((r) => r.json());
  const pair = (data?.pairs || [])
    .filter((p) => p.chainId === 'base' && p.baseToken?.address?.toLowerCase() === address && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return pair ? Number(pair.priceUsd) : null;
}

/** USD prices for token addresses (null = ETH). */
export async function fetchUsdPrices(addresses) {
  const wanted = [...new Set(addresses.map((a) => (a ? a.toLowerCase() : WETH_ADDRESS.toLowerCase())))];
  let found = {};
  try {
    found = await fromGecko(wanted);
  } catch {}
  for (const a of wanted.filter((x) => !(x in found))) {
    try {
      const usd = await fromDexScreener(a);
      if (usd) found[a] = usd;
    } catch {}
  }
  const weth = found[WETH_ADDRESS.toLowerCase()];
  if (weth) found.eth = weth;
  return found;
}
