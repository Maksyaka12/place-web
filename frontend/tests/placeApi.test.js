// Place public API on PGlite: lists, detail with proofs, claims with a ready claimMany, uploads, moderation,
// holders preview. Chain, IPFS and Alchemy are fakes; tables come from the real snapshot engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { keccak256, concatHex, decodeFunctionData, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pgliteAdapter, migrate } from '../api/_lib/place/db.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { storeTable } from '../api/_lib/place/snapshotJob.js';
import { buildRules, encodeRules, computeTable, leafHash } from '../src/place/snapshot/index.js';
import { moderationMessage } from '../src/place/moderation.js';
import { PLACE_HUB_ABI } from '../src/place/abi.js';

const CHAIN = 84532;
const HUB = '0x493f55975bff2e4f111bad8d51637f3b9763bdd1';
const TOKEN = '0x7000000000000000000000000000000000000007';
const USDC = '0x5000000000000000000000000000000000000005';
const LP = '0x1b00000000000000000000000000000000000001';
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const NOW = 1_800_000_000;
const DAY = 86400;
const ADMIN_KEY = `0x${'11'.repeat(32)}`;
const admin = privateKeyToAccount(ADMIN_KEY);
process.env.PLACE_ADMINS = admin.address;

function fakeClient(state = {}) {
  return {
    async multicall({ contracts }) {
      return contracts.map((c) => {
        const fn = c.functionName;
        if (fn === 'isClaimed') return Boolean(state.claimed?.has(`${c.args[0]}:${c.args[1]}`));
        if (fn === 'name') return { status: 'success', result: c.address === TOKEN ? 'Test Token' : 'USD Coin' };
        if (fn === 'symbol') return { status: 'success', result: c.address === TOKEN ? 'TEST' : 'USDC' };
        if (fn === 'decimals') return { status: 'success', result: c.address === TOKEN ? 18 : 6 };
        if (fn === 'supportsInterface') return { status: 'failure', error: new Error('no') };
        if (fn === 'balanceOf') return { status: 'success', result: state.balances?.[c.args[0]] ?? 0n };
        if (fn === 'token0' || fn === 'token1') return c.address === LP ? { status: 'success', result: TOKEN } : { status: 'failure', error: new Error('no') };
        throw new Error(`unexpected ${fn}`);
      });
    },
    async getBlock() {
      return { number: 900n, timestamp: BigInt(NOW) };
    },
    async getCode({ address }) {
      return state.codes?.[address] ?? '0x';
    },
    verifyMessage: (args) => verifyMessage(args),
  };
}

async function setup(clientState) {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const pinned = [];
  const client = fakeClient(clientState);
  const deps = {
    db,
    client: () => client,
    alchemyKey: 'k',
    fetchFn: async () => ({ ok: true, json: async () => ({ result: { transfers: (clientState?.receivers || []).map((to) => ({ to, blockNum: '0x1' })) } }) }),
    pin: async (bytes, opts) => {
      pinned.push({ bytes, opts });
      return `ipfs://pinned${pinned.length}`;
    },
    now: () => NOW,
  };
  return { db, deps, pinned };
}

/** A campaign row; with `table` it gets a published root and stored allocations. */
async function addCampaign(db, id, { snapshotAt, claimEnd = null, stage = 'open', reward = USDC, balances = null, hidden = false } = {}) {
  const rules = buildRules({
    chainId: CHAIN, hub: HUB, kind: 'token-holders', target: TOKEN, rewardToken: reward === 'eth' ? 'eth' : reward, pool: 1000n,
    snapshotAt, claimDuration: 30 * DAY, minBalance: 1n, distribution: 'proportional', maxPerWallet: null, exclude: [], leftover: 'return',
  });
  const { rulesHash } = encodeRules(rules);
  const table = balances
    ? computeTable({ rules, rulesHash, campaignId: id, block: { number: 1n, timestamp: BigInt(snapshotAt) }, balances: Object.entries(balances).map(([account, balance]) => ({ account, balance })) })
    : null;
  const [{ pk }] = await db.query(
    `insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at, claim_duration,
       burn_leftover, rules_hash, rules_uri, merkle_root, total_allocated, claim_end, proofs_uri, stage, hidden, created_block, created_tx, created_at)
     values ($1, $2, $3, $4, 0, $5, $6, 1000, 50, $7, $8, false, $9, 'ipfs://rules', $10, $11, $12, $13, $14, $15, 1, '0xtx', $16) returning pk::text as pk`,
    [
      CHAIN, HUB, id, A(0xc0), TOKEN, reward === 'eth' ? '0x0000000000000000000000000000000000000000' : reward,
      new Date(snapshotAt * 1000).toISOString(), 30 * DAY, rulesHash, table?.merkleRoot ?? null, table?.totalAllocated ?? null,
      claimEnd ? new Date(claimEnd * 1000).toISOString() : null, table ? 'ipfs://table' : null, stage, hidden, new Date((NOW - 1000 + id) * 1000).toISOString(),
    ]
  );
  if (table) await storeTable(db, pk, table);
  return { pk, table };
}

