// Place indexer: hub and factory events into a real Postgres (PGlite), from a fake node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { pgliteAdapter, migrate } from '../api/_lib/place/db.js';
import { indexEvents, syncHubState } from '../api/_lib/place/indexer.js';
import { PLACE_HUB_ABI, NFT_FACTORY_ABI } from '../src/place/abi.js';
import { DEPLOYMENTS } from '../src/place/deployments.js';

const CHAIN = 84532;
const D = DEPLOYMENTS[CHAIN];
const HUB = D.hubs[0].address;
const FACTORY = D.nftFactory.address;
const START = D.hubs[0].startBlock;
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const ROOT = `0x${'ab'.repeat(32)}`;

let txn = 0;
function makeLog(abi, address, eventName, args, blockNumber, logIndex = 0) {
  const ev = abi.find((e) => e.type === 'event' && e.name === eventName);
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
  const plain = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [ev], eventName, args: indexed }),
    data: encodeAbiParameters(plain, plain.map((i) => args[i.name])),
    blockNumber,
    logIndex,
    transactionHash: `0x${(++txn).toString(16).padStart(64, '0')}`,
    transactionIndex: 0,
    blockHash: `0x${'0'.repeat(64)}`,
    removed: false,
  };
}
const hubLog = (name, args, block, i) => makeLog(PLACE_HUB_ABI, HUB, name, args, block, i);

function fakeNode({ logs, head, maxRange = Infinity, chainState = {} }) {
  const calls = { getLogs: 0, refused: 0 };
  return {
    calls,
    async getBlockNumber() {
      return head;
    },
    async getBlock({ blockNumber }) {
      return { number: blockNumber, timestamp: 1_800_000_000n + (blockNumber - START) * 2n };
    },
    async getLogs({ address, fromBlock, toBlock }) {
      calls.getLogs++;
      if (toBlock - fromBlock + 1n > maxRange) {
        calls.refused++;
        throw new Error(`eth_getLogs is limited to a ${maxRange} range`);
      }
      return logs.filter((l) => address.includes(l.address) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async multicall({ contracts }) {
      return contracts.map((c) => chainState[c.args[0].toString()]);
    },
  };
}

async function freshDb() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  return db;
}

const created = (id, extra = {}) => ({
  id,
  creator: A(0xc0),
  target: A(0x70),
  kind: 0,
  rewardToken: A(0x5e),
  pool: 1000n,
  fee: 50n,
  snapshotAt: 1_800_100_000n,
  claimDuration: 30 * 86400,
  burnLeftover: false,
  ...extra,
});

function lifecycleLogs() {
  const b = START + 100n;
  return [
    hubLog('CampaignCreated', created(0n), b, 0),
    hubLog('CampaignRules', { id: 0n, rulesHash: `0x${'11'.repeat(32)}`, rulesURI: 'ipfs://rules' }, b, 1),
    hubLog('MetadataUpdated', { id: 0n, metadataURI: 'ipfs://meta' }, b, 2),
    hubLog('CampaignCreated', created(1n, { burnLeftover: true }), b + 5n, 0),
    hubLog('CampaignCancelled', { id: 1n, poolReturned: 1000n, feeToTreasury: 50n }, b + 6n, 0),
    hubLog('RootPublished', { id: 0n, merkleRoot: ROOT, totalAllocated: 900n, claimEnd: 1_802_000_000n, proofsURI: 'ipfs://table' }, b + 20_000n, 0),
    hubLog('Claimed', { id: 0n, account: A(1), amount: 300n, caller: A(1) }, b + 20_010n, 0),
    hubLog('Claimed', { id: 0n, account: A(2), amount: 200n, caller: A(0xa9) }, b + 20_010n, 1),
    hubLog('ClaimExtended', { id: 0n, claimEnd: 1_803_000_000n }, b + 20_020n, 0),
    hubLog('Finalized', { id: 0n, leftover: 500n, burned: false }, b + 40_000n, 0),
    makeLog(NFT_FACTORY_ABI, FACTORY, 'CollectionCreated', { collection: A(0xc011), creator: A(0xc0), implementation: D.clubNftImplementation, feePaid: 7n * 10n ** 14n }, b + 7n, 0),
  ];
}

test('a campaign lifecycle and a collection land in the database', async () => {
  const db = await freshDb();
  const node = fakeNode({ logs: lifecycleLogs(), head: START + 50_000n });
  const r = await indexEvents({ db, client: node, chainId: CHAIN, confirmations: 3n });
  assert.equal(r.caughtUp, true);
  assert.equal(r.events, 11);

  const [c0] = await db.query(`select * from campaigns where campaign_id = 0`);
  assert.equal(c0.creator, A(0xc0));
  assert.equal(c0.pool, '1000');
  assert.equal(c0.rules_uri, 'ipfs://rules');
  assert.equal(c0.metadata_uri, 'ipfs://meta');
  assert.equal(c0.merkle_root, ROOT);
  assert.equal(c0.total_allocated, '900');
  assert.equal(c0.proofs_uri, 'ipfs://table');
  assert.equal(new Date(c0.claim_end).getTime() / 1000, 1_803_000_000);
  assert.equal(c0.claimed, '500');
  assert.equal(c0.stage, 'finalized');
  assert.equal(c0.leftover, '500');
  assert.equal(new Date(c0.created_at).getTime() / 1000, 1_800_000_200);

  const [c1] = await db.query(`select stage, burn_leftover from campaigns where campaign_id = 1`);
  assert.deepEqual(c1, { stage: 'cancelled', burn_leftover: true });

  const claims = await db.query(`select account, amount, caller from claims order by account`);
  assert.deepEqual(claims, [
    { account: A(1), amount: '300', caller: A(1) },
    { account: A(2), amount: '200', caller: A(0xa9) },
  ]);
  const [nft] = await db.query(`select address, creator, fee_paid from nft_collections`);
  assert.deepEqual(nft, { address: A(0xc011), creator: A(0xc0), fee_paid: '700000000000000' });
});

test('indexing the same range twice changes nothing', async () => {
  const db = await freshDb();
  const node = fakeNode({ logs: lifecycleLogs(), head: START + 50_000n });
  await indexEvents({ db, client: node, chainId: CHAIN });
  const before = await db.query(`select campaign_id, claimed, stage from campaigns order by campaign_id`);
  await db.query(`delete from indexer_cursors`);
  await indexEvents({ db, client: node, chainId: CHAIN });
  assert.deepEqual(await db.query(`select campaign_id, claimed, stage from campaigns order by campaign_id`), before);
  assert.equal((await db.query(`select count(*)::int as n from claims`))[0].n, 2);
});

test('a node with a small range limit: the range shrinks and everything is still indexed', async () => {
  const db = await freshDb();
  const node = fakeNode({ logs: lifecycleLogs(), head: START + 50_000n, maxRange: 200n });
  const r = await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 10_000n, budgetMs: 60_000 });
  assert.equal(r.caughtUp, true);
  assert.ok(node.calls.refused > 0);
  assert.equal((await db.query(`select stage from campaigns where campaign_id = 0`))[0].stage, 'finalized');
});

