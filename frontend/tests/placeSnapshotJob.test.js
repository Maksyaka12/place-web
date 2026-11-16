// Place snapshot service: a job from a due campaign to a published root, on PGlite with a fake chain,
// a fake Alchemy, a fake IPFS and a fake publisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { keccak256, concatHex } from 'viem';
import { pgliteAdapter, migrate } from '../api/_lib/place/db.js';
import { runSnapshotJobs, proofFromDb, acquireLease } from '../api/_lib/place/snapshotJob.js';
import { buildRules, encodeRules, leafHash, verifyTable } from '../src/place/snapshot/index.js';

const CHAIN = 84532;
const HUB = '0x493f55975bff2e4f111bad8d51637f3b9763bdd1';
const TOKEN = '0x7000000000000000000000000000000000000007';
const LP = '0x1b00000000000000000000000000000000000001';
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const ZERO_ROOT = `0x${'0'.repeat(64)}`;
const SNAP = 1_800_000_000; // snapshotAt
const e18 = 10n ** 18n;

// Chain: block n at time SNAP - 1000 + 2n, head far past the snapshot.
const HEAD = 5000n;
const blockTime = (n) => BigInt(SNAP - 1000) + 2n * n;
const SNAP_BLOCK = 500n; // SNAP - 1000 + 1000 = SNAP

function world({ balances, pages, rulesText, rulesHash, pool = 1000n * e18, burn = false, kind = 0, owners = {} }) {
  const state = {
    merkleRoot: ZERO_ROOT,
    claimed: 0n,
    kind,
    target: TOKEN,
    rewardToken: '0x0000000000000000000000000000000000000000',
    pool,
    snapshotAt: BigInt(SNAP),
    claimDuration: 30 * 86400,
    burnLeftover: burn,
    rulesHash,
    claimEnd: 0n,
  };
  const sent = [];
  const pinned = new Map();
  const blocksRead = new Set();
  const client = {
    async getBlock({ blockTag, blockNumber }) {
      const n = blockTag === 'latest' ? HEAD : blockNumber;
      return { number: n, timestamp: blockTime(n) };
    },
    async readContract({ functionName }) {
      assert.equal(functionName, 'getCampaign');
      return { ...state };
    },
    async multicall({ contracts, blockNumber }) {
      blocksRead.add(blockNumber);
      return contracts.map((c) => {
        if (c.functionName === 'balanceOf') return { status: 'success', result: balances[c.args[0]] ?? 0n };
        if (c.functionName === 'ownerOf') {
          const o = owners[c.args[0].toString()];
          return o ? { status: 'success', result: o } : { status: 'failure', error: new Error('nonexistent') };
        }
        if (c.functionName === 'token0' || c.functionName === 'token1') {
          return c.address === LP ? { status: 'success', result: TOKEN } : { status: 'failure', error: new Error('no') };
        }
        throw new Error(`unexpected ${c.functionName}`);
      });
    },
  };
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body).params[0];
    assert.equal(BigInt(p.toBlock), SNAP_BLOCK, 'transfers are read up to the snapshot block');
    const i = p.pageKey ? Number(p.pageKey) : 0;
    const transfers = pages[i].map((x) =>
      typeof x === 'object' ? { to: x.to, tokenId: `0x${x.id.toString(16)}`, blockNum: '0x1' } : { to: x, blockNum: '0x1' }
    );
    return { ok: true, json: async () => ({ result: { transfers, pageKey: i + 1 < pages.length ? String(i + 1) : undefined } }) };
  };
  const ipfs = {
    async pin(text, name) {
      const uri = `ipfs://fake${keccak256(new TextEncoder().encode(text)).slice(2, 12)}`;
      pinned.set(uri, { text, name });
      return uri;
    },
    async fetch(uri) {
      if (uri === 'ipfs://rules') return rulesText;
      if (pinned.has(uri)) return pinned.get(uri).text;
      throw new Error('gateway timeout');
    },
  };
  const publisher = {
    address: A(0x9b),
    async publishRoot(args) {
      sent.push(args);
      state.merkleRoot = args.root;
      state.claimEnd = BigInt(SNAP + 100 + 30 * 86400);
      return `0x${'7'.repeat(64)}`;
    },
    async status() {
      return 'success';
    },
  };
  return { state, sent, pinned, blocksRead, deps: { client, fetchFn, alchemyKey: 'k', ipfs, publisher, receiptWaitMs: 0 } };
}