const get = (deps, path, query) => handlePlace({ method: 'GET', path, query }, deps);
const post = (deps, path, body, ip = '1.2.3.4') => handlePlace({ method: 'POST', path, body, ip }, deps);

function verify(proof, root, leaf) {
  let h = leaf;
  for (const p of proof) h = h < p ? keccak256(concatHex([h, p])) : keccak256(concatHex([p, h]));
  return h === root;
}

test('campaigns: status filters, hidden ones left out, token names filled in', async () => {
  const { db, deps } = await setup();
  await addCampaign(db, 0, { snapshotAt: NOW + DAY }); // scheduled
  await addCampaign(db, 1, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [A(1)]: 5n } }); // live
  await addCampaign(db, 2, { snapshotAt: NOW - 40 * DAY, claimEnd: NOW - DAY, balances: { [A(1)]: 5n } }); // ended
  await addCampaign(db, 3, { snapshotAt: NOW - 4 * DAY }); // no root after 72 h: refundable (ended)
  await addCampaign(db, 4, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [A(1)]: 5n }, hidden: true });
  await addCampaign(db, 5, { snapshotAt: NOW - 3600 }); // snapshotting (upcoming)

  const ids = async (status) => (await get(deps, 'campaigns', { chain: CHAIN, status })).body.campaigns.map((c) => [c.id, c.status]);
  assert.deepEqual(await ids('live'), [['1', 'live']]);
  assert.deepEqual(await ids('upcoming'), [['5', 'snapshotting'], ['0', 'scheduled']]);
  assert.deepEqual((await ids('ended')).sort(), [['2', 'ended'], ['3', 'refundable']]);
  assert.equal((await ids('all')).length, 5);

  const r = await get(deps, 'campaigns', { chain: CHAIN, status: 'live' });
  assert.equal(r.status, 200);
  const c = r.body.campaigns[0];
  assert.deepEqual(c.targetMeta, { name: 'Test Token', symbol: 'TEST', decimals: 18 });
  assert.deepEqual(c.rewardMeta, { name: 'USD Coin', symbol: 'USDC', decimals: 6 });
  assert.equal(c.pool, '1000');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');

  const paged = await get(deps, 'campaigns', { chain: CHAIN, limit: 2 });
  assert.equal(paged.body.campaigns.length, 2);
  assert.equal(paged.body.nextOffset, 2);
  assert.equal((await get(deps, 'campaigns', { chain: CHAIN, status: 'soon' })).status, 400);
  assert.equal((await get(deps, 'campaigns', { chain: 1 })).status, 400);
});

test('campaign detail: stats and the caller’s proof, which the contract would accept', async () => {
  const { db, deps } = await setup();
  const { table } = await addCampaign(db, 7, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [A(1)]: 3n, [A(2)]: 1n } });
  const r = await get(deps, 'campaign', { chain: CHAIN, hub: HUB, id: 7, address: A(2) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stats, { wallets: 2, claims: 0 });
  assert.equal(r.body.campaign.status, 'live');
  assert.equal(r.body.you.amount, '250');
  assert.ok(verify(r.body.you.proof, table.merkleRoot, leafHash({ hub: HUB, chainId: CHAIN, campaignId: 7, account: A(2), amount: 250n })));
  assert.deepEqual((await get(deps, 'campaign', { chain: CHAIN, hub: HUB, id: 7, address: A(9) })).body.you, { eligible: false });
  assert.equal((await get(deps, 'campaign', { chain: CHAIN, id: 99 })).status, 404);
});

