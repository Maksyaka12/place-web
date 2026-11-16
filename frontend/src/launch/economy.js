// Place Launch economics on the site: the 1% trade fee splits 70% to the
// token's creator vault and 30% to Place; the creator's 0.7% splits into three baskets (burn, community fund,
// the creator). The form shows them as nested sliders: "give back" (burn + fund) and, of that, the burn part.

export const FEE_PCT = 1;
export const CREATOR_SHARE = 0.7; // decision #18
export const PLATFORM_SHARE = 0.3;
export const CREATOR_FEE_PCT = FEE_PCT * CREATOR_SHARE; // 0.7% of each trade
export const PLATFORM_FEE_PCT = FEE_PCT * PLATFORM_SHARE; // 0.3%

/** Starting points for the form (shares of the creator part, in %). */
export const ECONOMY_TEMPLATES = [
  { id: 'none', label: 'No economics', burn: 0, fund: 0, desc: 'All of your part goes to you. You can add burn or a community fund later, never remove it' },
  { id: 'deflation', label: 'Deflation', burn: 50, fund: 10, desc: 'Most of your part buys the token back every day and burns it' },
  { id: 'community', label: 'Community', burn: 10, fund: 50, desc: 'Most of your part fills a fund for holder campaigns and staking that you cannot withdraw' },
  { id: 'balanced', label: 'Balanced', burn: 25, fund: 25, desc: 'A quarter burned, a quarter to the community, half to you' },
];

/** The template whose shares match, or null (custom). */
export function templateOf(burn, fund) {
  return ECONOMY_TEMPLATES.find((t) => t.burn === burn && t.fund === fund) || null;
}

/** Nested sliders → baskets: `giveBack` % of the creator part, of which `burnOfGiveBack` % is burned. */
export function basketsFromNested(giveBack, burnOfGiveBack) {
  const burn = Math.round(giveBack * burnOfGiveBack) / 100;
  return { burn, fund: Math.round((giveBack - burn) * 100) / 100 };
}

/** Baskets → nested sliders. */
export function nestedFromBaskets(burn, fund) {
  const giveBack = burn + fund;
  return { giveBack, burnOfGiveBack: giveBack ? (burn / giveBack) * 100 : 50 }; // exact, so templates round-trip
}

/** Percent of the creator part → bps for the contract (integers, burn + fund ≤ 10000). */
export function toBps(pct) {
  return Math.round(Number(pct) * 100);
}

/**
 * Where `volume` (in USD or any unit) of trading goes: platform, creator (after X shares), X accounts, burn,
 * community fund. `xPct` is the X accounts' share of what is left for the creator.
 */
export function feeFlow({ burn, fund, xPct = 0, volume = 100 }) {
  const fee = (volume * FEE_PCT) / 100;
  const creatorSide = fee * CREATOR_SHARE;
  const toBurn = (creatorSide * burn) / 100;
  const toFund = (creatorSide * fund) / 100;
  const rest = creatorSide - toBurn - toFund;
  const toX = (rest * xPct) / 100;
  return { fee, platform: fee * PLATFORM_SHARE, creatorSide, burn: toBurn, fund: toFund, x: toX, creator: rest - toX };
}

/** "$0.175" style money for the flow sentence: up to 3 decimals, no trailing zeros past cents. */
export function flowMoney(v) {
  const s = v.toFixed(3);
  return `$${s.endsWith('0') ? v.toFixed(2) : s}`;
}

/** "From every $100 of volume: $0.30 to Place, $0.35 to you, $0.175 is burned, $0.175 goes to the community" */
export function flowSentence(flow, { you = 'you' } = {}) {
  const parts = [`${flowMoney(flow.platform)} to Place`];
  if (flow.creator > 0) parts.push(`${flowMoney(flow.creator)} to ${you}`);
  if (flow.x > 0) parts.push(`${flowMoney(flow.x)} to X accounts`);
  if (flow.burn > 0) parts.push(`${flowMoney(flow.burn)} is burned`);
  if (flow.fund > 0) parts.push(`${flowMoney(flow.fund)} goes to the community`);
  return `From every $100 of volume: ${parts.join(', ')}`;
}

/** Economics of a token from the API → shares in % (0.2.0) or null for legacy tokens. */
export function tokenShares(economics) {
  if (!economics || economics.legacy) return null;
  return { burn: economics.burnBps / 100, fund: economics.communityBps / 100, creator: economics.creatorBps / 100 };
}
