// Indexer: PlaceHub, NftFactory, Place Launch (../launch/indexer.js) and the NFT launchpad (../launch/nft.js) → database. Two layers:
// 1. indexEvents: event logs in block order (creation, rules, roots, claims, …), with a cursor. Logs come
//    from a node that serves wide eth_getLogs ranges (Alchemy's free tier allows only 10 blocks); the range
//    shrinks on its own when a node refuses it.
// 2. syncHubState: reads open campaigns straight from the hub (getCampaign through Multicall3), so the
//    root, claim window, stage and claimed total are right even if the logs lag behind.
// Every write is idempotent: running a range twice changes nothing.
import { createPublicClient, http, fallback, parseEventLogs } from 'viem';
import { PLACE_HUB_ABI, NFT_FACTORY_ABI } from '../../../src/place/abi.js';
import { deployment } from '../../../src/place/deployments.js';
import { NETWORKS, retry } from './chain.js';
import { launchStartBlock } from '../../../src/launch/deployments.js';
import { acquireLease, releaseLease } from './snapshotJob.js';
import { launchStaticAddresses, launchStaticStarts, collectLaunchLogs, insertFreshTokens, applyLaunchLog } from '../launch/indexer.js';
import { nftStaticAddresses, nftStartBlock, collectNftLogs, applyNftLog } from '../launch/nft.js';

const EVENTS_ABI = [...PLACE_HUB_ABI, ...NFT_FACTORY_ABI].filter((x) => x.type === 'event');
const STAGES = { 1: 'open', 2: 'cancelled', 3: 'refunded', 4: 'finalized' };

// Free nodes that serve eth_getLogs over thousands of blocks. PLACE_LOGS_RPC (comma-separated) overrides.
const LOG_NODES = {
  8453: ['https://base-rpc.publicnode.com'],
  84532: ['https://base-sepolia-rpc.publicnode.com'],
};

