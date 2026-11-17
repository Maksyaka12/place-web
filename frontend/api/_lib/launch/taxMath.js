// Place Launch 0.3.0 fee math in JavaScript, mirroring PlaceFeeMath + PlaceLaunchValidation.resolveLaunchTax
// (place-contracts). Used by launch/predict before the factory is deployed and to double-check the factory's
// previewTaxConfiguration after. Rates and shares are in 1e8 = 100% (PERCENTAGE_SCALE); a Rates value is a
// fraction of the trade in 1e24 (RATE_SCALE), exactly like the contract.
export const PERCENTAGE_SCALE = 100_000_000n;
export const RATE_SCALE = 10n ** 24n;
export const PLACE_FEE_RATE = 1_000_000n; // Standard: 1%
export const MIN_ECONOMY_TAX_RATE = 1_000_000n; // Economy: 1%..5% per side
export const MAX_ECONOMY_TAX_RATE = 5_000_000n;
export const PLACE_PROTOCOL_SHARE = 30_000_000n; // 30% of the tax
export const PLACE_MIN_PROTOCOL_FEE_RATE = 300_000n; // at least 0.3% of the trade
export const PLACE_MAX_PROTOCOL_FEE_RATE = 1_500_000n; // at most 1.5%
export const MIN_HOLDER_REWARD_HOLDING = 10_000n * 10n ** 18n;
export const LAUNCH_TYPE = { standard: 0, economy: 1 };
export const LAUNCH_TYPE_NAME = ['standard', 'economy'];
export const BASKETS = ['creator', 'holders', 'traders', 'burn', 'community'];
const ZERO = '0x0000000000000000000000000000000000000000';

export class EconomicsError extends Error {}
const bad = (m) => {
  throw new EconomicsError(m);
};

/** The fixed Place policy (PlaceLaunchFactoryCore._placePolicy) without the recipient. */
export const PLACE_POLICY = {
  minimumBuyTaxRate: MIN_ECONOMY_TAX_RATE,
  maximumBuyTaxRate: MAX_ECONOMY_TAX_RATE,
  minimumSellTaxRate: MIN_ECONOMY_TAX_RATE,
  maximumSellTaxRate: MAX_ECONOMY_TAX_RATE,
  protocolTaxShare: PLACE_PROTOCOL_SHARE,
  minimumProtocolFeeRate: PLACE_MIN_PROTOCOL_FEE_RATE,
  maximumProtocolFeeRate: PLACE_MAX_PROTOCOL_FEE_RATE,
};

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

/** PlaceFeeMath.protocolRateNumerator: the protocol cut, denominator PERCENTAGE_SCALE². */
export function protocolRateNumerator(totalTaxRate, policy = PLACE_POLICY) {
  const t = BigInt(totalTaxRate);
  if (t === 0n) return 0n;
  if (t < policy.minimumProtocolFeeRate) bad('Tax is below the platform minimum');
  return min(max(t * policy.protocolTaxShare, policy.minimumProtocolFeeRate * PERCENTAGE_SCALE), policy.maximumProtocolFeeRate * PERCENTAGE_SCALE);
}

/** PlaceFeeMath.rates for one side (no anti-snipe surcharge). */
export function rates(totalTaxRate, tax, policy = PLACE_POLICY) {
  const t = BigInt(totalTaxRate);
  const p = protocolRateNumerator(t, policy);
  const remainder = t * PERCENTAGE_SCALE - p;
  const r = {
    protocolRate: p * PERCENTAGE_SCALE,
    creatorRate: remainder * BigInt(tax.creatorAllocationShare),
    holderRate: remainder * BigInt(tax.holderAllocationShare),
    traderRate: remainder * BigInt(tax.traderAllocationShare),
    burnRate: remainder * BigInt(tax.burnAllocationShare),
    communityRate: remainder * BigInt(tax.communityAllocationShare),
    surchargeRate: 0n,
  };
  r.quoteRate = r.protocolRate + r.creatorRate + r.holderRate + r.traderRate + r.communityRate + r.surchargeRate;
  if (r.quoteRate + r.burnRate !== t * PERCENTAGE_SCALE * PERCENTAGE_SCALE) bad('Baskets must add up to 100%');
  return r;
}