test('claims: claimable with proofs and one claimMany per hub; claimed and expired apart', async () => {
  const me = A(1);
  const { db, deps } = await setup({ claimed: new Set([`11:${me}`]) }); // the chain says campaign 11 is claimed
  await addCampaign(db, 10, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [me]: 1n, [A(2)]: 1n } });
  await addCampaign(db, 11, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [me]: 1n } });
  const { pk: pk12 } = await addCampaign(db, 12, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [me]: 3n, [A(2)]: 1n }, reward: 'eth' });
  await addCampaign(db, 13, { snapshotAt: NOW - 40 * DAY, claimEnd: NOW - DAY, balances: { [me]: 1n } });
  await db.query(`insert into claims (campaign_pk, account, amount, caller, tx, block) values ($1, $2, 750, $2, '0xclaimtx', 5)`, [pk12, me]);

  const r = await get(deps, 'claims', { chain: CHAIN, address: me });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.claimable.map((c) => [c.id, c.amount]), [['10', '500']]);
  assert.deepEqual(r.body.claimed.map((c) => [c.id, c.claimTx]).sort(), [['11', null], ['12', '0xclaimtx']]);
  assert.deepEqual(r.body.expired.map((c) => c.id), ['13']);

  assert.equal(r.body.transactions.length, 1);
  const tx = r.body.transactions[0];
  assert.equal(tx.to, HUB);
  const { functionName, args } = decodeFunctionData({ abi: PLACE_HUB_ABI, data: tx.data });
  assert.equal(functionName, 'claimMany');
  assert.equal(args[0].toLowerCase(), me);
  assert.deepEqual(args[1], [10n]);
  assert.deepEqual(args[2], [500n]);
  assert.deepEqual(args[3], [r.body.claimable[0].proof]);
  assert.equal((await get(deps, 'claims', { chain: CHAIN, address: 'nope' })).status, 400);
});

test('pin: canonical rules with their hash, metadata, images, and a per-IP limit', async () => {
  const { deps, pinned } = await setup();
  const rules = buildRules({
    chainId: CHAIN, hub: HUB, kind: 'token-holders', target: TOKEN, rewardToken: 'eth', pool: 10n, snapshotAt: NOW + DAY,
    claimDuration: DAY, minBalance: 1n, distribution: 'equal', maxPerWallet: null, exclude: [], leftover: 'burn',
  });
  const r = await post(deps, 'pin', { kind: 'rules', content: rules });
  assert.equal(r.status, 200);
  assert.equal(r.body.rulesHash, encodeRules(rules).rulesHash);
  assert.equal(pinned[0].bytes, encodeRules(rules).json, 'exactly the canonical bytes are pinned');

  assert.equal((await post(deps, 'pin', { kind: 'rules', content: { ...rules, pool: '0' } })).status, 400);
  assert.match((await post(deps, 'pin', { kind: 'rules', content: { ...rules, hub: A(5) } })).body.error, /unknown hub/);

  const m = await post(deps, 'pin', { kind: 'metadata', content: { name: ' Season 1 ', description: 'Holders of TEST', image: 'ipfs://bafyimage' } });
  assert.equal(m.status, 200);
  assert.equal(pinned.at(-1).bytes, '{"description":"Holders of TEST","image":"ipfs://bafyimage","name":"Season 1"}');
  assert.equal((await post(deps, 'pin', { kind: 'metadata', content: { name: '' } })).status, 400);
  assert.equal((await post(deps, 'pin', { kind: 'metadata', content: { name: 'x', image: 'https://evil' } })).status, 400);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  assert.equal((await post(deps, 'pin', { kind: 'image', contentType: 'image/png', data: png })).status, 200);
  assert.equal(pinned.at(-1).opts.contentType, 'image/png');
  assert.equal((await post(deps, 'pin', { kind: 'image', contentType: 'text/html', data: png })).status, 400);
  assert.equal((await post(deps, 'pin', { kind: 'image', contentType: 'image/png', data: Buffer.alloc(700 * 1024).toString('base64') })).status, 400);

  for (let i = 0; i < 30; i++) await post(deps, 'pin', { kind: 'metadata', content: { name: `n${i}` } }, '9.9.9.9');
  assert.equal((await post(deps, 'pin', { kind: 'metadata', content: { name: 'one more' } }, '9.9.9.9')).status, 429);
  assert.equal((await post(deps, 'pin', { kind: 'metadata', content: { name: 'other ip' } }, '8.8.8.8')).status, 200);
});

