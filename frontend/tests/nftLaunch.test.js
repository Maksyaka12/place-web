// NFT launchpad (PlaceNftFactory 0.3.1) on the site's backend: indexing a collection's life (creation, mints,
// transfers, the holders pool, claims, burns, settings), the collection endpoints, the "not deployed yet" answers,
// and Register token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { indexEvents } from '../api/_lib/place/indexer.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { poolState, mintStatus, ACC } from '../api/_lib/launch/nft.js';
import { externalTarget } from '../api/_lib/launch/rewardsPublisher.js';
import { decideRegistration, tokenLiquidityUsd } from '../api/_lib/launch/projects.js';
import { registerMessage } from '../src/launch/projects.js';
import { NFT_FACTORY_ABI, NFT_COLLECTION_ABI } from '../src/launch/nftAbi.js';
import { launchDeployment, nftDeployment } from '../src/launch/deployments.js';
import { DEFAULT_ADMINS } from '../src/place/moderation.js';
import { fakeNode, freshDb, CHAIN, CREATOR, TRADER, ETH, timeOf } from './launchFixture.js';

const e18 = 10n ** 18n;
const FACTORY = `0x${'f7'.repeat(20)}`;
const COLLECTION = `0x${'c0'.repeat(20)}`;
const PAIR = `0x${'a1'.repeat(20)}`;
const MINTER = `0x${'b1'.repeat(20)}`;
const N0 = 59_800_000n;
const PRICE = 10n ** 15n; // 0.001 ETH
const NFT_EVENTS = [...NFT_FACTORY_ABI, ...NFT_COLLECTION_ABI].filter((x) => x.type === 'event');

function builder() {
  const logs = [];
  const senders = new Map();
  let n = 0;
  let tx = null;
  let index = 0;
  return {
    logs,
    senders,
    tx(block, from) {
      tx = { hash: `0x${(++n).toString(16).padStart(64, 'e')}`, block };
      senders.set(tx.hash, from);
      index = 0;
    },
    log(address, eventName, args, abi = NFT_EVENTS) {
      const ev = abi.find((e) => e.name === eventName && e.inputs.every((i) => i.name in args) && e.inputs.length === Object.keys(args).length);
      if (!ev) throw new Error(`no event ${eventName}`);
      const plain = ev.inputs.filter((i) => !i.indexed);
      logs.push({
        address,
        topics: encodeEventTopics({ abi: [ev], eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) }),
        data: encodeAbiParameters(plain, plain.map((i) => args[i.name])),
        blockNumber: tx.block,
        logIndex: index++,
        transactionHash: tx.hash,
        transactionIndex: 0,
        blockHash: `0x${'0'.repeat(64)}`,
        removed: false,
      });
    },
  };
}

const RATE = (9n * PRICE * ACC) / 100n / 30n; // what HoldersFunded carries for 0.0009 ETH... over 30 days
const DAY = (b) => BigInt(Math.floor(Number(timeOf(b)) / 86400));

