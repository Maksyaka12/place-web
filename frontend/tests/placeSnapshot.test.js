// Place snapshot engine: rules format, allocation math and the Merkle tree PlaceHub verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, concatHex, toBytes } from 'viem';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  buildRules,
  encodeRules,
  canonicalJson,
  parseCommittedRules,
  validateRules,
  selectEligible,
  allocate,
  leafHash,
  buildTree,
  verifyTable,
  claimFromTable,
  computeTable,
  LEAF_ENCODING,
} from '../src/place/snapshot/index.js';

const SEPOLIA_HUB = '0x493F55975Bff2e4f111BAd8D51637F3b9763Bdd1';
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;

// What the PlaceHub on Base Sepolia returns from leaf(id, account, amount) (read with cast, 2026-11-11).
test('leafHash matches PlaceHub.leaf on Base Sepolia', () => {
  assert.equal(
    leafHash({ hub: SEPOLIA_HUB, chainId: 84532, campaignId: 0, account: A(0x1111111111111111111111111111111111111111n), amount: 10n ** 18n }),
    '0xc08065f2e48c71405c34a25f90bad5c058f7e17bb775795c6fa5698e78e5e4bc'
  );
  assert.equal(
    leafHash({ hub: SEPOLIA_HUB, chainId: 84532, campaignId: 7, account: '0x9F687A81012e8039679b43BD7A910b5Cf4bb6fC4', amount: 123456789n }),
    '0xcfee9ed908aa71b471a601934496e096c6df99d4edf39dbc0aa15a90156479fa'
  );
});

// OpenZeppelin MerkleProof: sorted-pair hashing up to the root.
function verifyLikeContract(proof, root, leaf) {
  let h = leaf;
  for (const p of proof) h = h.toLowerCase() < p.toLowerCase() ? keccak256(concatHex([h, p])) : keccak256(concatHex([p, h]));
  return h === root;
}

test('tree leaves and proofs are what the contract checks', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({ account: A(i + 1), amount: BigInt(i + 1) * 10n ** 15n }));
  const { tree, root } = buildTree({ hub: SEPOLIA_HUB, chainId: 84532, campaignId: 3, rows });
  for (const [i, v] of tree.entries()) {
    const leaf = leafHash({ hub: v[0], chainId: v[1], campaignId: v[2], account: v[3], amount: v[4] });
    assert.equal(tree.leafHash(v), leaf);
    assert.ok(verifyLikeContract(tree.getProof(i), root, leaf));
    assert.ok(!verifyLikeContract(tree.getProof(i), root, leafHash({ hub: v[0], chainId: v[1], campaignId: 4, account: v[3], amount: v[4] })));
  }
  assert.deepEqual(LEAF_ENCODING, ['address', 'uint256', 'uint256', 'address', 'uint256']);
});

// ─────────────────────────────── allocation ───────────────────────────────

const h = (n, balance) => ({ account: A(n), balance: BigInt(balance) });
const amounts = (r) => Object.fromEntries(r.rows.map((x) => [Number(BigInt(x.account)), x.amount]));

test('proportional: shares by balance, dust to the largest, whole pool out', () => {
  const r = allocate([h(1, 1), h(2, 1), h(3, 1)], { pool: 100n, distribution: 'proportional' });
  assert.deepEqual(amounts(r), { 1: 34n, 2: 33n, 3: 33n });
  assert.equal(r.totalAllocated, 100n);

  const r2 = allocate([h(1, 300), h(2, 100)], { pool: 1000n, distribution: 'proportional' });
  assert.deepEqual(amounts(r2), { 1: 750n, 2: 250n });
});

test('proportional with cap: the cut is shared again among the rest', () => {
  // 80/10/10 of 1000 with cap 500: the whale gets 500, the other 500 splits 250/250.
  const r = allocate([h(1, 80), h(2, 10), h(3, 10)], { pool: 1000n, distribution: 'proportional', maxPerWallet: 500n });
  assert.deepEqual(amounts(r), { 1: 500n, 2: 250n, 3: 250n });
  assert.equal(r.totalAllocated, 1000n);
  assert.deepEqual(r.rows.map((x) => x.capped), [true, false, false]);

  // A cap that bites in a second round: 60/30/10 of 1000, cap 350.
  // Round 1: 600 ≥ 350 → 350. Round 2: 650 over 30/10 → 487.5 ≥ 350 → 350. Round 3: 300 to the last.
  const r2 = allocate([h(1, 60), h(2, 30), h(3, 10)], { pool: 1000n, distribution: 'proportional', maxPerWallet: 350n });
  assert.deepEqual(amounts(r2), { 1: 350n, 2: 350n, 3: 300n });
});

