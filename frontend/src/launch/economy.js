// Place Launch economics on the site: the launch form (0.3.0) and the token page / profile, which show every
// release in one shape (`tokenEconomy`). 0.2.0 tokens pay 1%: 30% to Place and 70% to the creator vault, which splits
// it into burn, community fund and the creator. 0.3.0 has Standard (1%, 30/70) and Economy (taxes, five buckets).

// ── 0.3.0: Standard and Economy launches ──
// Standard: 1% on buys and sells, 30% of it to Place, the rest to the creator.
// Economy: a buy tax and a sell tax of 1–5% each; Place takes 30% of the tax, and the creator splits the rest
// between five buckets that add up to 100%. Everything is fixed at launch.

export const TAX_MIN_PCT = 1;
export const TAX_MAX_PCT = 5;
export const PROTOCOL_TAX_SHARE = 0.3;
export const MIN_HOLDING_TOKENS = 10_000;

/** The five buckets of an Economy token, in the order the form and the charts show them. */
export const BUCKETS = [
  { id: 'creator', label: 'Creator funds', short: 'Creator', tone: 'creator', desc: 'Paid to you (or your payout wallet and X accounts) in the pair asset' },
  { id: 'holders', label: 'Holder rewards', short: 'Holders', tone: 'holders', desc: 'Shared every day between wallets that hold at least the minimum' },
  { id: 'traders', label: 'Trader rewards', short: 'Traders', tone: 'traders', desc: 'Shared every day between wallets that traded at least the minimum that day' },
  { id: 'burn', label: 'Burn allocation', short: 'Burn', tone: 'burn', desc: 'Taken in your token and sent to 0x…dEaD when anyone presses Burn' },
  { id: 'community', label: 'Community pool', short: 'Community', tone: 'community', desc: 'Held in a vault you cannot withdraw from; it only funds reward campaigns and staking' },
];

export const DEFAULT_ALLOCATION = { creator: 40, holders: 30, traders: 10, burn: 10, community: 10 };

export const allocationTotal = (a) => BUCKETS.reduce((s, b) => s + (Number(a[b.id]) || 0), 0);

/** What a tax of `taxPct` does with a trade: Place's part and each bucket, all in % of the trade. */
export function taxSplit(taxPct, allocation) {
  const protocol = taxPct * PROTOCOL_TAX_SHARE;
  const rest = taxPct - protocol;
  const out = { tax: taxPct, protocol, rest };
  for (const b of BUCKETS) out[b.id] = (rest * (Number(allocation[b.id]) || 0)) / 100;
  return out;
}

/** "0.18%" for a share of the trade: up to 3 decimals, no trailing zeros. */
export const tradePct = (v) => `${Number(Number(v).toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;

/** Percent → basis points (1% = 100). */
export const pctToBps = (pct) => Math.round(Number(pct) * 100);

/** Display labels of the reward stream kinds. */
export const STREAM_LABEL = { holders: 'Holder rewards', traders: 'Trader rewards' };

/**
 * A token's economics from the API in one shape for every release since 0.2.0, or null for 0.1.0 (buyback and
 * rewards pool, shown by its own block). `shares` are % of what is left after Place, `perTrade.buy/sell` % of a trade.
 */
export function tokenEconomy(token) {
  const e = token?.economics;
  const generation = token?.generation ?? e?.generation;
  if (!e || generation == null || generation < 2) return null;
  const xPct = (e.xShares || []).reduce((s, x) => s + Number(x.bps || 0), 0) / 100;
  let type = 'standard';
  let buyTax = 1;
  let sellTax = 1;
  let shares = { creator: 100, holders: 0, traders: 0, burn: 0, community: 0 };
  if (generation === 2) {
    shares = { creator: (e.creatorBps ?? 10_000) / 100, holders: 0, traders: 0, burn: (e.burnBps || 0) / 100, community: (e.communityBps || 0) / 100 };
  } else if (e.launchType === 'economy') {
    type = 'economy';
    buyTax = Number(e.buyTax) || 0;
    sellTax = Number(e.sellTax) || 0;
    shares = Object.fromEntries(BUCKETS.map((b) => [b.id, Number(e.shares?.[b.id]) || 0]));
  }
  // The API's split is exact (the hook's own math); without it, the same split from the shares.
  const side = (api, tax) => (type === 'economy' && api?.total != null ? { ...api, tax, rest: tax - api.protocol } : taxSplit(tax, shares));
  return {
    generation,
    type,
    buyTax,
    sellTax,
    shares,
    xPct,
    perTrade: { buy: side(e.perTrade?.buy, buyTax), sell: side(e.perTrade?.sell, sellTax) },
    minHolding: e.minHolding ?? null,
    minTraderDailyVolume: e.minTraderDailyVolume ?? null,
    rewardToken: e.rewardToken ?? null,
    antiSnipe: generation >= 3 ? e.antiSnipe !== false : true,
    communityVault: e.communityVault ?? null,
  };
}