function collectionLife() {
  const b = builder();
  b.tx(N0 + 10n, CREATOR);
  b.log(COLLECTION, 'OwnershipTransferred', { previousOwner: ETH, newOwner: CREATOR });
  b.log(COLLECTION, 'CollectionInitialized', { creator: CREATOR, token: PAIR, rewardToken: ETH, official: true, kind: 0 });
  b.log(FACTORY, 'CollectionCreated', { collection: COLLECTION, creator: CREATOR, token: PAIR, official: true, kind: 0, index: 0n });
  // First mint: 2 NFTs for 0.002 ETH; nobody holds yet, so the holders share goes to the creator.
  b.tx(N0 + 20n, MINTER);
  b.log(COLLECTION, 'RevenueSplit', { asset: ETH, platform: 4n * 10n ** 14n, creator: 12n * 10n ** 14n, holders: 0n, burn: 4n * 10n ** 14n, royalty: false });
  b.log(COLLECTION, 'TokensBurned', { amount: 500n * e18, ethIn: 4n * 10n ** 14n });
  b.log(COLLECTION, 'Transfer', { from: ETH, to: MINTER, tokenId: 1n });
  b.log(COLLECTION, 'Transfer', { from: ETH, to: MINTER, tokenId: 2n });
  b.log(COLLECTION, 'Minted', { to: MINTER, firstTokenId: 1n, quantity: 2n, asset: ETH, paid: 2n * PRICE });
  // Second mint: 1 NFT; its holders share funds the 30-day pool of the two NFTs that existed.
  b.tx(N0 + 30n, TRADER);
  b.log(COLLECTION, 'RevenueSplit', { asset: ETH, platform: 2n * 10n ** 14n, creator: 3n * 10n ** 14n, holders: 3n * 10n ** 14n, burn: 2n * 10n ** 14n, royalty: false });
  b.log(COLLECTION, 'HoldersFunded', { amount: 3n * 10n ** 14n, rewardRate: RATE, periodFinish: DAY(N0 + 30n) + 30n });
  b.log(COLLECTION, 'ConversionDeferred', { asset: '0x000000000000000000000000000000000000dEaD', amount: 2n * 10n ** 14n });
  b.log(COLLECTION, 'Transfer', { from: ETH, to: TRADER, tokenId: 3n });
  b.log(COLLECTION, 'Minted', { to: TRADER, firstTokenId: 3n, quantity: 1n, asset: ETH, paid: PRICE });
  // The minter sells NFT 1, claims what its NFTs accrued, the creator changes the price and the description.
  b.tx(N0 + 40n, MINTER);
  b.log(COLLECTION, 'Transfer', { from: MINTER, to: TRADER, tokenId: 1n });
  b.tx(N0 + 50n, MINTER);
  b.log(COLLECTION, 'HoldersClaimed', { account: MINTER, amount: 7n * 10n ** 12n });
  b.tx(N0 + 60n, CREATOR);
  b.log(COLLECTION, 'MintSet', { price: 2n * PRICE, start: 0n, end: 0n, tokenPayments: true });
  b.log(COLLECTION, 'ContractURIUpdated', {});
  b.log(COLLECTION, 'Paid', { creator: CREATOR, platform: `0x${'fe'.repeat(20)}`, asset: ETH, creatorAmount: 15n * 10n ** 14n, platformAmount: 6n * 10n ** 14n });
  return b;
}

const SETTINGS = {
  name: 'Place Club',
  symbol: 'CLUB',
  kind: 0,
  maxSupply: 3,
  maxPerWallet: 5,
  mintStart: 0n,
  mintEnd: 0n,
  mintPrice: PRICE,
  token: PAIR,
  tokenPayments: false,
  rewardToken: ETH,
  royaltyBps: 500,
  economy: { creatorBps: 6000, holdersBps: 3000, burnBps: 1000 },
  contractURI: 'ipfs://bafyold',
  baseURI: 'ipfs://bafyfolder/',
  uriSuffix: '.json',
  owner: CREATOR,
  launchPool: { currency0: ETH, currency1: PAIR, fee: 0, tickSpacing: 0, hooks: ETH },
  official: true,
  metadataFrozen: false,
};

function onMulticall(contracts) {
  return contracts.map((c) => {
    const ok = (result) => ({ status: 'success', result });
    if (c.address === PAIR) return ok({ name: 'Pair Token', symbol: 'PAIR', decimals: 18, supportsInterface: false }[c.functionName]);
    if (c.address !== COLLECTION) return { status: 'failure', error: new Error('unknown') };
    if (c.functionName === 'contractURI') return ok('ipfs://bafynew');
    if (c.functionName in SETTINGS) return ok(SETTINGS[c.functionName]);
    const live = { totalSupply: 3n, rewardRate: RATE, periodFinish: DAY(N0 + 30n) + 30n, lastAccrualDay: DAY(N0 + 30n), buybackPending: 2n * 10n ** 14n, pendingHolders: 0n, creatorOwed: 0n, platformOwed: 0n, reserved: 5n * 10n ** 14n, totalBurned: 500n * e18, mintedBy: 2 };
    if (c.functionName === 'credit') return ok(c.args[0] === MINTER ? 3n * 10n ** 12n : 0n);
    if (c.functionName === 'claimable') return ok(c.args[0] === 2n ? 4n * 10n ** 12n : 5n * 10n ** 12n);
    if (c.functionName in live) return ok(live[c.functionName]);
    return { status: 'failure', error: new Error(c.functionName) };
  });
}

async function setup(b, head) {
  const db = await freshDb();
  const node = { ...fakeNode({ logs: b.logs, senders: b.senders, head, onMulticall }), getBalance: async () => 6n * 10n ** 14n, readContract: async () => CREATOR };
  await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n, confirmations: 0n });
  const deps = { db, client: () => node, now: () => Number(timeOf(N0 + 100n)), fetchFn: async () => ({ ok: false, status: 503 }) };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
  return { db, node, deps, get };
}

