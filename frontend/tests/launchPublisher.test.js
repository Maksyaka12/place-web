// The hub publisher and Place Launch creator-vault campaigns: the shared template is checked
// against rulesHash and the campaign against the template, then the root is published like any campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { runSnapshotJobs, enqueueDueJobs } from '../api/_lib/place/snapshotJob.js';
import { verifyTable } from '../src/place/snapshot/index.js';
import { freshDb, D, B20, CREATOR, TRADER, DEAD, ETH, TEMPLATE } from './launchFixture.js';

const CHAIN = 84532;
const ZERO_ROOT = `0x${'0'.repeat(64)}`;
const CREATED = 1_794_578_933; // campaign #1 creation block time
const SNAP = CREATED + 86400;
const HEAD = 9000n;
const blockTime = (n) => BigInt(SNAP - 1000) + n / 5n; // 200 ms blocks; SNAP at block 5000
const e18 = 10n ** 18n;

function world({ feeRecipient = B20.vault, claimDuration = 2_592_000, template = TEMPLATE } = {}) {
  const state = {
    creator: B20.vault,
    merkleRoot: ZERO_ROOT,
    claimed: 0n,
    kind: 0,
    target: B20.token,
    rewardToken: ETH,
    pool: 165350700000000n,
    snapshotAt: BigInt(SNAP),
    claimDuration,
    burnLeftover: true,
    rulesHash: D.launchRules[0].rulesHash,
    claimEnd: 0n,
  };
  const balances = { [CREATOR]: 509243n * e18, [TRADER]: 50892n * e18, [DEAD]: 28044n * e18, [D.poolManager]: 999000000n * e18, [B20.vault]: 1n };
  const sent = [];
  const pinned = new Map();
  const client = {
    async getBlock({ blockTag, blockNumber }) {
      const n = blockTag === 'latest' ? HEAD : blockNumber;
      return { number: n, timestamp: blockTime(n) };
    },
    async readContract({ functionName, args }) {
      if (functionName === 'getCampaign') return { ...state };
      if (functionName === 'creatorRights') {
        assert.equal(args[0].toLowerCase(), B20.token);
        return { creatorFeeRecipient: feeRecipient };
      }
      if (functionName === 'quote') return ETH;
      throw new Error(`unexpected ${functionName}`);
    },
    async multicall({ contracts }) {
      return contracts.map((c) => {
        if (c.functionName === 'balanceOf') return { status: 'success', result: balances[c.args[0]] ?? 0n };
        return { status: 'failure', error: new Error('no') }; // token0/token1: nobody is an AMM pair here
      });
    },
  };
  const fetchFn = async () => ({ ok: true, json: async () => ({ result: { transfers: Object.keys(balances).map((to) => ({ to, blockNum: '0x1' })) } }) });
  const ipfs = {
    async pin(text) {
      const uri = `ipfs://fake${keccak256(new TextEncoder().encode(text)).slice(2, 12)}`;
      pinned.set(uri, text);
      return uri;
    },
    async fetch(uri) {
      if (uri === D.launchRules[0].rulesURI) return template;
      if (pinned.has(uri)) return pinned.get(uri);
      throw new Error('gateway timeout');
    },
  };
  const publisher = {
    async publishRoot(a) {
      sent.push(a);
      state.merkleRoot = a.root;
      state.claimEnd = BigInt(SNAP + 200 + claimDuration);
      return `0x${'7'.repeat(64)}`;
    },
    async status() {
      return 'success';
    },
  };
  return { state, sent, pinned, deps: { client, fetchFn, alchemyKey: 'k', ipfs, publisher, receiptWaitMs: 0 } };
}

async function setup() {
  const db = await freshDb();
  await db.query(
    `insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at, claim_duration,
       burn_leftover, rules_hash, rules_uri, created_block, created_tx, created_at)
     values ($1, $2, 1, $3, 0, $4, $5, 165350700000000, 0, $6, 2592000, true, $7, $8, 1, '0x', $9)`,
    [CHAIN, D.hub, B20.vault, B20.token, ETH, new Date(SNAP * 1000).toISOString(), D.launchRules[0].rulesHash, D.launchRules[0].rulesURI, new Date(CREATED * 1000).toISOString()]
  );
  return db;
}
const now = () => new Date((SNAP + 600) * 1000);

test('a creator-vault campaign gets its root: template checked, launch pool and burn address excluded', async () => {
  const w = world();
  const db = await setup();
  const report = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now, budgetMs: 60_000 });
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.published.length, 1);
  assert.equal(w.sent.length, 1);
  const table = JSON.parse(w.pinned.get(w.sent[0].proofsURI));
  verifyTable(table);
  assert.equal(table.rulesHash, D.launchRules[0].rulesHash);
  assert.deepEqual(table.entries.map((e) => e.account).sort(), [CREATOR, TRADER].sort(), 'pool, vault and burn address get nothing');
  assert.equal(table.totalAllocated, '165350700000000');
  const [job] = await db.query('select status, rules_json from snapshot_jobs');
  assert.equal(job.status, 'published');
  assert.equal(JSON.parse(job.rules_json).schema, 'place.rules/1');
  const [c] = await db.query('select merkle_root from campaigns');
  assert.equal(c.merkle_root, w.sent[0].root);
});

test('a campaign that disagrees with the template, or not from the token vault, is rejected', async () => {
  for (const [opts, reason] of [
    [{ claimDuration: 86400 }, /claimDuration/],
    [{ feeRecipient: CREATOR }, /not the launch token creator vault/],
    [{ template: TEMPLATE.replace('"burn"', '"return"') }, /rulesHash/],
  ]) {
    const w = world(opts);
    const db = await setup();
    const report = await runSnapshotJobs({ deps: { ...w.deps, db }, chainId: CHAIN, now, budgetMs: 60_000 });
    assert.equal(report.rejected.length, 1, JSON.stringify(report));
    assert.match(report.rejected[0].reason, reason);
    assert.match(report.rejected[0].reason, /^Launch rules:/);
    assert.equal(w.sent.length, 0);
  }
});

test('a vault campaign rejected by the old publisher gets one more go; new rejections stay', async () => {
  const db = await setup();
  await db.query(`insert into snapshot_jobs (campaign_pk, status, step, error) select pk, 'rejected', 'rules', 'Invalid rules: schema must be place.rules/1' from campaigns`);
  await enqueueDueJobs(db, CHAIN, now());
  assert.deepEqual(await db.query('select status, step, error from snapshot_jobs'), [{ status: 'running', step: 'rules', error: null }]);
  await db.query(`update snapshot_jobs set status = 'rejected', error = 'Launch rules: campaign disagrees with the template'`);
  await enqueueDueJobs(db, CHAIN, now());
  assert.equal((await db.query('select status from snapshot_jobs'))[0].status, 'rejected');
});
