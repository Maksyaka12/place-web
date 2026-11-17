// Place Launch API on PGlite, seeded by the real indexer from the L2-shaped fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, verifyMessage } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { profileMessage } from '../src/launch/profile.js';
import { indexEvents } from '../api/_lib/place/indexer.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { LEGACY_CREATOR_VAULT_ABI } from '../src/launch/abi.legacy.js';
import { l2Logs, fakeNode, freshDb, CHAIN, D, B0, B20, ERC, CREATOR, TRADER, DEAD, USDC, timeOf } from './launchFixture.js';

const NOW = Number(timeOf(B0 + 2000n));
const ETH_USD = 2000;

async function setup({ onMulticall, simulate } = {}) {
  const b = l2Logs();
  const db = await freshDb();
  const node = fakeNode({ logs: b.logs, senders: b.senders, head: B0 + 2030n, onMulticall });
  await indexEvents({ db, client: node, chainId: CHAIN, maxRange: 2_000_000n });
  await db.query(`insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at, claim_duration,
      burn_leftover, rules_hash, rules_uri, created_block, created_tx, created_at)
    values ($1, $2, 1, $3, 0, $4, $5, 165350700000000, 0, $6, 2592000, true, $7, 'https://example/rules.json', $8, '0x01', $9)`, [
    CHAIN, D.hub, B20.vault, B20.token, '0x0000000000000000000000000000000000000000', new Date((NOW + 86400) * 1000).toISOString(), D.launchRules[0].rulesHash, String(B0 + 1200n), new Date(NOW * 1000).toISOString(),
  ]);
  const refreshed = [];
  const client = { ...node, simulateContract: simulate || (async () => ({ result: 0n })) };
  const deps = {
    db,
    client: () => client,
    now: () => NOW,
    fetchFn: async (url) => ({ ok: true, json: async () => ({ data: { amount: url.includes('ETH-USD') ? String(ETH_USD) : '1' } }) }),
    refresh: async (chainId) => refreshed.push(chainId),
  };
  const get = async (path, query = {}) => {
    const r = await handlePlace({ method: 'GET', path, query: { chain: String(CHAIN), ...query } }, deps);
    return r;
  };
  return { db, deps, get, refreshed };
}

test('feed: newest first, trending by USD volume across pairs, quote filter, search', async () => {
  const { get, refreshed } = await setup();
  const fresh = await get('launch/tokens');
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.tokens.map((t) => t.symbol), ['PL2E', 'PL2B']);
  assert.deepEqual(refreshed, [CHAIN], 'market endpoints catch the indexer up first');

  const b20 = fresh.body.tokens[1];
  assert.equal(b20.quote.address, 'eth');
  assert.equal(b20.quote.usd, ETH_USD);
  assert.equal(b20.trades24h, 4);
  assert.equal(b20.holders, 2, 'creator and trader; pool, hook and burn address are not holders');
  assert.ok(Math.abs(b20.burned - 28044.28716649377) < 1e-6);
  assert.ok(b20.marketCap < b20.fdv);
  assert.ok(Math.abs(b20.priceUsd - b20.price * ETH_USD) < 1e-15);
  assert.ok(b20.liquidity.valueUsd > 3000 && b20.liquidity.valueUsd < 5000, `liquidity ${b20.liquidity.valueUsd}`);

  // B20 traded 0.00134 ETH ≈ $2.7, ERC-20 0.99 USDC: trending puts B20 first.
  const trending = await get('launch/tokens', { sort: 'trending' });
  assert.deepEqual(trending.body.tokens.map((t) => t.symbol), ['PL2B', 'PL2E']);
  assert.deepEqual((await get('launch/tokens', { quote: 'eth' })).body.tokens.map((t) => t.symbol), ['PL2B']);
  assert.deepEqual((await get('launch/tokens', { quote: USDC })).body.tokens.map((t) => t.symbol), ['PL2E']);
  assert.deepEqual((await get('launch/tokens', { q: 'erc20' })).body.tokens.map((t) => t.symbol), ['PL2E']);
  assert.equal((await get('launch/tokens', { sort: 'hot' })).status, 400);
});

