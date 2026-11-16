// Place snapshot engine: pure functions, no network. Data sources (block at a time, balances, NFT owners)
// live next to the service that calls this; here only the math and the formats.
import { selectEligible, allocate } from './distribute.js';
import { buildTable } from './tree.js';

export * from './rules.js';
export * from './distribute.js';
export * from './tree.js';

/**
 * Computes a campaign's table from balances at the snapshot block.
 * @param {object} p
 * @param {object} p.rules        validated rules (rules.js)
 * @param {string} p.rulesHash    on-chain rulesHash
 * @param {bigint|number|string} p.campaignId
 * @param {{number: bigint, timestamp: bigint|number}} p.block   the snapshot block
 * @param {{account: string, balance: bigint}[]} p.balances      every candidate wallet at that block
 * @param {Iterable<string>} p.autoExclude  addresses found by the service (LP pools, the hub, zero/dead…)
 */
export function computeTable({ rules, rulesHash, campaignId, block, balances, autoExclude = [] }) {
  const eligible = selectEligible(balances, {
    minBalance: BigInt(rules.minBalance),
    exclude: [...autoExclude, ...rules.exclude, rules.hub],
  });
  if (!eligible.length) throw new Error('No eligible wallets at the snapshot block');
  const { rows, totalAllocated } = allocate(eligible, {
    pool: BigInt(rules.pool),
    distribution: rules.distribution,
    maxPerWallet: rules.maxPerWallet === null ? null : BigInt(rules.maxPerWallet),
  });
  return buildTable({ rules, rulesHash, campaignId, block, rows, totalAllocated });
}
