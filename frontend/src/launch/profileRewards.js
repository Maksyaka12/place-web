// Profile → Rewards without React: what a wallet takes part in, sorted by the filters of the Rewards hub.
//   staking  every PlaceStaking vault the wallet has a position in (`launch/staking?account&mine=1`), always shown,
//            live and upcoming first, then by end
//   holders  daily holder rewards it can claim now (`launch/rewards`, typed by `launch/hub`)
//   traders  daily trader rewards it can claim now
//   nft      NFT holder rewards: Merkle streams of the distributor for a collection, plus the 30-day holders pools
//            of NFT collections (`launch/nft/account` → claim(ids))
// One-off snapshot campaigns (PlaceHub) are listed apart under holders or NFT holders by their kind.

export const REWARD_FILTERS = [
  ['all', 'All'],
  ['staking', 'Staking'],
  ['holders', 'Holders'],
  ['traders', 'Traders'],
  ['nft', 'NFT holders'],
];

const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};
const STATUS_ORDER = { live: 0, open: 0, upcoming: 1, ended: 2 };

/** The hub type of a claimable distributor reward: the stream's type in `launch/hub` (nft for collections), else its kind. */
export function rewardType(item, typeOf) {
  const t = typeOf.get(item.streamId);
  if (t) return t;
  return item.kind === 'traders' ? 'traders' : 'holders';
}

/** What a snapshot campaign of PlaceHub counts as: NFT holders or holders. */
export const campaignType = (c) => (c?.kind === 'nft-holders' ? 'nft' : 'holders');

/**
 * rewards: `launch/rewards` items; streams: `launch/hub` streams; programs: `launch/staking` programs with the
 * account's position; collections: `launch/nft/account` claimable list; campaigns: snapshot campaigns it can claim
 * (`claims`), counted under holders or NFT holders by their kind.
 * Returns { staking, holders, traders, nft: { streams, pools }, campaigns: { holders, nft }, counts }.
 */
export function profileRewardGroups({ rewards = [], streams = [], programs = [], collections = [], campaigns = [] } = {}) {
  const typeOf = new Map(streams.map((s) => [s.id, s.type]));
  const due = rewards.filter((r) => big(r.claimable) > 0n).map((r) => ({ ...r, type: rewardType(r, typeOf) }));
  const byAmount = (a, b) => (big(b.claimable) > big(a.claimable) ? 1 : big(b.claimable) < big(a.claimable) ? -1 : 0);
  const staking = programs
    .filter((p) => p.position)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());
  const pools = collections.filter((c) => c.claimable == null || big(c.claimable) > 0n);
  const holders = due.filter((r) => r.type === 'holders').sort(byAmount);
  const traders = due.filter((r) => r.type === 'traders').sort(byAmount);
  const nftStreams = due.filter((r) => r.type === 'nft').sort(byAmount);
  const oneOff = { holders: campaigns.filter((c) => campaignType(c) === 'holders').length, nft: campaigns.filter((c) => campaignType(c) === 'nft').length };
  return {
    staking,
    holders,
    traders,
    nft: { streams: nftStreams, pools },
    campaigns: oneOff,
    counts: {
      staking: staking.length,
      holders: holders.length + oneOff.holders,
      traders: traders.length,
      nft: nftStreams.length + pools.length + oneOff.nft,
      all: staking.length + holders.length + traders.length + nftStreams.length + pools.length + oneOff.holders + oneOff.nft,
    },
  };
}

/** Lots of a staking position that can leave now, and when the next locked one unlocks. */
export function withdrawable(lots = [], nowMs = Date.now()) {
  const ready = lots.filter((l) => l.unlocked && big(l.amount) > 0n);
  const locked = lots.filter((l) => !l.unlocked && big(l.amount) > 0n).map((l) => new Date(l.unlockAt).getTime()).filter((t) => t > nowMs);
  return { ready, total: ready.reduce((s, l) => s + big(l.amount), 0n), nextUnlock: locked.length ? new Date(Math.min(...locked)) : null };
}

/** Old profile sections and where they live now. */
export const LEGACY_SECTIONS = { campaigns: 'launches', nfts: 'nft-launches' };
