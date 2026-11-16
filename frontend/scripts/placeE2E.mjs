// End-to-end check of Place on Base Sepolia, with real contracts, Alchemy, Pinata and Neon:
//   1. deploy a test ERC-20 and give it to a few wallets;
//   2. pin campaign rules to IPFS and create a campaign in PlaceHub (snapshot in ~2 minutes, ETH reward);
//   3. wait, index the events, run the snapshot service until the root is published;
//   4. claim two allocations with proofs from the database.
// Uses the publisher wallet (PUBLISHER_PRIVATE_KEY in frontend/.env) as the campaign creator too, so no
// other key is needed. Costs a little Base Sepolia ETH. Run from frontend/:  node scripts/placeE2E.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { getDb, migrate } from '../api/_lib/place/db.js';
import { chainClient, alchemyUrl } from '../api/_lib/place/chain.js';
import { indexEvents, logsClient } from '../api/_lib/place/indexer.js';
import { runSnapshotJobs, proofFromDb } from '../api/_lib/place/snapshotJob.js';
import { makePublisher } from '../api/_lib/place/publisher.js';
import { pinText, fetchIpfsText } from '../api/_lib/place/ipfs.js';
import { PLACE_HUB_ABI } from '../src/place/abi.js';
import { DATA_SUFFIX } from '../src/config/builderCode.js';
import { activeHub } from '../src/place/deployments.js';
import { buildRules, encodeRules } from '../src/place/snapshot/index.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const CHAIN = 84532;
const key = process.env.ALCHEMY_API_KEY;
const hub = activeHub(CHAIN).address;
const account = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(alchemyUrl(CHAIN, key)), dataSuffix: DATA_SUFFIX });
const client = chainClient({ chainId: CHAIN, key });
const t0 = Date.now();
const log = (m) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = async (label, hash) => {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  log(`${label}: https://sepolia.basescan.org/tx/${hash}`);
  return r;
};

const { abi: tokenAbi, bytecode } = JSON.parse(readFileSync('../contracts/out/Mocks.sol/MockERC20.json', 'utf8'));
const DEPLOYER = '0x9F687A81012e8039679b43BD7A910b5Cf4bb6fC4';
const e18 = 10n ** 18n;
const holders = [
  [DEPLOYER, 500n * e18],
  [account.address, 300n * e18],
  ['0x000000000000000000000000000000000000beef', 200n * e18],
  ['0x000000000000000000000000000000000000cafe', 5n * e18], // under the minimum
];

log(`creator and publisher: ${account.address}, balance ${formatEther(await client.getBalance({ address: account.address }))} ETH`);

// 1. Test token.
const deployHash = await wallet.deployContract({ abi: tokenAbi, bytecode: bytecode.object, args: ['Place Test', 'PTEST'] });
const token = (await tx('token deployed', deployHash)).contractAddress;
for (const [to, amount] of holders) {
  await tx(`minted ${amount / e18} PTEST to ${to.slice(0, 8)}…`, await wallet.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [to, amount] }));
}

// 2. Rules on IPFS and the campaign.
const head = await client.getBlock({ blockTag: 'latest' });
const snapshotAt = Number(head.timestamp) + 120;
const pool = parseEther('0.0001');
const rules = buildRules({
  chainId: CHAIN,
  hub,
  kind: 'token-holders',
  target: token,
  rewardToken: 'eth',
  pool,
  snapshotAt,
  claimDuration: 86400,
  minBalance: 10n * e18,
  distribution: 'proportional',
  maxPerWallet: null,
  exclude: [],
  leftover: 'return',
});
const { json, rulesHash } = encodeRules(rules);
const rulesURI = await pinText(json, { name: `place-e2e-rules-${token}.json` });
log(`rules pinned: ${rulesURI}`);
const fee = (pool * 500n) / 10_000n;
const createHash = await wallet.writeContract({
  address: hub,
  abi: PLACE_HUB_ABI,
  functionName: 'createCampaign',
  args: [{ kind: 0, target: token, rewardToken: '0x0000000000000000000000000000000000000000', pool, snapshotAt: BigInt(snapshotAt), claimDuration: 86400, burnLeftover: false, rulesHash, rulesURI, metadataURI: '' }],
  value: pool + fee,
});
await tx('campaign created', createHash);
const campaignId = (await client.readContract({ address: hub, abi: PLACE_HUB_ABI, functionName: 'campaignCount' })) - 1n;
log(`campaign #${campaignId}, snapshot at ${new Date(snapshotAt * 1000).toISOString()}`);