test('stops at the time budget and resumes from the cursor', async () => {
  const db = await freshDb();
  const node = fakeNode({ logs: lifecycleLogs(), head: START + 50_000n });
  const first = await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 1_000n, budgetMs: 0 });
  assert.equal(first.caughtUp, false);
  assert.equal(first.to, START - 1n);
  const second = await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 1_000n, budgetMs: 60_000 });
  assert.equal(second.from, START);
  assert.equal(second.caughtUp, true);
});

test('stays behind the head by the confirmations', async () => {
  const db = await freshDb();
  const node = fakeNode({ logs: [], head: START + 10n });
  const r = await indexEvents({ db, client: node, chainId: CHAIN, confirmations: 3n });
  assert.equal(r.to, START + 7n);
});

test('syncHubState fills what the logs missed, and a late Claimed event is not counted twice', async () => {
  const db = await freshDb();
  const b = START + 100n;
  const createdOnly = [hubLog('CampaignCreated', created(0n), b, 0)];
  await indexEvents({ db, client: fakeNode({ logs: createdOnly, head: b + 10n }), chainId: CHAIN, confirmations: 3n });

  const chainState = {
    0: {
      stage: 1,
      claimed: 300n,
      merkleRoot: ROOT,
      totalAllocated: 900n,
      claimEnd: 1_802_000_000n,
      proofsURI: 'ipfs://table',
      metadataURI: 'ipfs://meta',
    },
  };
  assert.equal(await syncHubState({ db, client: fakeNode({ logs: [], head: b, chainState }), chainId: CHAIN }), 1);
  let [c] = await db.query(`select claimed, merkle_root, total_allocated, proofs_uri, metadata_uri from campaigns`);
  assert.deepEqual(c, { claimed: '300', merkle_root: ROOT, total_allocated: '900', proofs_uri: 'ipfs://table', metadata_uri: 'ipfs://meta' });

  // The logs catch up later with the same claim.
  const late = [...createdOnly, hubLog('Claimed', { id: 0n, account: A(1), amount: 300n, caller: A(1) }, b + 20n, 0)];
  await indexEvents({ db, client: fakeNode({ logs: late, head: b + 40n }), chainId: CHAIN, confirmations: 3n });
  [c] = await db.query(`select claimed from campaigns`);
  assert.equal(c.claimed, '300');

  // A finalized campaign is no longer re-read.
  chainState[0] = { ...chainState[0], stage: 4 };
  await syncHubState({ db, client: fakeNode({ logs: [], head: b, chainState }), chainId: CHAIN });
  assert.equal(await syncHubState({ db, client: fakeNode({ logs: [], head: b, chainState }), chainId: CHAIN }), 0);
});