function rulesFor(patch = {}) {
  const rules = buildRules({
    chainId: CHAIN,
    hub: HUB,
    kind: 'token-holders',
    target: TOKEN,
    rewardToken: 'eth',
    pool: 1000n * e18,
    snapshotAt: SNAP,
    claimDuration: 30 * 86400,
    minBalance: 10n * e18,
    distribution: 'proportional',
    maxPerWallet: 400n * e18,
    exclude: [A(4)],
    leftover: 'return',
    ...patch,
  });
  return encodeRules(rules);
}

async function setup({ rulesHash, kind = 0 }) {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  await db.query(
    `insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at,
       claim_duration, burn_leftover, rules_hash, rules_uri, created_block, created_tx, created_at)
     values ($1, $2, 5, $3, $4, $5, $6, $7, 0, $8, $9, false, $10, 'ipfs://rules', 1, '0x', now())`,
    [CHAIN, HUB, A(0xc0), kind, TOKEN, '0x0000000000000000000000000000000000000000', (1000n * e18).toString(), new Date(SNAP * 1000).toISOString(), 30 * 86400, rulesHash]
  );
  return db;
}

const now = () => new Date((SNAP + 60) * 1000);

test('token holders: from a due campaign to a published root, with proofs from the database', async () => {
  const { json, rulesHash } = rulesFor();
  const balances = {
    [A(1)]: 500n * e18, // capped at 400
    [A(2)]: 300n * e18,
    [A(3)]: 5n * e18, // under the minimum
    [A(4)]: 900n * e18, // excluded by the rules
    [LP]: 2000n * e18, // an AMM pool: auto-excluded
    [HUB]: 100n * e18, // the hub never qualifies
    [A(6)]: 200n * e18,
  };
  const w = world({ balances, pages: [[A(1), A(2), A(3)], [A(4), LP, HUB, A(6), A(1), '0x0000000000000000000000000000000000000000']], rulesText: json, rulesHash });
  const db = await setup({ rulesHash });

  const report = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now, budgetMs: 60_000 });
  assert.equal(report.enqueued, 1);
  assert.deepEqual(report.errors, []);
  assert.equal(report.published.length, 1);
  assert.deepEqual([...w.blocksRead], [SNAP_BLOCK], 'every balance is read at the snapshot block');

  // What went on chain.
  assert.equal(w.sent.length, 1);
  const [sent] = w.sent;
  assert.equal(sent.hub, HUB);
  assert.equal(sent.campaignId, '5');
  // 1000 among A1 (500), A2 (300), A6 (200) with a 400 cap: A1 400, then 600 over 300/200 → 360 / 240.
  assert.equal(sent.totalAllocated, (1000n * e18).toString());

  // The pinned table is the one published, and it checks out.
  const table = JSON.parse(w.pinned.get(sent.proofsURI).text);
  assert.equal(table.merkleRoot, sent.root);
  assert.ok(verifyTable(table));
  assert.deepEqual(table.entries.map((e) => [e.account, BigInt(e.amount) / e18]), [[A(1), 400n], [A(2), 360n], [A(6), 240n]]);

  // Stored rows give proofs the contract accepts.
  const [{ pk }] = await db.query('select pk::text as pk from campaigns');
  const rows = await db.query('select account, amount::text as amount, leaf_index from allocations where campaign_pk = $1 order by account', [pk]);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    let h = leafHash({ hub: HUB, chainId: CHAIN, campaignId: 5, account: r.account, amount: BigInt(r.amount) });
    for (const p of await proofFromDb(db, pk, r.leaf_index)) h = h < p ? keccak256(concatHex([h, p])) : keccak256(concatHex([p, h]));
    assert.equal(h, sent.root);
  }

  // The campaign row is updated and the working sets are gone.
  const [c] = await db.query('select merkle_root, total_allocated::text as t, proofs_uri from campaigns');
  assert.deepEqual(c, { merkle_root: sent.root, t: (1000n * e18).toString(), proofs_uri: sent.proofsURI });
  const [left] = await db.query(`select (select count(*)::int from snapshot_candidates) + (select count(*)::int from snapshot_balances) as n`);
  assert.equal(left.n, 0);

  // A second run does nothing.
  const again = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now, budgetMs: 60_000 });
  assert.equal(again.enqueued, 0);
  assert.equal(w.sent.length, 1);
});

test('rules that do not match the campaign: rejected, nothing published', async () => {
  const { json } = rulesFor({ pool: 999n * e18 }); // the pinned rules say 999, the hub holds 1000
  const { rulesHash } = rulesFor({ pool: 999n * e18 });
  const w = world({ balances: { [A(1)]: 50n * e18 }, pages: [[A(1)]], rulesText: json, rulesHash });
  const db = await setup({ rulesHash });
  const r = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /pool/);
  assert.equal(w.sent.length, 0);
  const [j] = await db.query('select status from snapshot_jobs');
  assert.equal(j.status, 'rejected');
});