/**
 * PlaceLaunchValidation.resolveLaunchTax: the tax configuration of `economics` (contract format, bigint or
 * number fields), validated like a launch. `supply` is the launch supply; `distributor` whether the factory has
 * a rewards distributor (reward and community baskets need one).
 */
export function resolveLaunchTax(e, { supply = 10n ** 27n, distributor = true, policy = PLACE_POLICY } = {}) {
  const a = e.allocation;
  const n = (v) => BigInt(v ?? 0);
  let tax;
  if (Number(e.launchType) === LAUNCH_TYPE.standard) {
    if (n(e.buyTaxRate) || n(e.sellTaxRate) || BASKETS.some((k) => n(a[k])) || n(e.minHolding) || n(e.minTraderDailyVolume) || (e.rewardToken && e.rewardToken.toLowerCase() !== ZERO)) {
      bad('Standard launches have no taxes, baskets or reward settings');
    }
    tax = { buyTaxRate: PLACE_FEE_RATE, sellTaxRate: PLACE_FEE_RATE, creatorAllocationShare: PERCENTAGE_SCALE, holderAllocationShare: 0n, traderAllocationShare: 0n, burnAllocationShare: 0n, communityAllocationShare: 0n };
  } else {
    tax = {
      buyTaxRate: n(e.buyTaxRate),
      sellTaxRate: n(e.sellTaxRate),
      creatorAllocationShare: n(a.creator),
      holderAllocationShare: n(a.holders),
      traderAllocationShare: n(a.traders),
      burnAllocationShare: n(a.burn),
      communityAllocationShare: n(a.community),
    };
    if (n(a.holders)) {
      if (n(e.minHolding) < MIN_HOLDER_REWARD_HOLDING || n(e.minHolding) > BigInt(supply)) bad('Minimum holding must be from 10,000 tokens to the whole supply');
    } else if (n(e.minHolding)) bad('Minimum holding needs a holders basket');
    if (!n(a.traders) && n(e.minTraderDailyVolume)) bad('Minimum daily volume needs a traders basket');
    const rewards = n(a.holders) || n(a.traders);
    if (!rewards && e.rewardToken && e.rewardToken.toLowerCase() !== ZERO) bad('A reward token needs a holders or traders basket');
    if ((rewards || n(a.community)) && !distributor) bad('Reward and community baskets are not available yet');
    if (tax.buyTaxRate < policy.minimumBuyTaxRate || tax.buyTaxRate > policy.maximumBuyTaxRate || tax.sellTaxRate < policy.minimumSellTaxRate || tax.sellTaxRate > policy.maximumSellTaxRate) {
      bad('Buy and sell tax must each be 1–5%');
    }
  }
  const shares = tax.creatorAllocationShare + tax.holderAllocationShare + tax.traderAllocationShare + tax.burnAllocationShare + tax.communityAllocationShare;
  if (shares !== PERCENTAGE_SCALE) bad('Baskets must add up to 100%');
  return tax;
}

/** factory.previewTaxConfiguration without the config version: buy and sell Rates. */
export function previewTax(e, opts) {
  const tax = resolveLaunchTax(e, opts);
  return { tax, buyRates: rates(tax.buyTaxRate, tax, opts?.policy), sellRates: rates(tax.sellTaxRate, tax, opts?.policy) };
}

// Percent of the trade, rounded to 1e-6 % (a Rates value is a fraction in 1e24).
const pct = (r) => Number((BigInt(r) * 1_000_000n) / 10n ** 22n) / 1_000_000;

/** A Rates struct (from the contract or rates()) as percent of the trade per basket. */
export function ratesPercent(r) {
  const out = {
    protocol: pct(r.protocolRate),
    creator: pct(r.creatorRate),
    holders: pct(r.holderRate),
    traders: pct(r.traderRate),
    burn: pct(r.burnRate),
    community: pct(r.communityRate),
  };
  out.total = pct(BigInt(r.quoteRate) + BigInt(r.burnRate) - BigInt(r.surchargeRate ?? 0));
  return out;
}

/** The share of a bps value (0–10000) in PERCENTAGE_SCALE. */
export const bpsToShare = (bps) => BigInt(bps) * 10_000n;
/** A tax in bps (100 = 1%) as a 1e8 rate. */
export const bpsToRate = (bps) => BigInt(bps) * 10_000n;