test('everyone at the cap: the rest stays unallocated', () => {
  const r = allocate([h(1, 5), h(2, 1)], { pool: 1000n, distribution: 'proportional', maxPerWallet: 100n });
  assert.deepEqual(amounts(r), { 1: 100n, 2: 100n });
  assert.equal(r.totalAllocated, 200n);
});

test('equal: same amount each, dust first, cap respected', () => {
  assert.deepEqual(amounts(allocate([h(1, 1), h(2, 50), h(3, 9)], { pool: 10n, distribution: 'equal' })), { 2: 4n, 3: 3n, 1: 3n });
  const capped = allocate([h(1, 1), h(2, 2)], { pool: 1000n, distribution: 'equal', maxPerWallet: 300n });
  assert.deepEqual(amounts(capped), { 1: 300n, 2: 300n });
  assert.equal(capped.totalAllocated, 600n);
});

test('wallets that round to zero are left out', () => {
  const r = allocate([h(1, 10n ** 30n), h(2, 1)], { pool: 10n, distribution: 'proportional' });
  assert.deepEqual(amounts(r), { 1: 10n });
});

test('order of input does not change the result', () => {
  const list = [h(5, 7), h(1, 7), h(9, 3), h(2, 100)];
  const a = allocate(list, { pool: 999n, distribution: 'proportional', maxPerWallet: 600n });
  const b = allocate([...list].reverse(), { pool: 999n, distribution: 'proportional', maxPerWallet: 600n });
  assert.deepEqual(a, b);
});

test('random tables never exceed the pool or the cap, and hand out everything they can', () => {
  let seed = 42n;
  const rnd = (max) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return seed % max;
  };
  for (let run = 0; run < 300; run++) {
    const n = Number(rnd(40n)) + 1;
    const list = Array.from({ length: n }, (_, i) => h(i + 1, rnd(10n ** 24n) + 1n));
    const pool = rnd(10n ** 26n) + 1n;
    const cap = run % 3 === 0 ? null : rnd(pool) + 1n;
    for (const distribution of ['proportional', 'equal']) {
      const r = allocate(list, { pool, distribution, maxPerWallet: cap });
      const sum = r.rows.reduce((s, x) => s + x.amount, 0n);
      assert.equal(sum, r.totalAllocated);
      assert.ok(sum <= pool);
      if (cap !== null) assert.ok(r.rows.every((x) => x.amount <= cap));
      const allCapped = cap !== null && r.rows.length === n && r.rows.every((x) => x.amount === cap);
      if (!allCapped) assert.equal(sum, pool, `run ${run} ${distribution}: pool not fully used`);
    }
  }
});

test('selectEligible: min balance, exclusions, duplicates', () => {
  const out = selectEligible([h(1, 5), h(2, 4), h(3, 0), { account: A(4).toUpperCase().replace('0X', '0x'), balance: 9n }], {
    minBalance: 5n,
    exclude: [A(4)],
  });
  assert.deepEqual(out.map((x) => x.account), [A(1)]);
  assert.throws(() => selectEligible([h(1, 1), h(1, 2)], { minBalance: 1n }), /Duplicate/);
});

// ─────────────────────────────── rules ───────────────────────────────

const RULES_INPUT = {
  chainId: 84532,
  hub: SEPOLIA_HUB,
  kind: 'token-holders',
  target: '0x4200000000000000000000000000000000000006',
  rewardToken: 'eth',
  pool: 10n ** 18n,
  snapshotAt: 1_800_000_000,
  claimDuration: 30 * 86400,
  minBalance: 5n * 10n ** 18n,
  distribution: 'proportional',
  maxPerWallet: 10n ** 17n,
  exclude: [A(9), A(3), A(9)],
  leftover: 'burn',
};

test('rules are canonical: same input, same bytes and hash', () => {
  const rules = buildRules(RULES_INPUT);
  assert.deepEqual(rules.exclude, [A(3), A(9)]);
  const { json, rulesHash } = encodeRules(rules);
  assert.equal(json, canonicalJson(JSON.parse(json)));
  assert.equal(rulesHash, keccak256(toBytes(json)));
  assert.equal(encodeRules(buildRules({ ...RULES_INPUT, exclude: [A(3), A(9)] })).rulesHash, rulesHash);
  assert.ok(!json.includes(' '));
});

