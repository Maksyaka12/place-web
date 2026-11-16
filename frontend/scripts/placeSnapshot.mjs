// Dry run of a Place snapshot against the real chain: finds the block, the holders and the exclusions,
// computes the table and prints a summary. Publishes nothing and pins nothing.
//
//   node scripts/placeSnapshot.mjs --chain 8453 --kind token-holders --target 0x… --at 2026-11-10T12:00:00Z \
//        [--min 5000000e18] [--pool 1000e18] [--distribution proportional|equal] [--cap 500000e18]
//        [--exclude 0xa,0xb] [--all 1] [--out table.json]
//
// Reads ALCHEMY_API_KEY from frontend/.env. Amounts accept a plain integer or `<n>e<decimals>`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseUnits } from 'viem';
import { chainClient, blockAtTime, collectHolders } from '../api/_lib/place/chain.js';
import { buildRules, encodeRules, computeTable, verifyTable } from '../src/place/snapshot/index.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
// "5000000e18" → 5000000 × 10^18 (also "1.5e18"); a plain integer is taken as is.
const amount = (v, d) => {
  if (v == null) return d;
  const [n, e = '0'] = String(v).split('e');
  return parseUnits(n, Number(e));
};

const chainId = Number(args.chain || 8453);
const kind = args.kind || 'token-holders';
const at = Math.floor(new Date(args.at || Date.now() - 60_000).getTime() / 1000);
const key = process.env.ALCHEMY_API_KEY;
const hub = args.hub || '0x493F55975Bff2e4f111BAd8D51637F3b9763Bdd1';
if (!args.target) throw new Error('--target is required');

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const client = chainClient({ chainId, key });
const block = await blockAtTime(client, at);
log(`snapshot block #${block.number} at ${new Date(Number(block.timestamp) * 1000).toISOString()}`);

const rules = buildRules({
  chainId,
  hub,
  kind,
  target: args.target,
  rewardToken: 'eth',
  pool: amount(args.pool, 10n ** 18n),
  snapshotAt: at,
  claimDuration: 30 * 86400,
  minBalance: amount(args.min, 1n),
  distribution: args.distribution || 'proportional',
  maxPerWallet: args.cap ? amount(args.cap) : null,
  exclude: args.exclude ? args.exclude.split(',').map((a) => a.trim()).filter(Boolean) : [],
  leftover: 'return',
});
const { rulesHash } = encodeRules(rules);

const { balances, autoExclude, receivers } = await collectHolders({
  client, chainId, key, kind, target: args.target, hub, block, minBalance: BigInt(rules.minBalance), onProgress: log,
});
const table = computeTable({ rules, rulesHash, campaignId: 0, block, balances, autoExclude });
verifyTable(table);

const fmt = (v) => (Number(BigInt(v) / 10n ** 12n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
log(`receivers ever: ${receivers}, holders read: ${balances.length}, eligible: ${table.wallets}`);
log(`auto-excluded holders: ${[...autoExclude].filter((a) => balances.some((b) => b.account === a && b.balance > 0n)).join(', ') || 'none'}`);
log(`pool ${fmt(table.pool)}, allocated ${fmt(table.totalAllocated)}, root ${table.merkleRoot}`);
for (const e of table.entries.slice(0, args.all ? undefined : 5)) {
  console.log(`  ${e.account}  balance ${kind === 'nft-holders' ? e.balance : fmt(e.balance)}  amount ${fmt(e.amount)}${e.capped ? ' (cap)' : ''}`);
}
if (args.out) {
  writeFileSync(args.out, JSON.stringify(table));
  log(`table written to ${args.out}`);
}