test('token page: market, volumes, trades, holders with tags, vault totals, campaigns, announcements', async () => {
  const { get } = await setup();
  const r = await get('launch/token', { address: B20.token });
  assert.equal(r.status, 200);
  const p = r.body;
  assert.equal(p.token.name, 'Place L2 B20 Renamed');
  assert.deepEqual(p.token.links, { website: 'https://place-blond.vercel.app', x: 'https://x.com/place' });
  assert.deepEqual(p.activity24h, { buys: 3, sells: 1, traders: 2 });
  assert.ok(Math.abs(p.volume.h24 - 0.0013411169) < 1e-12);
  assert.equal(p.trades[0].side, 'buy');
  assert.equal(p.trades[0].trader, CREATOR);
  assert.equal(p.trades[1].side, 'sell');
  assert.deepEqual(
    p.holders.map((h) => h.tag),
    ['pool', 'creator', null, 'burned'],
    'sorted by balance as a number, not as text'
  );
  assert.equal(p.vault.totals.boughtBackTokens, '28044287166493768656910');
  assert.equal(p.campaigns.length, 1);
  assert.equal(p.campaigns[0].fromVault, true);
  assert.equal(p.campaigns[0].status, 'scheduled');
  assert.equal(p.announcements[0].description, 'gm');
  assert.equal((await get('launch/token', { address: TRADER })).status, 404);
});

test('candles: OHLC per bucket from swaps, gaps filled flat at the last close', async () => {
  const { get } = await setup();
  const r = await get('launch/candles', { address: B20.token, interval: '1m', from: String(Number(timeOf(B0))) });
  assert.equal(r.status, 200);
  const c = r.body.candles;
  // trades at T0 (dev buy), T0+60 (buy), T0+180 (sell), T0+241 (buyback); now = T0+400
  assert.deepEqual(c.map((x) => x.trades), [1, 1, 0, 1, 1, 0, 0]);
  assert.equal(c[2].v, 0);
  assert.equal(c[2].o, c[1].c, 'an empty minute is flat at the previous close');
  for (const x of c) assert.ok(x.l <= Math.min(x.o, x.c) && x.h >= Math.max(x.o, x.c));
  const hourly = await get('launch/candles', { address: B20.token, interval: '1h' });
  assert.equal(hourly.body.candles.reduce((n, x) => n + x.trades, 0), 4);
  assert.equal((await get('launch/candles', { address: B20.token, interval: '2m' })).status, 400);
});

test('trades: by token or trader, newest first, with a cursor', async () => {
  const { get } = await setup();
  const p1 = await get('launch/trades', { address: B20.token, limit: '2' });
  assert.equal(p1.body.trades.length, 2);
  assert.ok(p1.body.next);
  const p2 = await get('launch/trades', { address: B20.token, limit: '2', before: p1.body.next });
  assert.equal(p2.body.trades.length, 2);
  assert.equal(p2.body.next, null);
  assert.equal(p2.body.trades[1].tx, p1.body.trades[0].tx === p2.body.trades[1].tx ? 'dup' : p2.body.trades[1].tx);
  const mine = await get('launch/trades', { trader: TRADER });
  assert.deepEqual(mine.body.trades.map((t) => t.side), ['sell', 'buy']);
  assert.ok(Math.abs(mine.body.trades[0].quote - 0.000098) < 1e-12);
});

test('holders endpoint counts people only and pages by balance', async () => {
  const { get } = await setup();
  const r = await get('launch/holders', { address: B20.token, limit: '2' });
  assert.equal(r.body.holders, 2);
  assert.deepEqual(r.body.list.map((h) => h.account), [D.poolManager, CREATOR]);
  assert.equal(r.body.nextOffset, 2);
  const rest = await get('launch/holders', { address: B20.token, offset: '2' });
  assert.deepEqual(rest.body.list.map((h) => h.account), [TRADER, DEAD]);
});