test('moderation: only a Place admin with a fresh signature, and hiding never touches claims', async () => {
  const { db, deps } = await setup();
  await addCampaign(db, 20, { snapshotAt: NOW - DAY, claimEnd: NOW + DAY, balances: { [A(1)]: 1n } });
  const issuedAt = new Date(NOW * 1000).toISOString();
  const signed = async (fields, signer = admin) => {
    const body = { chainId: CHAIN, admin: signer.address, issuedAt, ...fields };
    return { ...body, signature: await signer.signMessage({ message: moderationMessage({ ...body, admin: signer.address }) }) };
  };

  const hide = await post(deps, 'admin/hide', await signed({ action: 'hide', type: 'campaign', target: `${HUB}:20` }));
  assert.equal(hide.status, 200);
  assert.equal((await get(deps, 'campaigns', { chain: CHAIN })).body.campaigns.length, 0);
  assert.equal((await get(deps, 'claims', { chain: CHAIN, address: A(1) })).body.claimable.length, 1, 'still claimable when hidden');

  const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  assert.equal((await post(deps, 'admin/hide', await signed({ action: 'hide', type: 'asset', target: TOKEN }, stranger))).status, 403);
  const forged = await signed({ action: 'hide', type: 'asset', target: TOKEN });
  assert.equal((await post(deps, 'admin/hide', { ...forged, target: USDC })).status, 401, 'signature covers the target');
  const old = await signed({ action: 'hide', type: 'asset', target: TOKEN, issuedAt: new Date((NOW - 3600) * 1000).toISOString() });
  assert.equal((await post(deps, 'admin/hide', old)).status, 401);

  assert.equal((await post(deps, 'admin/hide', await signed({ action: 'unhide', type: 'campaign', target: `${HUB}:20` }))).status, 200);
  assert.equal((await post(deps, 'admin/hide', await signed({ action: 'hide', type: 'asset', target: TOKEN }))).status, 200);
  assert.equal((await get(deps, 'campaigns', { chain: CHAIN })).body.campaigns.length, 0, 'a hidden token hides its campaigns');
  assert.equal((await get(deps, 'token', { chain: CHAIN, address: TOKEN })).body.hidden, true);
});

test('holders preview: top holders with wallet / contract / 7702 types and automatic exclusions', async () => {
  const VAULT = A(0xa0);
  const SMART = A(0x77);
  const balances = { [A(1)]: 50n, [VAULT]: 900n, [SMART]: 30n, [LP]: 2000n, [A(2)]: 1n };
  const { deps } = await setup({
    receivers: [A(1), VAULT, SMART, LP, A(2), A(1)],
    balances,
    codes: { [VAULT]: '0x6080604052', [LP]: '0x6080', [SMART]: `0xef0100${'ab'.repeat(20)}` },
  });
  const r = await get(deps, 'holders', { chain: CHAIN, target: TOKEN, min: '10' });
  assert.equal(r.status, 200);
  assert.equal(r.body.holders, 4);
  assert.equal(r.body.partial, false);
  assert.deepEqual(
    r.body.top.map((h) => [h.account, h.balance, h.type, h.autoExcluded]),
    [
      [LP, '2000', 'contract', true],
      [VAULT, '900', 'contract', false],
      [A(1), '50', 'wallet', false],
      [SMART, '30', 'smart-account', false],
    ]
  );
});

test('token page, routing and CORS preflight', async () => {
  const { db, deps } = await setup();
  await addCampaign(db, 30, { snapshotAt: NOW + DAY });
  const t = await get(deps, 'token', { chain: CHAIN, address: TOKEN });
  assert.equal(t.body.symbol, 'TEST');
  assert.equal(t.body.campaigns.length, 1);
  assert.equal((await handlePlace({ method: 'GET', path: 'nope', query: {} }, deps)).status, 404);
  assert.equal((await handlePlace({ method: 'OPTIONS', path: 'campaigns', query: {} }, deps)).status, 204);
  assert.equal((await get(deps, 'collections', { chain: CHAIN })).body.collections.length, 0);
});