function deployNft() {
  const n = launchDeployment(CHAIN).nft;
  const saved = { ...n };
  Object.assign(n, { startBlock: N0, factory: FACTORY, swapper: `0x${'5a'.repeat(20)}`, priceGuard: `0x${'9a'.repeat(20)}` });
  return () => Object.assign(n, saved);
}

test('without NFT addresses: endpoints answer "not deployed" with empty lists', async (t) => {
  const n = launchDeployment(CHAIN).nft;
  const saved = { ...n };
  Object.assign(n, { startBlock: null, factory: null, swapper: null, priceGuard: null });
  t.after(() => Object.assign(n, saved));
  assert.equal(nftDeployment(CHAIN), null);
  const db = await freshDb();
  const deps = { db, client: () => ({}), now: () => 1_800_000_000 };
  const get = (path, query = {}) => handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
  const list = await get('launch/collections');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { deployed: false, collections: [], total: 0 });
  const one = await get('launch/collection', { address: COLLECTION });
  assert.equal(one.status, 200);
  assert.equal(one.body.deployed, false);
  const acc = await get('launch/nft/account', { account: MINTER });
  assert.deepEqual(acc.body.owned, []);
  const pairs = await get('launch/nft/pairs');
  assert.equal(pairs.body.deployed, false);
  assert.equal(pairs.body.rewardTokens[0].symbol, 'ETH');
});

test('NFT indexer: creation, mints, transfers, holders pool, claims, burn and settings; idempotent', async () => {
  const restore = deployNft();
  try {
    const b = collectionLife();
    const { db, node } = await setup(b, N0 + 100n);
    const [c] = await db.query('select * from nft_launch_collections');
    assert.equal(c.address, COLLECTION);
    assert.equal(c.creator, CREATOR);
    assert.equal(c.owner, CREATOR);
    assert.equal(c.token, PAIR);
    assert.equal(c.reward_token, ETH);
    assert.equal(c.official, true);
    assert.equal(c.kind, 'unique');
    assert.equal(c.name, 'Place Club');
    assert.deepEqual([c.creator_bps, c.holders_bps, c.burn_bps, c.royalty_bps, c.max_supply].map(Number), [6000, 3000, 1000, 500, 3]);
    assert.equal(c.total_minted, 3);
    assert.equal(String(c.paid_eth), String(3n * PRICE));
    assert.equal(String(c.mint_price), String(2n * PRICE), 'MintSet after creation wins');
    assert.equal(c.token_payments, true);
    assert.equal(c.contract_uri, 'ipfs://bafynew');
    assert.equal(String(c.holders_funded), String(3n * 10n ** 14n));
    assert.equal(String(c.holders_claimed), String(7n * 10n ** 12n));
    assert.equal(String(c.burned), String(500n * e18));
    assert.equal(String(c.reward_rate), String(RATE));
    const items = await db.query('select token_id::int as id, owner from nft_launch_items order by token_id');
    assert.deepEqual(items.map((i) => [i.id, i.owner]), [[1, TRADER], [2, MINTER], [3, TRADER]]);
    const kinds = (await db.query('select kind from nft_launch_events order by block, log_index')).map((r) => r.kind);
    assert.deepEqual(kinds, ['RevenueSplit', 'TokensBurned', 'RevenueSplit', 'HoldersFunded', 'ConversionDeferred', 'HoldersClaimed', 'Paid']);
    // Indexing the same range again changes nothing.
    await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n, confirmations: 0n });
    await db.query("delete from indexer_cursors where contract like 'events:%'");
    await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n, confirmations: 0n });
    const [again] = await db.query('select total_minted, paid_eth::text as p, holders_funded::text as f, burned::text as b from nft_launch_collections');
    assert.deepEqual(again, { total_minted: 3, p: String(3n * PRICE), f: String(3n * 10n ** 14n), b: String(500n * e18) });
    assert.equal((await db.query('select count(*)::int as n from nft_launch_mints'))[0].n, 2);
  } finally {
    restore();
  }
});

