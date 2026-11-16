// Live check of the Place Launch indexer and API against the real chain, on a local PGlite database (no
// DATABASE_URL, no keys: logs and reads go through publicnode).
//   node scripts/launchLive.mjs [--db .launch-live] [--chain 84532] [--out launch-live.json]
// Indexes the hub and the launchpad with the shared cursor, calls every /api/place/launch/* endpoint for the
// launched tokens, and dry-runs the publisher's rules step for creator-vault campaigns (template check and
// the table it would publish if the snapshot were taken now).
import { writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createPublicClient, http } from 'viem';
import { pgliteAdapter, migrate } from '../api/_lib/place/db.js';
import { NETWORKS, autoExclusions } from '../api/_lib/place/chain.js';
import { indexEvents, syncHubState, logsClient, refreshIndex } from '../api/_lib/place/indexer.js';
import { handlePlace } from '../api/_lib/place/api.js';
import { fetchIpfsText } from '../api/_lib/place/ipfs.js';
import { PLACE_HUB_ABI } from '../src/place/abi.js';
import { CREATOR_VAULT_ABI } from '../src/launch/abi.js';
import { launchDeployment, launchRulesTemplates } from '../src/launch/deployments.js';
import { launchCampaignRules } from '../src/launch/rules.js';
import { computeTable, verifyTable } from '../src/place/snapshot/index.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const chainId = Number(arg('chain', 84532));
const d = launchDeployment(chainId);
const log = (...m) => console.log(...m);
const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

const pg = new PGlite(arg('db', '.launch-live'));
const db = pgliteAdapter(pg);
await migrate(db);
const read = createPublicClient({
  chain: NETWORKS[chainId].chain,
  transport: http(chainId === 8453 ? 'https://base-rpc.publicnode.com' : 'https://base-sepolia-rpc.publicnode.com', { batch: { batchSize: 50 }, timeout: 30_000 }),
});
const logs = logsClient(chainId);

