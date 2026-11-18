// Community Pool actions of Place Launch 0.3.1 beyond streams and staking: a daily NFT holders campaign for an
// official collection of the token (fundNftCampaign: at most 25% of the fund, once per 30 days) and buyback & burn
// of the token (buybackAndBurn). The form takes a share of the fund; GET launch/fund-quote (kind=nft|buyback)
// simulates the call from the creator's address and returns the ready transaction.

export const BPS = 10_000;
export const NFT_SHARES = [500, 1000, 2500];
export const BUYBACK_SHARES = [1000, 2500, 5000, 10_000];

/** "12.5" → 1250 basis points; null when it is not a number between 0.01% and `maxBps`. */
export function parseShareBps(text, maxBps = BPS) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 1 && bps <= maxBps ? bps : null;
}

/** 1250 → "12.5". */
export function shareText(bps) {
  return String(Number((bps / 100).toFixed(2)));
}

/** The part of the fund a share spends, rounded down like the vault's own cap (balance × bps / 10 000). */
export function shareAmount(total, bps) {
  if (bps == null) return null;
  return (BigInt(total || 0) * BigInt(bps)) / BigInt(BPS);
}

/** Eligible collections first (official, paid, minted), keeping the API's order (official, then most minted). */
export function sortPoolCollections(list = []) {
  return [...list].sort((a, b) => Number(b.eligible) - Number(a.eligible));
}

/** The first collection that can get a campaign, else null. */
export function defaultCollection(list = []) {
  return sortPoolCollections(list).find((c) => c.eligible)?.address ?? null;
}

/**
 * What stops the NFT campaign before any quote: the pool's state, the cooldown, the collection.
 * Returns a sentence for the form, or null when a quote can be asked.
 */
export function nftBlocker(nft, collection, now = Date.now()) {
  if (!nft?.available) return nft?.reason || 'This pool cannot fund NFT campaigns';
  if (nft.nextAt && new Date(nft.nextAt).getTime() > now) return 'One NFT campaign per 30 days';
  if (!nft.collections?.length) return 'No Place collection is paired with this token yet';
  const c = nft.collections.find((x) => x.address === collection);
  if (!c) return 'Choose a collection';
  return c.eligible ? null : c.reason;
}

/** Query for GET launch/fund-quote, kind=nft; null while the form is not complete. */
export function nftQuoteQuery({ token, collection, total, shareBps, maxBps, rewardToken, slippageBps, epochCount, startEpoch, minNfts }) {
  const amountIn = shareAmount(total, shareBps);
  if (!token || !collection || shareBps == null || shareBps > maxBps || !amountIn) return null;
  if (!Number.isInteger(epochCount) || epochCount < 1 || epochCount > 365) return null;
  if (!Number.isInteger(minNfts) || minNfts < 1) return null;
  return { token, kind: 'nft', collection, rewardToken, amountIn: amountIn.toString(), slippageBps, epochCount, startEpoch, minNfts };
}

/** Query for GET launch/fund-quote, kind=buyback; null while the form is not complete. */
export function buybackQuoteQuery({ token, total, shareBps, slippageBps }) {
  const amountIn = shareAmount(total, shareBps);
  if (!token || shareBps == null || !amountIn) return null;
  return { token, kind: 'buyback', amountIn: amountIn.toString(), slippageBps };
}

/** Plain words for a Community Pool entry of launch_vault_events (pool log in Profile → Fees). */
export function poolLogLabel(kind) {
  return (
    {
      fund_collected: 'Collected from trades',
      fund_swapped: 'Swapped for the reward',
      fund_stream: 'Reward stream funded',
      fund_nft_stream: 'NFT holders campaign',
      fund_staking: 'Staking program funded',
      fund_burned: 'Bought back and burned',
    }[kind] || kind
  );
}