test('collection endpoints: list with filters, page with live pool and the wallet part, holders, account', async () => {
  const restore = deployNft();
  try {
    const { db, node, get } = await setup(collectionLife(), N0 + 100n);
    const list = await get('launch/collections', { token: PAIR, official: '1' });
    assert.equal(list.body.deployed, true);
    assert.equal(list.body.total, 1);
    const c = list.body.collections[0];
    assert.equal(c.token.symbol, 'PAIR');
    assert.equal(c.rewardToken.symbol, 'ETH');
    assert.equal(c.holders, 2);
    assert.equal(c.status, 'sold-out');
    assert.deepEqual(c.economy, { platformBps: 2000, creatorBps: 6000, holdersBps: 3000, burnBps: 1000 });
    assert.equal(c.pool.active, true);
    assert.equal(c.pool.perDay, String(RATE / ACC));
    assert.equal((await get('launch/collections', { token: MINTER })).body.total, 0);
    assert.equal((await get('launch/collections', { q: 'club' })).body.total, 1);
    assert.equal((await get('launch/collections', { holder: MINTER })).body.total, 1);
    assert.equal((await get('launch/collections', { pool: '1' })).body.total, 1);

    const page = await get('launch/collection', { address: COLLECTION, account: MINTER });
    assert.equal(page.status, 200);
    assert.equal(page.body.live.buybackPending, String(2n * 10n ** 14n));
    assert.equal(page.body.live.unprocessedEth, String(10n ** 14n), 'balance above what the contract owes is an unprocessed royalty');
    assert.deepEqual(page.body.you.ids, [{ id: '2', claimable: String(4n * 10n ** 12n) }]);
    assert.equal(page.body.you.credit, String(3n * 10n ** 12n));
    assert.equal(page.body.you.claimable, String(7n * 10n ** 12n));
    assert.deepEqual(page.body.holders, [{ owner: TRADER, count: 2 }, { owner: MINTER, count: 1 }]);
    assert.equal(page.body.mints.length, 2);
    assert.equal(page.body.mints[0].minter, TRADER);
    assert.equal(page.body.log[0].kind, 'Paid');

    const holders = await get('launch/collection/holders', { address: COLLECTION });
    assert.equal(holders.body.total, 2);
    const acc = await get('launch/nft/account', { account: MINTER });
    assert.deepEqual(acc.body.owned.map((o) => [o.collection.address, o.ids]), [[COLLECTION, ['2']]]);
    assert.equal(acc.body.claimable[0].claimable, String(7n * 10n ** 12n));
    assert.equal(acc.body.claims[0].amount, String(7n * 10n ** 12n));
    const mine = await get('launch/nft/account', { account: CREATOR });
    assert.equal(mine.body.created[0].address, COLLECTION);
    assert.equal((await get('launch/collection', { address: MINTER })).status, 404);

    // Launchpad collections count as Place collections for NFT holder campaigns: the publisher builds their tables.
    assert.deepEqual(await externalTarget(db, node, CHAIN, { kind: 0, token: COLLECTION }), { kind: 'nft-holders' });
  } finally {
    restore();
  }
});

test('pool math: daily portion per NFT, what is left and the end date; mint status', () => {
  const now = 20_000 * 86_400 + 3600;
  const rate = 30n * e18 * ACC / 30n; // 30 tokens over 30 days
  const s = poolState({ rewardRate: rate, periodFinish: 20_010, supply: 4 }, now);
  assert.equal(s.active, true);
  assert.equal(s.perDay, String(e18));
  assert.equal(s.perNftPerDay, String(e18 / 4n));
  assert.equal(s.daysLeft, 10);
  assert.equal(s.left, String(10n * e18));
  assert.equal(s.endsAt, new Date(20_010 * 86_400 * 1000).toISOString());
  assert.equal(poolState({ rewardRate: rate, periodFinish: 20_000, supply: 4 }, now).active, false);
  assert.equal(mintStatus({ max_supply: 10, total_minted: 10 }, now), 'sold-out');
  assert.equal(mintStatus({ max_supply: 0, total_minted: 10, mint_start: now + 10 }, now), 'upcoming');
  assert.equal(mintStatus({ max_supply: 0, total_minted: 10, mint_end: now - 1 }, now), 'ended');
  assert.equal(mintStatus({ max_supply: 0, total_minted: 1 }, now), 'live');
});

