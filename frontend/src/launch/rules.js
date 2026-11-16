// Holder campaigns started by a PlaceCreatorVault. Every vault commits one shared
// template for all its campaigns instead of per-campaign rules; the per-campaign values come from the hub's
// CampaignCreated. The publisher checks the template against rulesHash and the campaign against the template,
// then computes the table with the equivalent `place.rules/1` built here.
//
//   place.launch-rules/1  (0.1.0)  startRewardsCampaign: reward = the pair, snapshot = creation + snapshotDelay,
//                                  claimDuration and leftover fixed by the template
//   place.launch-rules/2  (0.2.0)  fundCampaign / startDefaultCampaign: reward token, pool, snapshot, claim window
//                                  and leftover are the creator's choice (from CampaignCreated); PlaceStaking is
//                                  excluded too (staked tokens sit there)
import { keccak256, toBytes } from 'viem';
import { buildRules, DISTRIBUTIONS, LEFTOVER } from '../place/snapshot/rules.js';

export const LAUNCH_RULES_SCHEMA = 'place.launch-rules/1';
export const LAUNCH_RULES_SCHEMA_V2 = 'place.launch-rules/2';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * @param {string} json      the template as fetched from rulesURI
 * @param {object} p
 * @param {object} p.campaign  PlaceHub.getCampaign(id) as viem returns it
 * @param {string} p.hub
 * @param {number} p.chainId
 * @param {object} p.d         the release the vault belongs to (launchReleases(chainId) entry)
 * @param {{address: string, token: string, quote: string}} p.vault  the vault that created the campaign
 * @param {number} p.createdAt unix time of the campaign's creation block
 * @returns {object} validated place.rules/1 for computeTable
 */
export function launchCampaignRules(json, { campaign, hub, chainId, d, vault, createdAt }) {
  const fail = (m) => {
    throw new Error(`Launch rules: ${m}`);
  };
  const hash = keccak256(toBytes(json));
  if (hash !== String(campaign.rulesHash).toLowerCase()) fail('template does not match the on-chain rulesHash');
  const known = d.launchRules.find((r) => r.rulesHash === hash);
  if (!known) fail('unknown template');
  let t;
  try {
    t = JSON.parse(json);
  } catch {
    fail('template is not JSON');
  }
  if (t.schema !== known.schema) fail(`schema must be ${known.schema}`);
  if (t.kind !== 'token-holders') fail('kind must be token-holders');
  if (!DISTRIBUTIONS.includes(t.distribution)) fail('distribution');
  const v2 = t.schema === LAUNCH_RULES_SCHEMA_V2;
  if (!v2) {
    if (!LEFTOVER.includes(t.leftover)) fail('leftover');
    if (!Number.isInteger(t.claimDuration) || !Number.isInteger(t.snapshotDelay)) fail('claimDuration and snapshotDelay must be integers');
  }

  const problems = [];
  const eq = (name, a, b) => {
    if (String(a).toLowerCase() !== String(b).toLowerCase()) problems.push(`${name}: expected ${a}, chain ${b}`);
  };
  eq('creator', vault.address, campaign.creator);
  eq('kind', 0, Number(campaign.kind));
  eq('target', vault.token, campaign.target);
  if (v2) {
    // The vault fixes these itself; the hub enforces its own bounds. Only sanity checks here.
    if (!(Number(campaign.claimDuration) > 0)) problems.push('claimDuration must be positive');
    if (createdAt != null && Number(campaign.snapshotAt) < Number(createdAt)) problems.push('snapshotAt is before the campaign was created');
  } else {
    eq('rewardToken', vault.quote, campaign.rewardToken);
    eq('claimDuration', t.claimDuration, Number(campaign.claimDuration));
    eq('leftover', t.leftover === 'burn', Boolean(campaign.burnLeftover));
    if (createdAt != null) eq('snapshotAt', Number(createdAt) + t.snapshotDelay, Number(campaign.snapshotAt));
  }
  if (problems.length) fail(`campaign disagrees with the template: ${problems.join('; ')}`);

  const reward = String(campaign.rewardToken).toLowerCase();
  // The template's exclusions: the launch pool's contracts, the vault itself, staking and the burn address.
  return buildRules({
    chainId,
    hub,
    kind: 'token-holders',
    target: vault.token,
    rewardToken: reward === ZERO ? 'eth' : reward,
    pool: BigInt(campaign.pool),
    snapshotAt: Number(campaign.snapshotAt),
    claimDuration: Number(campaign.claimDuration),
    minBalance: t.minBalance,
    distribution: t.distribution,
    maxPerWallet: null,
    exclude: [d.poolManager, d.hook, d.feeEscrow, vault.address, DEAD, ...(v2 && d.staking ? [d.staking] : [])],
    leftover: v2 ? (campaign.burnLeftover ? 'burn' : 'return') : t.leftover,
  });
}
