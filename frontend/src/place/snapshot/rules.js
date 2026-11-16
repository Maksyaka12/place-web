// Campaign rules: the JSON a creator pins to IPFS before createCampaign. Its keccak256 goes on-chain as
// rulesHash, so the snapshot service can prove it computed the table by exactly these rules.
//
// The document is canonical JSON (sorted keys, no spaces, lowercase addresses, amounts as decimal strings),
// so the same rules always give the same bytes and the same hash, whoever builds them.
import { keccak256, toBytes, isAddress, getAddress } from 'viem';

export const RULES_SCHEMA = 'place.rules/1';
export const KINDS = ['token-holders', 'nft-holders'];
export const DISTRIBUTIONS = ['proportional', 'equal'];
export const LEFTOVER = ['return', 'burn'];
export const ETH = 'eth';
export const MAX_EXCLUDE = 1000;

// On-chain enum PlaceHub.Kind.
export const KIND_ID = { 'token-holders': 0, 'nft-holders': 1 };

const addr = (a) => getAddress(a).toLowerCase();
const uint = (v) => {
  const n = BigInt(v);
  if (n < 0n) throw new Error('negative amount');
  return n.toString();
};

/** Builds a normalized rules object from form input (amounts as bigint, number or decimal string). */
export function buildRules(input) {
  const rules = {
    schema: RULES_SCHEMA,
    chainId: Number(input.chainId),
    hub: addr(input.hub),
    kind: input.kind,
    target: addr(input.target),
    rewardToken: input.rewardToken === ETH || !input.rewardToken ? ETH : addr(input.rewardToken),
    pool: uint(input.pool),
    snapshotAt: Number(input.snapshotAt),
    claimDuration: Number(input.claimDuration),
    minBalance: uint(input.minBalance ?? 1),
    distribution: input.distribution,
    maxPerWallet: input.maxPerWallet == null || input.maxPerWallet === '' ? null : uint(input.maxPerWallet),
    exclude: [...new Set((input.exclude || []).map(addr))].sort(),
    leftover: input.leftover,
  };
  validateRules(rules);
  return rules;
}

/** Throws with a readable message if the rules are not valid. */
export function validateRules(r) {
  const fail = (m) => {
    throw new Error(`Invalid rules: ${m}`);
  };
  if (!r || typeof r !== 'object') fail('not an object');
  if (r.schema !== RULES_SCHEMA) fail(`schema must be ${RULES_SCHEMA}`);
  if (!Number.isInteger(r.chainId) || r.chainId <= 0) fail('chainId');
  for (const k of ['hub', 'target']) if (!isAddress(r[k]) || r[k] !== r[k].toLowerCase()) fail(k);
  if (r.rewardToken !== ETH && (!isAddress(r.rewardToken) || r.rewardToken !== r.rewardToken.toLowerCase())) {
    fail('rewardToken');
  }
  if (!KINDS.includes(r.kind)) fail('kind');
  if (!DISTRIBUTIONS.includes(r.distribution)) fail('distribution');
  if (!LEFTOVER.includes(r.leftover)) fail('leftover');
  const dec = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
  if (!dec(r.pool) || BigInt(r.pool) === 0n) fail('pool');
  if (!dec(r.minBalance) || BigInt(r.minBalance) === 0n) fail('minBalance must be at least 1');
  if (r.maxPerWallet !== null && (!dec(r.maxPerWallet) || BigInt(r.maxPerWallet) === 0n)) fail('maxPerWallet');
  if (!Number.isInteger(r.snapshotAt) || r.snapshotAt <= 0) fail('snapshotAt');
  if (!Number.isInteger(r.claimDuration) || r.claimDuration <= 0) fail('claimDuration');
  if (!Array.isArray(r.exclude) || r.exclude.length > MAX_EXCLUDE) fail('exclude');
  for (let i = 0; i < r.exclude.length; i++) {
    const a = r.exclude[i];
    if (!isAddress(a) || a !== a.toLowerCase()) fail(`exclude[${i}]`);
    if (i > 0 && a <= r.exclude[i - 1]) fail('exclude must be sorted and unique');
  }
  const known = new Set(Object.keys(buildTemplate()));
  for (const k of Object.keys(r)) if (!known.has(k)) fail(`unknown field ${k}`);
}

function buildTemplate() {
  return {
    schema: 0, chainId: 0, hub: 0, kind: 0, target: 0, rewardToken: 0, pool: 0, snapshotAt: 0, claimDuration: 0,
    minBalance: 0, distribution: 0, maxPerWallet: 0, exclude: 0, leftover: 0,
  };
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The exact bytes to pin and their hash for createCampaign. */
export function encodeRules(rules) {
  validateRules(rules);
  const json = canonicalJson(rules);
  return { json, rulesHash: keccak256(toBytes(json)) };
}

/**
 * Parses rules fetched from IPFS and checks them against what the hub stores. Returns the rules, or throws
 * listing every mismatch — the service must not publish a table for rules the campaign did not commit to.
 * `campaign` is PlaceHub.getCampaign(id) as viem returns it; `hub` and `chainId` are where it lives.
 */
export function parseCommittedRules(json, { campaign, hub, chainId }) {
  if (keccak256(toBytes(json)) !== campaign.rulesHash) throw new Error('Rules do not match the on-chain rulesHash');
  const rules = JSON.parse(json);
  validateRules(rules);
  if (canonicalJson(rules) !== json) throw new Error('Rules are not canonical JSON');

  const problems = [];
  const eq = (name, a, b) => {
    if (String(a).toLowerCase() !== String(b).toLowerCase()) problems.push(`${name}: rules ${a}, chain ${b}`);
  };
  eq('chainId', rules.chainId, chainId);
  eq('hub', rules.hub, hub);
  eq('kind', KIND_ID[rules.kind], Number(campaign.kind));
  eq('target', rules.target, campaign.target);
  eq('rewardToken', rules.rewardToken === ETH ? '0x0000000000000000000000000000000000000000' : rules.rewardToken, campaign.rewardToken);
  eq('pool', rules.pool, BigInt(campaign.pool).toString());
  eq('snapshotAt', rules.snapshotAt, Number(campaign.snapshotAt));
  eq('claimDuration', rules.claimDuration, Number(campaign.claimDuration));
  eq('leftover', rules.leftover === 'burn', Boolean(campaign.burnLeftover));
  if (problems.length) throw new Error(`Rules disagree with the campaign: ${problems.join('; ')}`);
  return rules;
}