test('rules validation', () => {
  assert.throws(() => buildRules({ ...RULES_INPUT, distribution: 'random' }), /distribution/);
  assert.throws(() => buildRules({ ...RULES_INPUT, pool: 0 }), /pool/);
  assert.throws(() => buildRules({ ...RULES_INPUT, minBalance: 0 }), /minBalance/);
  assert.throws(() => validateRules({ ...buildRules(RULES_INPUT), extra: 1 }), /unknown field/);
  assert.throws(() => validateRules({ ...buildRules(RULES_INPUT), exclude: [A(9), A(3)] }), /sorted/);
});

function campaignFor(rules, rulesHash, patch = {}) {
  return {
    kind: 0,
    target: '0x4200000000000000000000000000000000000006',
    rewardToken: '0x0000000000000000000000000000000000000000',
    pool: 10n ** 18n,
    snapshotAt: 1_800_000_000n,
    claimDuration: 30 * 86400,
    burnLeftover: true,
    rulesHash,
    ...patch,
  };
}

test('committed rules must match the hash and the on-chain campaign', () => {
  const { json, rulesHash } = encodeRules(buildRules(RULES_INPUT));
  const ctx = { hub: SEPOLIA_HUB, chainId: 84532 };
  assert.equal(parseCommittedRules(json, { ...ctx, campaign: campaignFor(null, rulesHash) }).pool, '1000000000000000000');
  assert.throws(() => parseCommittedRules(json.replace('burn', 'return'), { ...ctx, campaign: campaignFor(null, rulesHash) }), /rulesHash/);
  assert.throws(() => parseCommittedRules(json, { ...ctx, campaign: campaignFor(null, rulesHash, { pool: 2n }) }), /pool/);
  assert.throws(() => parseCommittedRules(json, { ...ctx, campaign: campaignFor(null, rulesHash, { burnLeftover: false }) }), /leftover/);
  assert.throws(() => parseCommittedRules(json, { hub: A(1), chainId: 84532, campaign: campaignFor(null, rulesHash) }), /hub/);
});

// ─────────────────────────────── full table ───────────────────────────────

test('computeTable → verifyTable → claimFromTable', () => {
  const rules = buildRules(RULES_INPUT);
  const { rulesHash } = encodeRules(rules);
  const e18 = 10n ** 18n;
  const balances = [
    { account: A(1), balance: 100n * e18 }, // capped
    { account: A(2), balance: 10n * e18 },
    { account: A(3), balance: 50n * e18 }, // excluded by the rules
    { account: A(4), balance: 4n * e18 }, // under minBalance
    { account: A(5), balance: 30n * e18 }, // auto-excluded (say, an LP pool)
    { account: rules.hub, balance: 999n * e18 }, // the hub itself never qualifies
    { account: A(6), balance: 5n * e18 },
  ];
  const table = computeTable({ rules, rulesHash, campaignId: 2, block: { number: 123n, timestamp: 1_800_000_000n }, balances, autoExclude: [A(5)] });

  assert.equal(table.wallets, 3);
  assert.deepEqual(table.entries.map((e) => e.account), [A(1), A(2), A(6)]);
  assert.equal(table.entries[0].amount, (10n ** 17n).toString());
  // All three hit the 0.1 cap, so 0.3 of the 1.0 pool is allocated and the rest goes by the leftover rule.
  assert.equal(table.totalAllocated, (3n * 10n ** 17n).toString());
  assert.equal(table.snapshot.block, '123');
  assert.ok(verifyTable(table));

  const c = claimFromTable(table, A(2).toUpperCase().replace('0X', '0x'));
  assert.ok(c);
  assert.ok(verifyLikeContract(c.proof, table.merkleRoot, leafHash({ hub: rules.hub, chainId: 84532, campaignId: 2, account: A(2), amount: c.amount })));
  assert.equal(claimFromTable(table, A(3)), null);

  // The pinned table survives a JSON round trip.
  const copy = JSON.parse(JSON.stringify(table));
  assert.ok(verifyTable(copy));
  assert.equal(StandardMerkleTree.load(copy.tree).root, table.merkleRoot);

  // Tampering is caught.
  copy.entries[1].amount = (BigInt(copy.entries[1].amount) + 1n).toString();
  assert.throws(() => verifyTable(copy), /Root/);
});

test('no eligible wallets: nothing to publish', () => {
  const rules = buildRules(RULES_INPUT);
  assert.throws(
    () => computeTable({ rules, rulesHash: '0x', campaignId: 0, block: { number: 1n, timestamp: 1n }, balances: [h(1, 1)] }),
    /No eligible/
  );
});