test('rules pinned under a different hash: rejected', async () => {
  const { json } = rulesFor();
  const w = world({ balances: {}, pages: [[]], rulesText: json.replace('proportional', 'equal'), rulesHash: rulesFor().rulesHash });
  const db = await setup({ rulesHash: rulesFor().rulesHash });
  const r = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.match(r.rejected[0].reason, /rulesHash/);
});

test('nobody eligible: rejected, the creator refunds after 72 h', async () => {
  const { json, rulesHash } = rulesFor();
  const w = world({ balances: { [A(1)]: 1n }, pages: [[A(1)]], rulesText: json, rulesHash });
  const db = await setup({ rulesHash });
  const r = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.match(r.rejected[0].reason, /No eligible/);
  assert.equal(w.sent.length, 0);
});

test('a gateway failure is retried on the next run, not a rejection', async () => {
  const { json, rulesHash } = rulesFor();
  const w = world({ balances: { [A(1)]: 50n * e18 }, pages: [[A(1)]], rulesText: json, rulesHash });
  const db = await setup({ rulesHash });
  const realFetch = w.deps.ipfs.fetch;
  w.deps.ipfs.fetch = async () => {
    throw new Error('gateway timeout');
  };
  const r1 = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r1.errors.length, 1);
  assert.equal((await db.query('select status, attempts from snapshot_jobs'))[0].attempts, 1);
  w.deps.ipfs.fetch = realFetch;
  const r2 = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r2.published.length, 1);
});

test('waits until the chain is 2 minutes past the snapshot block before reading transfers', async () => {
  const { json, rulesHash } = rulesFor();
  const w = world({ balances: { [A(1)]: 50n * e18 }, pages: [[A(1)]], rulesText: json, rulesHash });
  const head = { n: SNAP_BLOCK + 10n };
  const getBlock = w.deps.client.getBlock;
  w.deps.client.getBlock = async (a) => (a.blockTag === 'latest' ? { number: head.n, timestamp: blockTime(head.n) } : getBlock(a));
  const db = await setup({ rulesHash });
  const r1 = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r1.published.length, 0);
  assert.equal((await db.query('select step from snapshot_jobs'))[0].step, 'block');
  head.n = SNAP_BLOCK + 60n; // 2 s blocks in this fake chain: 120 s later
  const r2 = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r2.published.length, 1);
});

test('not due yet: no job', async () => {
  const { json, rulesHash } = rulesFor();
  const w = world({ balances: {}, pages: [[]], rulesText: json, rulesHash });
  const db = await setup({ rulesHash });
  const r = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now: () => new Date((SNAP - 1) * 1000) });
  assert.equal(r.enqueued, 0);
});

test('a root already on chain (published earlier) ends the job without sending again', async () => {
  const { json, rulesHash } = rulesFor();
  const w = world({ balances: { [A(1)]: 50n * e18 }, pages: [[A(1)]], rulesText: json, rulesHash });
  w.state.merkleRoot = `0x${'cd'.repeat(32)}`;
  const db = await setup({ rulesHash });
  await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(w.sent.length, 0);
  assert.equal((await db.query('select status from snapshot_jobs'))[0].status, 'published');
});

test('NFT holders: counts per owner from ownerOf at the snapshot block', async () => {
  const { json, rulesHash } = rulesFor({ kind: 'nft-holders', minBalance: 1n, maxPerWallet: null, distribution: 'equal', exclude: [] });
  const owners = { 1: A(1), 2: A(1), 3: A(2), 4: LP };
  const pages = [[{ to: A(1), id: 1n }, { to: A(1), id: 2n }], [{ to: A(9), id: 3n }, { to: A(2), id: 3n }, { to: LP, id: 4n }, { to: A(3), id: 5n }]];
  const w = world({ balances: {}, pages, rulesText: json, rulesHash, kind: 1, owners });
  const db = await setup({ rulesHash, kind: 1 });
  const r = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now });
  assert.equal(r.published.length, 1);
  const table = JSON.parse(w.pinned.get(w.sent[0].proofsURI).text);
  assert.deepEqual(table.entries.map((e) => [e.account, e.balance, BigInt(e.amount) / e18]), [[A(1), '2', 500n], [A(2), '1', 500n]]);
});

test('only one run at a time holds the lease', async () => {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  assert.equal(await acquireLease(db, 'x', 'a', 60_000), true);
  assert.equal(await acquireLease(db, 'x', 'b', 60_000), false);
  assert.equal(await acquireLease(db, 'x', 'a', 60_000), true, 'the holder can renew');
});