test('the hub sees launched tokens as projects', async () => {
  const { get } = await setup();
  const r = await get('token', { address: B20.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.placeLaunch.kind, 'b20');
  assert.equal(r.body.placeLaunch.vault, B20.vault);
  assert.equal(r.body.campaigns[0].launchedOnPlace, true);
  assert.equal(r.body.campaigns[0].fromLaunchVault, true);
  const other = await get('token', { address: USDC });
  assert.equal(other.body.placeLaunch, null);
});

test('pairs: start price and FDV from the start tick, USD price, launches', async () => {
  const { get } = await setup();
  const r = await get('launch/pairs');
  const eth = r.body.pairs.find((p) => p.address === 'eth');
  assert.equal(eth.launches, 1);
  assert.ok(Math.abs(eth.startFdv - 1.943) < 0.001);
  assert.ok(Math.abs(eth.startFdvUsd - 1.943 * ETH_USD) < 3);
  const usdc = r.body.pairs.find((p) => p.address === USDC);
  assert.ok(Math.abs(usdc.startFdvUsd - 4009) < 1);
  assert.equal(usdc.symbol, 'USDC');
});

test('creator panel (0.1.0 legacy vault): live vault state, claim dry run → minOut with slippage, rewards check', async () => {
  const vaultState = {
    buybackReserve: 0n,
    creatorOwed: 0n,
    xOwedTotal: 0n,
    rewardsAvailable: 0n,
    pendingFees: 413376750000n,
    payoutAddress: CREATOR,
    currentCreator: CREATOR,
    lastCampaignAt: BigInt(NOW - 100),
    rewardsConfig: { hub: D.hub, minAmount: 10n ** 14n, interval: 604800n, rulesHash: D.launchRules[0].rulesHash, rulesURI: 'x' },
    buybackBps: 2000,
    buybackBurn: true,
    rewardsBps: 6000,
  };
  const sims = [];
  const { get } = await setup({
    onMulticall: async (contracts) =>
      contracts.map((c) => (c.functionName in vaultState ? vaultState[c.functionName] : { status: 'success', result: c.functionName === 'symbol' ? 'USDC' : 6 })),
    simulate: async ({ functionName, account }) => {
      sims.push([functionName, account]);
      if (functionName === 'claim') return { result: [82675350000n, 42065248474575206938n] };
      const err = new Error('reverted');
      err.walk = (fn) => (fn({ data: { errorName: 'CampaignTooSoon', args: [123n] } }) ? { data: { errorName: 'CampaignTooSoon', args: [123n] } } : null);
      throw err;
    },
  });
  const r = await get('launch/creator', { address: CREATOR, slippageBps: '100' });
  assert.equal(r.status, 200);
  assert.equal(r.body.tokens.length, 2);
  const t = r.body.tokens.find((x) => x.token.address === B20.token);
  assert.equal(t.isCurrentCreator, true);
  assert.equal(t.vault.claim.boughtBack, '42065248474575206938');
  assert.equal(t.vault.claim.minOut, String((42065248474575206938n * 9900n) / 10000n));
  assert.equal(t.vault.claim.buybackTo, 'burn');
  assert.equal(t.vault.version, 'legacy');
  assert.equal(t.token.legacy, true);
  const call = decodeFunctionData({ abi: LEGACY_CREATOR_VAULT_ABI, data: t.vault.claim.tx.data });
  assert.equal(call.functionName, 'claim');
  assert.equal(call.args[0], BigInt(t.vault.claim.minOut));
  assert.equal(t.vault.rewards.canStart, false);
  assert.equal(t.vault.rewards.reason, 'CampaignTooSoon(123)');
  assert.equal(t.vault.rewards.available, String((413376750000n * 6000n) / 10000n));
  assert.ok(sims.some(([f, a]) => f === 'claim' && a === CREATOR), 'the claim is simulated as the creator');
  assert.equal(t.history[0].kind, 'creator_paid');
  assert.equal((await get('launch/creator', { address: CREATOR, slippageBps: '9000' })).status, 400);
});

// predict (0.3.0 economics, local preview before the deploy, factory checks after): tests/launchV3.test.js

test('dashboard: totals, live feed across tokens, sorts and the crypto / stocks filter', async () => {
  const { get } = await setup();
  const stats = await get('launch/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.tokens, 2);
  assert.equal(stats.body.traders, 2);
  assert.ok(stats.body.volumeUsd > 0 && stats.body.volumeUsd >= stats.body.volume24hUsd);
  assert.ok(['PL2B', 'PL2E'].includes(stats.body.topMarketCap.symbol));
  assert.ok(stats.body.topMarketCap.marketCapUsd > 0);

  const feed = await get('launch/trades', { limit: '5' });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.trades.length, 5);
  assert.ok(feed.body.trades.every((t) => t.symbol && t.quoteSymbol && t.valueUsd > 0));

  const tokens = (await get('launch/tokens', { sort: 'volume' })).body.tokens;
  assert.deepEqual(tokens.map((t) => t.symbol), ['PL2B', 'PL2E']);
  assert.ok(tokens.every((t) => t.volumeAll >= t.volume24h && t.volumeAllUsd > 0 && t.quote.category === 'crypto'));
  assert.equal((await get('launch/tokens', { sort: 'liquidity' })).body.tokens.length, 2);
  assert.equal((await get('launch/tokens', { category: 'crypto' })).body.tokens.length, 2);
  assert.equal((await get('launch/tokens', { category: 'stocks' })).body.tokens.length, 0);
  assert.deepEqual((await get('launch/tokens', { q: 'pl2e' })).body.tokens.map((t) => t.symbol), ['PL2E']);
  assert.deepEqual((await get('launch/tokens', { q: ERC.token })).body.tokens.map((t) => t.symbol), ['PL2E']);
  assert.deepEqual((await get('launch/pairs')).body.pairs.map((p) => p.category), ['crypto', 'crypto']);
});

test('profiles: saved only with the wallet signature, newest wins, public read', async () => {
  const { deps } = await setup();
  const account = privateKeyToAccount(generatePrivateKey());
  deps.client = () => ({ verifyMessage: (args) => verifyMessage(args) });
  const call = (method, path, query, body) => handlePlace({ method, path, query: { chain: String(CHAIN), ...query }, body }, deps);
  const profile = { name: 'Maks', website: 'place.example', x: 'https://x.com/maks_1', telegram: '@maksik', bio: 'Builds on Base' };
  const issuedAt = new Date(NOW * 1000).toISOString();
  const signature = await account.signMessage({ message: profileMessage({ address: account.address, profile, issuedAt }) });

  const saved = await call('POST', 'launch/profile', {}, { address: account.address, profile, issuedAt, signature, chainId: CHAIN });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.profile.website, 'https://place.example');
  assert.equal(saved.body.profile.x, 'maks_1');
  assert.equal(saved.body.profile.telegram, 'maksik');

  const read = await call('GET', 'launch/profile', { address: account.address.toLowerCase() });
  assert.equal(read.body.profile.name, 'Maks');
  assert.equal((await call('GET', 'launch/profile', { addresses: account.address })).body.profiles.length, 1);

  // Someone else's signature, a changed field, a replay and an old signature all fail.
  const other = privateKeyToAccount(generatePrivateKey());
  const later = new Date((NOW + 5) * 1000).toISOString();
  const forged = await other.signMessage({ message: profileMessage({ address: account.address, profile, issuedAt: later }) });
  assert.equal((await call('POST', 'launch/profile', {}, { address: account.address, profile, issuedAt: later, signature: forged })).status, 401);
  const sig2 = await account.signMessage({ message: profileMessage({ address: account.address, profile, issuedAt: later }) });
  assert.equal((await call('POST', 'launch/profile', {}, { address: account.address, profile: { ...profile, name: 'Evil' }, issuedAt: later, signature: sig2 })).status, 401);
  assert.equal((await call('POST', 'launch/profile', {}, { address: account.address, profile, issuedAt, signature })).status, 409);
  const old = new Date((NOW - 3600) * 1000).toISOString();
  const sig3 = await account.signMessage({ message: profileMessage({ address: account.address, profile, issuedAt: old }) });
  assert.equal((await call('POST', 'launch/profile', {}, { address: account.address, profile, issuedAt: old, signature: sig3 })).status, 401);
  assert.equal((await call('POST', 'launch/profile', {}, { address: account.address, profile: { bio: 'x'.repeat(181) }, issuedAt, signature })).status, 400);
});

test('unknown launch routes and chains are clear errors', async () => {
  const { get } = await setup();
  assert.equal((await get('launch/nope')).status, 404);
  assert.equal((await get('launch/tokens', { chain: '1' })).status, 400);
  assert.equal((await get('launch/tokens', { sort: 'nope' })).status, 400);
  assert.equal((await get('launch/tokens', { category: 'nope' })).status, 400);
  assert.equal((await get('launch/token', { address: ERC.token })).status, 200);
});