// 3. Index, wait, run the snapshot service.
const db = await getDb();
await migrate(db);
const deps = {
  db,
  client,
  alchemyKey: key,
  fetchFn: fetch,
  ipfs: { pin: (text, name) => pinText(text, { name }), fetch: (uri) => fetchIpfsText(uri) },
  publisher: makePublisher({ chainId: CHAIN, alchemyKey: key, readClient: client }),
};
let published = null;
while (!published && Date.now() - t0 < 15 * 60_000) {
  await indexEvents({ db, client: logsClient(CHAIN), chainId: CHAIN, budgetMs: 30_000 });
  const report = await runSnapshotJobs({ deps, chainId: CHAIN, budgetMs: 60_000 });
  const [job] = await db.query(
    `select j.status, j.step, j.error, j.merkle_root, j.wallets, j.proofs_uri, j.publish_tx from snapshot_jobs j join campaigns c on c.pk = j.campaign_pk
     where c.chain_id = $1 and c.hub = $2 and c.campaign_id = $3`,
    [CHAIN, hub.toLowerCase(), campaignId.toString()]
  );
  log(job ? `job: ${job.status} / ${job.step}${job.error ? ` (${job.error})` : ''}` : 'job: not due yet');
  if (report.rejected.length) throw new Error(`rejected: ${report.rejected[0].reason}`);
  if (job?.status === 'published') published = job;
  else await sleep(20_000);
}
if (!published) throw new Error('not published within 15 minutes');
log(`root ${published.merkle_root}, ${published.wallets} wallets, table ${published.proofs_uri}`);
log(`publishRoot: https://sepolia.basescan.org/tx/${published.publish_tx}`);

// 4. Claims with proofs from the database.
const [{ pk }] = await db.query('select pk::text as pk from campaigns where chain_id = $1 and hub = $2 and campaign_id = $3', [CHAIN, hub.toLowerCase(), campaignId.toString()]);
const rows = await db.query('select account, amount::text as amount, leaf_index from allocations where campaign_pk = $1 order by amount desc', [pk]);
for (const r of rows) log(`  ${r.account}  ${formatEther(BigInt(r.amount))} ETH`);
for (const who of [account.address, DEPLOYER]) {
  const row = rows.find((r) => r.account === who.toLowerCase());
  const proof = await proofFromDb(db, pk, row.leaf_index);
  const ok = await client.readContract({ address: hub, abi: PLACE_HUB_ABI, functionName: 'canClaim', args: [who, campaignId, BigInt(row.amount), proof] });
  if (!ok) throw new Error(`canClaim is false for ${who}`);
  await tx(`claimed ${formatEther(BigInt(row.amount))} ETH for ${who.slice(0, 8)}…`, await wallet.writeContract({ address: hub, abi: PLACE_HUB_ABI, functionName: 'claimFor', args: [who, campaignId, BigInt(row.amount), proof] }));
}
const status = await client.readContract({ address: hub, abi: PLACE_HUB_ABI, functionName: 'statusOf', args: [campaignId] });
const c = await client.readContract({ address: hub, abi: PLACE_HUB_ABI, functionName: 'getCampaign', args: [campaignId] });
log(`hub: status ${status} (4 = Live), claimed ${formatEther(c.claimed)} of ${formatEther(c.totalAllocated)} ETH`);
await db.end();