test('Register token: rights from owner()/admin(), liquidity bar, signed registration, admin review', async () => {
  assert.deepEqual(decideRegistration({ account: CREATOR, rights: { owner: CREATOR, admin: null }, liquidityUsd: 25_000 }), { method: 'owner', status: 'verified', low: false, note: null });
  assert.equal(decideRegistration({ account: CREATOR, rights: { owner: null, admin: CREATOR }, liquidityUsd: 25_000 }).method, 'admin');
  assert.equal(decideRegistration({ account: CREATOR, rights: { owner: CREATOR, admin: null }, liquidityUsd: 500 }).status, 'review');
  assert.equal(decideRegistration({ account: MINTER, rights: { owner: CREATOR, admin: null }, liquidityUsd: 25_000 }).method, 'manual');
  const gecko = async (url) => ({ ok: true, json: async () => ({ data: { attributes: { total_reserve_in_usd: url.includes(PAIR) ? '12345.6' : '0' } } }) });
  assert.equal(await tokenLiquidityUsd(gecko, 8453, PAIR), 12345.6);
  assert.equal(await tokenLiquidityUsd(gecko, 84532, PAIR), null, 'testnet liquidity cannot be measured');

  const db = await freshDb();
  const now = 1_800_000_000;
  const client = {
    multicall: async ({ contracts }) => contracts.map((c) => ({ status: 'success', result: { name: 'Pair Token', symbol: 'PAIR', decimals: 18, supportsInterface: false }[c.functionName] })),
    readContract: async ({ functionName }) => (functionName === 'owner' ? CREATOR : Promise.reject(new Error('no admin'))),
    verifyMessage: async ({ address, message, signature }) => signature === '0xgood' && message.includes(address),
  };
  const deps = { db, client: () => client, now: () => now, fetchFn: gecko };
  const call = (method, path, data) => handlePlace(method === 'GET' ? { method, path, query: { chain: String(CHAIN), ...data } } : { method, path, body: data, query: {} }, deps);
  const check = await call('GET', 'launch/projects/check', { token: PAIR, account: CREATOR });
  assert.equal(check.body.rights.owner, CREATOR);
  assert.equal(check.body.decision.method, 'owner');
  assert.equal(check.body.isToken, true);
  const issuedAt = new Date(now * 1000).toISOString();
  const msg = registerMessage({ chainId: CHAIN, token: PAIR, account: CREATOR, issuedAt });
  assert.match(msg, /no transaction/);
  const bad = await call('POST', 'launch/projects/register', { chainId: CHAIN, token: PAIR, account: CREATOR, issuedAt, signature: '0xbad' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', 'launch/projects/register', { chainId: CHAIN, token: PAIR, account: CREATOR, issuedAt, signature: '0xgood' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registration.method, 'owner');
  assert.equal(ok.body.registration.status, 'review', 'testnet: liquidity is checked by hand');
  assert.equal((await call('GET', 'launch/projects', {})).body.projects.length, 0, 'only verified projects are public');
  assert.equal((await call('GET', 'launch/projects', { token: PAIR })).body.projects[0].status, 'review');
  const admin = DEFAULT_ADMINS[0];
  client.verifyMessage = async () => true;
  const review = await call('POST', 'admin/hide', { chainId: CHAIN, admin, action: 'verify', type: 'registration', target: PAIR, issuedAt, signature: '0x1' });
  assert.equal(review.status, 200);
  assert.equal(review.body.status, 'verified');
  assert.equal((await call('GET', 'launch/projects', {})).body.projects[0].token, PAIR);
});

test('pin folder: NFT images and metadata as one IPFS folder, checked file by file', async () => {
  const db = await freshDb();
  const pinned = [];
  const deps = { db, client: () => ({}), now: () => 1_800_000_000, pinFolder: async (files, { name }) => (pinned.push({ files, name }), 'ipfs://bafyfolder/') };
  const post = (body) => handlePlace({ method: 'POST', path: 'pin', body, query: {}, ip: '1.2.3.4' }, deps);
  const meta = (i) => ({ name: `${i}.json`, contentType: 'application/json', content: { name: `Club #${i}`, description: 'A member', image: `ipfs://bafyimg/${i}.webp`, attributes: [{ trait_type: 'Edition', value: i }] } });
  const ok = await post({ kind: 'folder', files: [meta(1), meta(2), { name: '1.webp', contentType: 'image/webp', data: Buffer.from('img').toString('base64') }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { uri: 'ipfs://bafyfolder/', files: 3 });
  assert.equal(JSON.parse(pinned[0].files[0].bytes.toString()).attributes[0].value, '1');
  assert.equal((await post({ kind: 'folder', files: [meta(1), meta(1)] })).status, 400, 'names must be unique');
  assert.equal((await post({ kind: 'folder', files: [{ ...meta(1), name: '../x.json' }] })).status, 400);
  assert.equal((await post({ kind: 'folder', files: [{ name: 'a.json', contentType: 'application/json', content: { name: 'x', image: 'javascript:alert(1)' } }] })).status, 400);
  assert.equal((await post({ kind: 'folder', files: [{ name: 'a.exe', contentType: 'application/x-msdownload', data: 'AA==' }] })).status, 400);
});

test('Launch NFT form: checks, createCollection parameters, the mint split and upload batches', async () => {
  const { planNftCollection, mintSplit, paymentPct, batches, byFileName, uniqueMetadata, utcSeconds, poolNumbers } = await import('../src/launch/nft.js');
  const pair = { address: PAIR, launchPool: { currency0: ETH, currency1: PAIR, fee: 0, tickSpacing: 200, hooks: `0x${'ac'.repeat(20)}` } };
  const form = { name: ' Place Club ', symbol: 'club', kind: 'unique', supply: '3', maxPerWallet: '', mintStart: '', mintEnd: '', price: '0.001', tokenPayments: true, royalty: '5', economy: { creator: 60, holders: 30, burn: 10 }, baseURI: 'ipfs://bafyfolder/', contractURI: 'ipfs://bafymeta' };
  const now = 1_800_000_000;
  const ok = planNftCollection(form, { pair, rewardToken: 'eth', now });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.params.name, 'Place Club');
  assert.equal(ok.params.symbol, 'CLUB');
  assert.equal(ok.params.kind, 0);
  assert.equal(ok.params.maxSupply, 3);
  assert.equal(ok.params.mintPrice, PRICE);
  assert.equal(ok.params.uriSuffix, '.json');
  assert.equal(ok.params.rewardToken, ETH);
  assert.equal(ok.params.royaltyBps, 500);
  assert.deepEqual(ok.params.economy, { creatorBps: 6000, holdersBps: 3000, burnBps: 1000 });
  assert.equal(ok.params.launchPool.tickSpacing, 200);
  // Free mint: no payment in the pair token; open edition: supply 0 allowed; Unique needs supply and matching files.
  assert.equal(planNftCollection({ ...form, price: '0' }, { pair, now }).params.tokenPayments, false);
  assert.equal(planNftCollection({ ...form, kind: 'edition', supply: '', baseURI: 'ipfs://bafymeta/metadata.json' }, { pair, now }).params.maxSupply, 0);
  assert.ok(planNftCollection({ ...form, supply: '' }, { pair, now }).errors.supply);
  assert.ok(planNftCollection({ ...form, files: [{}, {}] }, { pair, now }).errors.files);
  assert.ok(planNftCollection({ ...form, economy: { creator: 50, holders: 30, burn: 10 } }, { pair, now }).errors.economy);
  assert.ok(planNftCollection({ ...form, royalty: '11' }, { pair, now }).errors.royalty);
  assert.ok(planNftCollection(form, { pair: null, now }).errors.pair);
  assert.ok(planNftCollection({ ...form, baseURI: 'ipfs://bafyfolder' }, { pair, now }).errors.media);
  assert.ok(planNftCollection({ ...form, mintStart: '2027-01-02T00:00', mintEnd: '2027-01-01T00:00' }, { pair, now }).errors.mintEnd);
  assert.equal(utcSeconds('2027-01-01T00:00'), Date.UTC(2027, 0, 1) / 1000);
  // 0.001 ETH: 20% platform, then 60 / 30 / 10.
  assert.deepEqual(mintSplit(PRICE, { creator: 60, holders: 30, burn: 10 }), { platform: 2n * 10n ** 14n, creator: 48n * 10n ** 13n, holders: 24n * 10n ** 13n, burn: 8n * 10n ** 13n });
  assert.deepEqual(paymentPct({ creator: 60, holders: 30, burn: 10 }), { platform: 20, creator: 48, holders: 24, burn: 8 });
  assert.deepEqual(batches([{ size: 5 }, { size: 5 }, { size: 5 }], 10).map((b) => b.length), [2, 1]);
  assert.deepEqual([{ name: '10.png' }, { name: '2.png' }, { name: '1.png' }].sort(byFileName).map((f) => f.name), ['1.png', '2.png', '10.png']);
  assert.equal(uniqueMetadata({ name: 'Club', image: 'ipfs://x/1.webp', id: 1 }).name, 'Club #1');
  const p = poolNumbers({ active: true, perDay: String(e18), perNftPerDay: String(e18 / 4n), left: String(10n * e18), funded: '0', claimed: '0', daysLeft: 10, endsAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual([p.perDay, p.perNftPerDay, p.left, p.daysLeft], [1, 0.25, 10, 10]);
});