export function logsClient(chainId) {
  const urls = (process.env.PLACE_LOGS_RPC || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = urls.length ? urls : LOG_NODES[Number(chainId)];
  return createPublicClient({
    chain: NETWORKS[Number(chainId)].chain,
    // batch: block times and swap senders go out as JSON-RPC batches.
    transport: fallback(list.map((u) => http(u, { timeout: 30_000, retryCount: 1, batch: { batchSize: 50 } }))),
  });
}

const lower = (a) => a.toLowerCase();

// Free log nodes cap the addresses per eth_getLogs (publicnode: 10). PLACE_LOGS_MAX_ADDRESSES overrides.
export const LOGS_MAX_ADDRESSES = Number(process.env.PLACE_LOGS_MAX_ADDRESSES || 10);

/** eth_getLogs over many addresses, LOGS_MAX_ADDRESSES at a time, in block order. */
export async function getLogsChunked(client, addresses, fromBlock, toBlock) {
  const out = [];
  for (let i = 0; i < addresses.length; i += LOGS_MAX_ADDRESSES) {
    out.push(...(await client.getLogs({ address: addresses.slice(i, i + LOGS_MAX_ADDRESSES), fromBlock, toBlock })));
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}
const iso = (seconds) => new Date(Number(seconds) * 1000).toISOString();

function cursorKey(addresses) {
  return `events:${addresses.join(',')}`;
}

/**
 * Where a new cursor starts. A release that adds contracts changes the key; instead of re-reading all history
 * from the earliest start block, it takes over the furthest older cursor whose addresses are all still indexed
 * and goes back only to the earliest start block of the added contracts (every write is idempotent).
 */
async function inheritedCursor(db, chainId, addresses, startBlock, startsOf) {
  const wanted = new Set(addresses.map(lower));
  const rows = await db.query(`select contract, last_block::text as b from indexer_cursors where chain_id = $1 and contract like 'events:%'`, [chainId]);
  let best = null;
  for (const r of rows) {
    const old = r.contract.slice('events:'.length).split(',').filter(Boolean).map(lower);
    if (!old.length || !old.every((a) => wanted.has(a))) continue;
    const b = BigInt(r.b);
    if (!best || b > best.b) best = { b, old: new Set(old) };
  }
  if (!best) return startBlock - 1n;
  const starts = startsOf();
  let from = best.b + 1n;
  for (const a of wanted) {
    if (best.old.has(a)) continue;
    const s = starts.get(a);
    if (s == null) return startBlock - 1n; // unknown start: read everything
    if (s < from) from = s;
  }
  return (from > startBlock ? from : startBlock) - 1n;
}

/**
 * Indexes events from the cursor towards the chain head (minus `confirmations`), until caught up or the
 * time budget runs out. Returns what it covered.
 */
export async function indexEvents({
  db,
  client,
  chainId,
  confirmations = 30n, // ~6 s on Base (200 ms blocks)
  maxRange = 10_000n,
  minRange = 10n,
  budgetMs = 20_000,
}) {
  const d = deployment(chainId);
  const launchStart = launchStartBlock(chainId);
  const hubAddresses = [...d.hubs.map((h) => lower(h.address)), lower(d.nftFactory.address)];
  // One cursor for the hub and the launchpad. Its key lists the static addresses, so adding a contract
  // re-reads history from the earliest start block (every write is idempotent).
  const addresses = [...hubAddresses, ...launchStaticAddresses(chainId), ...nftStaticAddresses(chainId)];
  const hubSet = new Set(hubAddresses);
  const nftStart = nftStartBlock(chainId);
  const startBlock = [...d.hubs.map((h) => h.startBlock), d.nftFactory.startBlock, ...(launchStart != null ? [launchStart] : []), ...(nftStart != null ? [nftStart] : [])].reduce((a, b) => (a < b ? a : b));
  const key = cursorKey(addresses);
  const rows = await db.query('select last_block::text as b from indexer_cursors where chain_id = $1 and contract = $2', [chainId, key]);
  let cursor = rows.length
    ? BigInt(rows[0].b)
    : await inheritedCursor(db, chainId, addresses, startBlock, () => {
        const starts = launchStaticStarts(chainId);
        for (const h of d.hubs) starts.set(lower(h.address), h.startBlock);
        starts.set(lower(d.nftFactory.address), d.nftFactory.startBlock);
        for (const a of nftStaticAddresses(chainId)) starts.set(lower(a), nftStart);
        return starts;
      });

  const head = (await retry(() => client.getBlockNumber())) - confirmations;
  const deadline = Date.now() + budgetMs;
  let range = maxRange;
  let events = 0;
  const from = cursor + 1n;

  while (cursor < head && Date.now() < deadline) {
    const fromBlock = cursor + 1n;
    const toBlock = fromBlock + range - 1n < head ? fromBlock + range - 1n : head;
    let logs;
    let launchPart;
    let nftPart;
    try {
      logs = await getLogsChunked(client, addresses, fromBlock, toBlock);
      launchPart = await collectLaunchLogs({ db, client, chainId, fromBlock, toBlock, staticLogs: logs });
      nftPart = await collectNftLogs({ db, client, chainId, fromBlock, toBlock, staticLogs: logs });
    } catch (e) {
      if (range <= minRange) throw e;
      range = range / 4n > minRange ? range / 4n : minRange; // the node refused the range: ask for less
      continue;
    }
    const hubLogs = parseEventLogs({ abi: EVENTS_ABI, logs: logs.filter((l) => hubSet.has(lower(l.address))), strict: false });
    const parsed = [...hubLogs, ...launchPart.logs, ...nftPart.logs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
    );
    const times = await blockTimes(client, parsed);
    await db.tx(async (q) => {
      if (launchPart.ctx) await insertFreshTokens(q, launchPart.ctx);
      for (const log of parsed) {
        if (log.nft) await applyNftLog(q, log, nftPart.ctx);
        else if (log.launch) await applyLaunchLog(q, log, launchPart.ctx);
        else await applyEvent(q, chainId, log, times);
      }
      await q(
        `insert into indexer_cursors (chain_id, contract, last_block) values ($1, $2, $3)
         on conflict (chain_id, contract) do update set last_block = excluded.last_block, updated_at = now()`,
        [chainId, key, toBlock.toString()]
      );
    });
    events += parsed.length;
    cursor = toBlock;
    if (range < maxRange) range = range * 2n < maxRange ? range * 2n : maxRange;
  }
  return { from, to: cursor, head, events, caughtUp: cursor >= head };
}

async function blockTimes(client, logs) {
  const needed = [...new Set(logs.filter((l) => l.eventName === 'CampaignCreated' || l.eventName === 'CollectionCreated').map((l) => l.blockNumber))];
  const times = new Map();
  for (const n of needed) times.set(n, (await retry(() => client.getBlock({ blockNumber: n }))).timestamp);
  return times;
}

/** Applies one decoded event. Exported for tests. */
export async function applyEvent(q, chainId, log, times = new Map()) {
  const a = log.args;
  const hub = lower(log.address);
  const key = [chainId, hub, a.id?.toString()];
  const where = 'chain_id = $1 and hub = $2 and campaign_id = $3';
  switch (log.eventName) {
    case 'CampaignCreated':
      await q(
        `insert into campaigns (chain_id, hub, campaign_id, creator, kind, target, reward_token, pool, fee, snapshot_at,
           claim_duration, burn_leftover, created_block, created_tx, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (chain_id, hub, campaign_id) do nothing`,
        [
          ...key,
          lower(a.creator),
          Number(a.kind),
          lower(a.target),
          lower(a.rewardToken),
          a.pool.toString(),
          a.fee.toString(),
          iso(a.snapshotAt),
          Number(a.claimDuration),
          a.burnLeftover,
          log.blockNumber.toString(),
          lower(log.transactionHash),
          iso(times.get(log.blockNumber) ?? a.snapshotAt),
        ]
      );
      return;
    case 'CampaignRules':
      await q(`update campaigns set rules_hash = $4, rules_uri = $5, updated_at = now() where ${where}`, [...key, lower(a.rulesHash), a.rulesURI]);
      return;
    case 'MetadataUpdated':
      await q(`update campaigns set metadata_uri = $4, updated_at = now() where ${where}`, [...key, a.metadataURI]);
      return;
    case 'RootPublished':
      await q(
        `update campaigns set merkle_root = $4, total_allocated = $5, claim_end = $6, proofs_uri = $7, updated_at = now() where ${where}`,
        [...key, lower(a.merkleRoot), a.totalAllocated.toString(), iso(a.claimEnd), a.proofsURI]
      );
      return;
    case 'ClaimExtended':
      await q(`update campaigns set claim_end = $4, updated_at = now() where ${where}`, [...key, iso(a.claimEnd)]);
      return;
    case 'Claimed': {
      const inserted = await q(
        `insert into claims (campaign_pk, account, amount, caller, tx, block)
         select pk, $4, $5, $6, $7, $8 from campaigns where ${where}
         on conflict (campaign_pk, account) do nothing returning amount`,
        [...key, lower(a.account), a.amount.toString(), lower(a.caller), lower(log.transactionHash), log.blockNumber.toString()]
      );
      if (inserted.length) {
        // syncHubState may already have written the chain's total, which includes this claim: never add twice.
        await q(
          `update campaigns c set claimed = greatest(c.claimed, (select coalesce(sum(amount), 0) from claims where campaign_pk = c.pk)),
             updated_at = now() where ${where.replace(/chain_id|hub|campaign_id/g, (m) => `c.${m}`)}`,
          key
        );
      }
      return;
    }
    case 'CampaignCancelled':
      await q(`update campaigns set stage = 'cancelled', updated_at = now() where ${where}`, key);
      return;
    case 'Refunded':
      await q(`update campaigns set stage = 'refunded', updated_at = now() where ${where}`, key);
      return;
    case 'Finalized':
      await q(`update campaigns set stage = 'finalized', leftover = $4, updated_at = now() where ${where}`, [...key, a.leftover.toString()]);
      return;
    case 'CollectionCreated':
      await q(
        `insert into nft_collections (chain_id, address, creator, implementation, fee_paid, created_block, created_tx, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (chain_id, address) do nothing`,
        [
          chainId,
          lower(a.collection),
          lower(a.creator),
          lower(a.implementation),
          a.feePaid.toString(),
          log.blockNumber.toString(),
          lower(log.transactionHash),
          iso(times.get(log.blockNumber) ?? 0n),
        ]
      );
      return;
    default:
      return; // ownership and implementation events: nothing to store
  }
}

/**
 * Re-reads every open campaign from its hub and writes what the chain says. Covers any gap in the logs.
 * Returns how many campaigns were checked.
 */
export async function syncHubState({ db, client, chainId, chunk = 100 }) {
  const open = await db.query(
    `select hub, campaign_id::text as id from campaigns where chain_id = $1 and stage = 'open' order by pk`,
    [chainId]
  );
  for (let i = 0; i < open.length; i += chunk) {
    const part = open.slice(i, i + chunk);
    const res = await retry(() =>
      client.multicall({
        contracts: part.map((c) => ({ address: c.hub, abi: PLACE_HUB_ABI, functionName: 'getCampaign', args: [BigInt(c.id)] })),
        allowFailure: false,
      })
    );
    await db.tx(async (q) => {
      for (let j = 0; j < part.length; j++) {
        const c = res[j];
        const hasRoot = c.merkleRoot !== `0x${'0'.repeat(64)}`;
        await q(
          `update campaigns set
             stage = $4,
             claimed = $5,
             merkle_root = $6,
             total_allocated = $7,
             claim_end = $8,
             proofs_uri = $9,
             metadata_uri = $10,
             updated_at = now()
           where chain_id = $1 and hub = $2 and campaign_id = $3`,
          [
            chainId,
            part[j].hub,
            part[j].id,
            STAGES[c.stage] || 'open',
            c.claimed.toString(),
            hasRoot ? lower(c.merkleRoot) : null,
            hasRoot ? c.totalAllocated.toString() : null,
            hasRoot ? iso(c.claimEnd) : null,
            hasRoot ? c.proofsURI : null,
            c.metadataURI,
          ]
        );
      }
    });
  }
  return open.length;
}

/**
 * Read-through freshness for the market endpoints: if the shared cursor was not moved in
 * the last `maxAgeMs`, one caller (a lease, so concurrent requests never index the same range twice) runs a
 * short indexEvents. Everyone else answers from the database right away.
 */
export async function refreshIndex({ db, client, chainId, maxAgeMs = 8_000, budgetMs = 6_000 }) {
  const [row] = await db.query(
    `select max(updated_at) as at from indexer_cursors where chain_id = $1 and contract like 'events:%'`,
    [chainId]
  );
  if (row?.at && Date.now() - new Date(row.at).getTime() < maxAgeMs) return { skipped: 'fresh' };
  const holder = Math.random().toString(36).slice(2);
  const lease = `index:${chainId}`;
  if (!(await acquireLease(db, lease, holder, budgetMs + 30_000))) return { skipped: 'busy' };
  try {
    const out = await indexEvents({ db, client, chainId, budgetMs });
    // Mark the check even when nothing new was there, so the next requests skip it.
    await db.query(`update indexer_cursors set updated_at = now() where chain_id = $1 and contract like 'events:%'`, [chainId]);
    return out;
  } finally {
    await releaseLease(db, lease, holder);
  }
}