let t0 = Date.now();
for (;;) {
  const r = await indexEvents({ db, client: logs, chainId, budgetMs: 60_000 });
  log(`indexed ${r.from}…${r.to} (head ${r.head}): ${r.events} events, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.caughtUp) break;
}
await syncHubState({ db, client: read, chainId });

const deps = { db, client: () => read, fetchFn: fetch, now: () => Math.floor(Date.now() / 1000), refresh: (c) => refreshIndex({ db, client: logs, chainId: c }) };
const call = async (path, query = {}) => {
  const t = Date.now();
  const r = await handlePlace({ method: 'GET', path, query: { chain: String(chainId), ...query } }, deps);
  if (r.status !== 200) throw new Error(`${path} ${JSON.stringify(query)} → ${r.status} ${JSON.stringify(r.body)}`);
  log(`GET /api/place/${path} ${new URLSearchParams(query)} → 200 in ${Date.now() - t} ms`);
  return r.body;
};

const out = {};
out.pairs = await call('launch/pairs');
out.feedNew = await call('launch/tokens', { sort: 'new' });
out.feedTrending = await call('launch/tokens', { sort: 'trending' });
out.feedEth = await call('launch/tokens', { quote: 'eth' });
out.tokens = {};
for (const t of out.feedNew.tokens) {
  const page = await call('launch/token', { address: t.address });
  const candles = {};
  for (const interval of ['1m', '5m', '1h', '1d']) candles[interval] = (await call('launch/candles', { address: t.address, interval, from: String(Math.floor(new Date(t.createdAt).getTime() / 1000) - 60) })).candles;
  const trades = await call('launch/trades', { address: t.address, limit: '100' });
  const holders = await call('launch/holders', { address: t.address });
  const hub = await call('token', { address: t.address });
  out.tokens[t.address] = { page, candles, trades, holders, hubToken: { placeLaunch: hub.placeLaunch, campaigns: hub.campaigns.map((c) => ({ id: c.id, status: c.status, launchedOnPlace: c.launchedOnPlace, fromLaunchVault: c.fromLaunchVault })) } };
}
const creators = [...new Set(out.feedNew.tokens.map((t) => t.creator))];
out.creators = {};
for (const c of creators) out.creators[c] = await call('launch/creator', { address: c });
if (creators[0]) {
  t0 = Date.now();
  out.predictB20 = await call('launch/predict', { creator: creators[0], kind: 'b20', quote: 'eth', name: 'Live Check', symbol: 'LIVE', editable: '1', website: 'https://place-blond.vercel.app', suffix: 'a' });
  out.predictErc20 = await call('launch/predict', { creator: creators[0], kind: 'erc20', quote: out.pairs.pairs.find((p) => p.address !== 'eth')?.address || 'eth', name: 'Live Check', symbol: 'LIVE', burnBps: '1000', communityBps: '2000' });
}
// 0.2.0 economy: staking programs, positions, a fund quote for each current-release token.
out.staking = await call('launch/staking');
out.positions = {};
for (const p of out.staking.programs) {
  const stakers = await db.query('select account from staking_positions where chain_id = $1 and vault_id = $2 and staked > 0', [chainId, p.id]);
  for (const s of stakers) out.positions[`${p.id}:${s.account}`] = await call('launch/staking/position', { id: p.id, account: s.account });
}
out.fundQuotes = {};
for (const t of out.feedNew.tokens.filter((x) => !x.legacy)) {
  const fund = out.tokens[t.address].page.fund;
  if (!fund || fund.balance === '0') continue;
  const half = (BigInt(fund.balance) / 2n).toString();
  out.fundQuotes[t.address] = {};
  for (const rt of ['eth', t.address, d.quotes.usdc]) out.fundQuotes[t.address][rt] = await call('launch/fund-quote', { token: t.address, rewardToken: rt, amountIn: half });
}
out.keeper = await call('launch/keeper');

// Publisher dry run for vault campaigns: template check, then the table as of the latest block.
out.vaultCampaigns = [];
const vaultRows = await db.query(
  `select c.campaign_id::text as id, c.hub, c.rules_uri, c.created_at, t.token, t.vault, t.quote from campaigns c
   join launch_tokens t on t.chain_id = c.chain_id and t.vault = c.creator where c.chain_id = $1 order by c.campaign_id`,
  [chainId]
);
for (const v of vaultRows) {
  const campaign = await read.readContract({ address: v.hub, abi: PLACE_HUB_ABI, functionName: 'getCampaign', args: [BigInt(v.id)] });
  const text = await fetchIpfsText(v.rules_uri);
  const quote = (await read.readContract({ address: v.vault, abi: CREATOR_VAULT_ABI, functionName: 'quote' })).toLowerCase();
  const template = launchRulesTemplates(chainId).find((x) => x.rulesHash === campaign.rulesHash.toLowerCase());
  const rules = launchCampaignRules(text, { campaign, hub: v.hub, chainId, d: template.release, vault: { address: v.vault, token: v.token, quote }, createdAt: Math.floor(new Date(v.created_at).getTime() / 1000) });
  const block = await read.getBlock({ blockTag: 'latest' });
  const balances = (await db.query('select account, balance::text as balance from launch_balances where chain_id = $1 and token = $2 and balance > 0', [chainId, v.token])).map((b) => ({ account: b.account, balance: BigInt(b.balance) }));
  const autoExclude = await autoExclusions(read, { chainId, hub: v.hub, holders: balances.map((b) => b.account), blockNumber: block.number });
  const table = computeTable({ rules, rulesHash: campaign.rulesHash, campaignId: v.id, block, balances, autoExclude });
  verifyTable(table);
  out.vaultCampaigns.push({
    id: v.id,
    token: v.token,
    snapshotAt: new Date(Number(campaign.snapshotAt) * 1000).toISOString(),
    pool: campaign.pool.toString(),
    rules,
    asOfBlock: block.number.toString(),
    wallets: table.wallets,
    totalAllocated: table.totalAllocated,
    merkleRoot: table.merkleRoot,
    entries: table.entries,
  });
  log(`campaign #${v.id}: template OK, ${table.wallets} wallets, ${table.totalAllocated} of ${campaign.pool} allocated if the snapshot were now`);
}

writeFileSync(arg('out', 'launch-live.json'), JSON.stringify(out, big, 2));
log(`written ${arg('out', 'launch-live.json')}`);
await db.end();
