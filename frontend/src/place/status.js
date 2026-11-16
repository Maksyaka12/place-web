// Campaign status exactly as PlaceHub.statusOf computes it, from a database row or API object.
// Shared by the API and the site so both always agree with the contract.
export const PUBLISH_GRACE_SECONDS = 72 * 3600;

export const STATUSES = ['scheduled', 'snapshotting', 'refundable', 'live', 'ended', 'closed', 'cancelled', 'refunded'];

const seconds = (v) => (v == null ? null : Math.floor(new Date(v).getTime() / 1000));

/**
 * @param {{stage: string, merkle_root?: string|null, snapshot_at: Date|string, claim_end?: Date|string|null}} c
 * @param {number} now unix seconds
 */
export function campaignStatus(c, now = Math.floor(Date.now() / 1000)) {
  if (c.stage === 'cancelled') return 'cancelled';
  if (c.stage === 'refunded') return 'refunded';
  if (c.stage === 'finalized') return 'closed';
  const snap = seconds(c.snapshot_at);
  if (!c.merkle_root) {
    if (now < snap) return 'scheduled';
    if (now < snap + PUBLISH_GRACE_SECONDS) return 'snapshotting';
    return 'refundable';
  }
  return now < seconds(c.claim_end) ? 'live' : 'ended';
}

const STAGE_OF_STATUS = { cancelled: 'cancelled', refunded: 'refunded', closed: 'finalized' };

/**
 * The same status for a campaign as the API returns it (camelCase view), recomputed at `now` so a page
 * can move from Upcoming to Snapshotting or from Live to Ended without reloading.
 */
export function viewStatus(view, now = Math.floor(Date.now() / 1000)) {
  return campaignStatus(
    {
      stage: STAGE_OF_STATUS[view.status] || 'open',
      merkle_root: view.merkleRoot,
      snapshot_at: view.snapshotAt,
      claim_end: view.claimEnd,
    },
    now
  );
}
