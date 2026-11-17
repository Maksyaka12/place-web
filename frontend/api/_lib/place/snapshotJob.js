// Snapshot service: for every campaign past snapshotAt without a root, compute the table by its
// committed rules, pin it to IPFS, store it, and publish the root from the publisher wallet.
//
// A job moves through steps and saves after each one, so a big token can take many short cron runs:
//   rules     fetch rules from IPFS, check them against rulesHash and the campaign in the hub; campaigns of
//             Place Launch creator vaults commit a shared template instead (src/launch/rules.js)
//   block     find the snapshot block (last block at or before snapshotAt)
//   transfers page through every receiver (ERC-20) or token id (ERC-721) up to that block
//   balances  read balanceOf / ownerOf at that block, a chunk at a time
//   compute   exclusions, allocation, Merkle tree; pin the table; store allocations and tree nodes
//   publish   send publishRoot, wait for it
// Rules that do not match, or a table with nobody in it, end the job as 'rejected': no root is published
// and the creator takes the pool back after 72 h (refundUnpublished).
import { randomBytes } from 'node:crypto';
import { PLACE_HUB_ABI } from '../../../src/place/abi.js';
import { parseCommittedRules, computeTable, canonicalJson } from '../../../src/place/snapshot/index.js';
import { LAUNCH_FACTORY_ABI } from '../../../src/launch/abi.js';
import { V020_CREATOR_VAULT_ABI as CREATOR_VAULT_ABI } from '../../../src/launch/abi.legacy.js'; // launch-vault campaigns are 0.1.0 / 0.2.0
import { launchRulesTemplates } from '../../../src/launch/deployments.js';
import { launchCampaignRules } from '../../../src/launch/rules.js';
import { blockAtTime, transfersPage, erc20BalancesAt, nftHoldingsAt, autoExclusions } from './chain.js';

const ZERO_ROOT = `0x${'0'.repeat(64)}`;
const BALANCE_CHUNK = 2000;
const INSERT_CHUNK = 5000;
const MAX_ATTEMPTS = 20;
const SETTLE_SECONDS = 120n; // wait this long past the snapshot block (time, not blocks: Base makes 5 per second)

class Rejected extends Error {}

/** Creates jobs for campaigns that reached their snapshot time and have no root. */
export async function enqueueDueJobs(db, chainId, now = new Date()) {
  // Launch vault campaigns rejected at the rules step by a publisher that did not know their template yet
  // (before L3) get one more go: the template path never rejects with the old messages.
  const templates = launchRulesTemplates(chainId);
  if (templates.length) {
    await db.query(
      `update snapshot_jobs j set status = 'running', step = 'rules', attempts = 0, error = null, updated_at = now()
       from campaigns c
       where c.pk = j.campaign_pk and c.chain_id = $1 and j.status = 'rejected' and j.rules_json is null
         and c.stage = 'open' and c.merkle_root is null and c.rules_hash = any($2::text[]) and coalesce(j.error, '') not like 'Launch rules:%'`,
      [chainId, templates.map((r) => r.rulesHash)]
    );
  }
  const rows = await db.query(
    `insert into snapshot_jobs (campaign_pk)
     select pk from campaigns
     where chain_id = $1 and stage = 'open' and merkle_root is null and rules_uri is not null and snapshot_at <= $2
     on conflict (campaign_pk) do nothing
     returning campaign_pk`,
    [chainId, now.toISOString()]
  );
  return rows.length;
}

/** A lease row; returns true if this holder now owns it until `ms` from now. */
export async function acquireLease(db, name, holder, ms) {
  const rows = await db.query(
    `insert into job_leases (name, holder, locked_until) values ($1, $2, now() + ($3 || ' milliseconds')::interval)
     on conflict (name) do update set holder = excluded.holder, locked_until = excluded.locked_until
       where job_leases.locked_until < now() or job_leases.holder = excluded.holder
     returning holder`,
    [name, holder, String(ms)]
  );
  return rows.length === 1 && rows[0].holder === holder;
}

export async function releaseLease(db, name, holder) {
  await db.query('delete from job_leases where name = $1 and holder = $2', [name, holder]);
}

/**
 * Runs due jobs until they finish or the time budget is spent.
 * deps: { db, client (viem public client), alchemyKey, fetchFn, ipfs: { pin(text, name), fetch(uri) },
 *         publisher: { address, publishRoot(…), status(hash) } }
 */
export async function runSnapshotJobs({ deps, chainId, budgetMs = 45_000, now = () => new Date() }) {
  const { db } = deps;
  const holder = randomBytes(8).toString('hex');
  const lease = `snapshots:${chainId}`;
  if (!(await acquireLease(db, lease, holder, budgetMs + 30_000))) return { skipped: 'another run holds the lease' };
  const deadline = Date.now() + budgetMs;
  const report = { enqueued: 0, advanced: 0, published: [], rejected: [], errors: [] };
  try {
    report.enqueued = await enqueueDueJobs(db, chainId, now());
    const jobs = await db.query(
      `select j.campaign_pk::text as pk from snapshot_jobs j join campaigns c on c.pk = j.campaign_pk
       where j.status = 'running' and c.chain_id = $1 order by c.snapshot_at, j.campaign_pk`,
      [chainId]
    );
    for (const { pk } of jobs) {
      while (Date.now() < deadline) {
        const job = await loadJob(db, pk);
        if (job.status !== 'running') break;
        try {
          const result = await advance(deps, chainId, job);
          report.advanced++;
          await db.query('update snapshot_jobs set attempts = 0, error = null where campaign_pk = $1', [pk]);
          if (result === 'wait') break; // a transaction is pending: next job, come back next run
        } catch (e) {
          if (e instanceof Rejected) {
            await db.query(`update snapshot_jobs set status = 'rejected', error = $2, updated_at = now() where campaign_pk = $1`, [pk, e.message]);
            report.rejected.push({ pk, reason: e.message });
          } else {
            const [row] = await db.query(
              `update snapshot_jobs set attempts = attempts + 1, error = $2,
                 status = case when attempts + 1 >= $3 then 'failed' else status end, updated_at = now()
               where campaign_pk = $1 returning attempts`,
              [pk, String(e.message || e).slice(0, 1000), MAX_ATTEMPTS]
            );
            report.errors.push({ pk, error: e.message, attempts: row.attempts });
          }
          break; // next job; this one retries on the next run
        }
        const after = await loadJob(db, pk);
        if (after.status === 'published') {
          report.published.push({ pk, root: after.merkle_root, tx: after.publish_tx });
          break;
        }
      }
      if (Date.now() >= deadline) break;
    }
  } finally {
    await releaseLease(db, lease, holder);
  }
  return report;
}

async function loadJob(db, pk) {
  const [job] = await db.query(
    `select j.*, j.campaign_pk::text as pk, j.snapshot_block::text as snapshot_block, j.total_allocated::text as total_allocated,
       c.hub, c.campaign_id::text as campaign_id, c.rules_uri, c.rules_hash, c.target, c.kind, c.snapshot_at, c.creator, c.created_at
     from snapshot_jobs j join campaigns c on c.pk = j.campaign_pk where j.campaign_pk = $1`,
    [pk]
  );
  return job;
}

const setJob = (db, pk, fields) => {
  const keys = Object.keys(fields);
  return db.query(
    `update snapshot_jobs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where campaign_pk = $1`,
    [pk, ...keys.map((k) => fields[k])]
  );
};

async function onchainCampaign(client, job) {
  return client.readContract({ address: job.hub, abi: PLACE_HUB_ABI, functionName: 'getCampaign', args: [BigInt(job.campaign_id)] });
}

/**
 * If the campaign commits a Place Launch template, the vault that created it: only a factory vault is the
 * fee recipient of a launch token, so the factory's creatorRights(target) proves it. The factory is the one of
 * the release whose template the campaign commits. Null for other campaigns.
 */
async function launchVaultOf(client, chainId, c) {
  const template = launchRulesTemplates(chainId).find((r) => r.rulesHash === c.rulesHash.toLowerCase());
  if (!template) return null;
  const d = template.release;
  let rights;
  try {
    rights = await client.readContract({ address: d.factory, abi: LAUNCH_FACTORY_ABI, functionName: 'creatorRights', args: [c.target] });
  } catch (e) {
    if (/UnknownLaunchToken|reverted/i.test(e.shortMessage || e.message)) throw new Rejected('Launch rules: target is not a Place Launch token');
    throw e;
  }
  if (rights.creatorFeeRecipient.toLowerCase() !== c.creator.toLowerCase()) throw new Rejected('Launch rules: campaign creator is not the launch token creator vault');
  const quote = await client.readContract({ address: c.creator, abi: CREATOR_VAULT_ABI, functionName: 'quote' });
  return { address: c.creator.toLowerCase(), token: c.target.toLowerCase(), quote: quote.toLowerCase(), release: d };
}

/** Does one step of a job. Exported for tests. */
export async function advance(deps, chainId, job) {
  const { db, client } = deps;
  const pk = job.pk;
  switch (job.step) {
    case 'rules': {
      const c = await onchainCampaign(client, job);
      if (c.merkleRoot !== ZERO_ROOT) {
        await setJob(db, pk, { status: 'published', step: 'done', merkle_root: c.merkleRoot.toLowerCase() });
        return;
      }
      const text = await deps.ipfs.fetch(job.rules_uri); // a gateway failure is retried, not a rejection
      const vault = await launchVaultOf(client, chainId, c);
      if (vault) {
        let rules;
        try {
          rules = launchCampaignRules(text, { campaign: c, hub: job.hub, chainId, d: vault.release, vault, createdAt: Math.floor(new Date(job.created_at).getTime() / 1000) });
        } catch (e) {
          throw new Rejected(e.message);
        }
        await setJob(db, pk, { rules_json: canonicalJson(rules), step: 'block' });
        return;
      }
      try {
        parseCommittedRules(text, { campaign: c, hub: job.hub, chainId });
      } catch (e) {
        throw new Rejected(e.message);
      }
      await setJob(db, pk, { rules_json: text, step: 'block' });
      return;
    }
    case 'block': {
      const block = await blockAtTime(client, Math.floor(new Date(job.snapshot_at).getTime() / 1000));
      // Let the chain move on before reading transfers, so the transfer index surely covers the snapshot block.
      const head = await client.getBlock({ blockTag: 'latest' });
      if (head.timestamp < block.timestamp + SETTLE_SECONDS) return 'wait';
      await setJob(db, pk, { snapshot_block: block.number.toString(), snapshot_time: new Date(Number(block.timestamp) * 1000).toISOString(), step: 'transfers' });
      return;
    }
    case 'transfers': {
      const nft = Number(job.kind) === 1;
      const page = await transfersPage({
        chainId,
        key: deps.alchemyKey,
        contract: job.target,
        category: nft ? 'erc721' : 'erc20',
        toBlock: BigInt(job.snapshot_block),
        pageKey: job.page_key,
        fetchFn: deps.fetchFn,
      });
      await db.tx(async (q) => {
        if (nft) await insertChunks(q, 'snapshot_token_ids', 'token_id', 'numeric', pk, [...new Set(page.tokenIds.map(String))]);
        else await insertChunks(q, 'snapshot_candidates', 'account', 'text', pk, [...new Set(page.receivers)]);
        await q(`update snapshot_jobs set page_key = $2, step = $3, updated_at = now() where campaign_pk = $1`, [
          pk,
          page.pageKey,
          page.pageKey ? 'transfers' : 'balances',
        ]);
      });
      return;
    }
    case 'balances': {
      const nft = Number(job.kind) === 1;
      const block = BigInt(job.snapshot_block);
      if (nft) {
        const ids = await db.query(
          `select token_id::text as id from snapshot_token_ids where campaign_pk = $1 and ($2::numeric is null or token_id > $2::numeric)
           order by token_id limit ${BALANCE_CHUNK}`,
          [pk, job.balance_cursor]
        );
        const holdings = await nftHoldingsAt(client, job.target, ids.map((r) => BigInt(r.id)), block);
        await db.tx(async (q) => {
          for (const h of holdings) {
            await q(
              `insert into snapshot_balances (campaign_pk, account, balance) values ($1, $2, $3)
               on conflict (campaign_pk, account) do update set balance = snapshot_balances.balance + excluded.balance`,
              [pk, h.account, h.balance.toString()]
            );
          }
          await q(`update snapshot_jobs set balance_cursor = $2, step = $3, updated_at = now() where campaign_pk = $1`, [
            pk,
            ids.length ? ids[ids.length - 1].id : job.balance_cursor,
            ids.length < BALANCE_CHUNK ? 'compute' : 'balances',
          ]);
        });
        return;
      }
      const rows = await db.query(
        `select account from snapshot_candidates where campaign_pk = $1 and ($2::text is null or account > $2::text)
         order by account limit ${BALANCE_CHUNK}`,
        [pk, job.balance_cursor]
      );
      const accounts = rows.map((r) => r.account).filter((a) => a !== '0x0000000000000000000000000000000000000000');
      const balances = accounts.length ? await erc20BalancesAt(client, job.target, accounts, block) : [];
      await db.tx(async (q) => {
        const positive = balances.filter((b) => b.balance > 0n);
        for (let i = 0; i < positive.length; i += INSERT_CHUNK) {
          const part = positive.slice(i, i + INSERT_CHUNK);
          await q(
            `insert into snapshot_balances (campaign_pk, account, balance)
             select $1, a, b::numeric from unnest($2::text[], $3::text[]) as t(a, b)
             on conflict (campaign_pk, account) do update set balance = excluded.balance`,
            [pk, part.map((b) => b.account), part.map((b) => b.balance.toString())]
          );
        }
        await q(`update snapshot_jobs set balance_cursor = $2, step = $3, updated_at = now() where campaign_pk = $1`, [
          pk,
          rows.length ? rows[rows.length - 1].account : job.balance_cursor,
          rows.length < BALANCE_CHUNK ? 'compute' : 'balances',
        ]);
      });
      return;
    }
    case 'compute': {
      const rules = JSON.parse(job.rules_json);
      const balances = (await db.query(`select account, balance::text as balance from snapshot_balances where campaign_pk = $1`, [pk])).map((r) => ({
        account: r.account,
        balance: BigInt(r.balance),
      }));
      const min = BigInt(rules.minBalance);
      const holders = balances.filter((b) => b.balance >= min).map((b) => b.account);
      const block = { number: BigInt(job.snapshot_block), timestamp: BigInt(Math.floor(new Date(job.snapshot_time).getTime() / 1000)) };
      const autoExclude = await autoExclusions(client, { chainId, hub: job.hub, holders, blockNumber: block.number });
      let table;
      try {
        table = computeTable({ rules, rulesHash: job.rules_hash, campaignId: job.campaign_id, block, balances, autoExclude });
      } catch (e) {
        if (/No eligible wallets/.test(e.message)) throw new Rejected(e.message);
        throw e;
      }
      // The table has no timestamps, so the same snapshot always pins to the same CID.
      const proofsURI = await deps.ipfs.pin(JSON.stringify(table), `place-${chainId}-${job.hub}-${job.campaign_id}-table.json`);
      await storeTable(db, pk, table);
      await setJob(db, pk, {
        merkle_root: table.merkleRoot,
        total_allocated: table.totalAllocated,
        wallets: table.wallets,
        proofs_uri: proofsURI,
        step: 'publish',
      });
      return;
    }
    case 'publish': {
      const pub = deps.publisher;
      if (job.publish_tx) {
        const status = await waitMined(pub, job.publish_tx, deps.receiptWaitMs ?? 30_000);
        if (status === null) return 'wait'; // still pending: look again on the next run
        if (status === 'reverted') await setJob(db, pk, { publish_tx: null });
      }
      const c = await onchainCampaign(client, job);
      if (c.merkleRoot.toLowerCase() === job.merkle_root) {
        await finish(db, pk, job, c);
        return;
      }
      if (c.merkleRoot !== ZERO_ROOT && c.claimed > 0n) {
        throw new Rejected(`A different root ${c.merkleRoot} is already live with claims`);
      }
      if (job.publish_tx && (await pub.status(job.publish_tx)) === 'success') {
        throw new Error('publishRoot succeeded but the hub shows another root');
      }
      const hash = await pub.publishRoot({
        hub: job.hub,
        campaignId: job.campaign_id,
        root: job.merkle_root,
        totalAllocated: job.total_allocated,
        proofsURI: job.proofs_uri,
      });
      await setJob(db, pk, { publish_tx: hash });
      return; // the next call waits for the receipt and checks the hub
    }
    default:
      throw new Error(`Unknown step ${job.step}`);
  }
}

async function waitMined(pub, hash, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const s = await pub.status(hash);
    if (s !== null || Date.now() >= until) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function finish(db, pk, job, c) {
  await db.tx(async (q) => {
    await q(`update snapshot_jobs set status = 'published', step = 'done', updated_at = now() where campaign_pk = $1`, [pk]);
    await q(
      `update campaigns set merkle_root = $2, total_allocated = $3, claim_end = $4, proofs_uri = $5, updated_at = now() where pk = $1`,
      [pk, job.merkle_root, job.total_allocated, new Date(Number(c.claimEnd) * 1000).toISOString(), job.proofs_uri]
    );
    await q('delete from snapshot_candidates where campaign_pk = $1', [pk]);
    await q('delete from snapshot_token_ids where campaign_pk = $1', [pk]);
    await q('delete from snapshot_balances where campaign_pk = $1', [pk]);
  });
}

async function insertChunks(q, table, column, type, pk, values) {
  for (let i = 0; i < values.length; i += INSERT_CHUNK) {
    await q(
      `insert into ${table} (campaign_pk, ${column}) select $1, v::${type} from unnest($2::text[]) as t(v) on conflict do nothing`,
      [pk, values.slice(i, i + INSERT_CHUNK)]
    );
  }
}

/** Replaces the stored table: one row per wallet with its leaf index, and every tree node for proofs. */
export async function storeTable(db, pk, table) {
  const leafIndex = new Map(table.tree.values.map((v) => [v.value[3], v.treeIndex]));
  await db.tx(async (q) => {
    await q('delete from allocations where campaign_pk = $1', [pk]);
    await q('delete from tree_nodes where campaign_pk = $1', [pk]);
    for (let i = 0; i < table.entries.length; i += INSERT_CHUNK) {
      const part = table.entries.slice(i, i + INSERT_CHUNK);
      await q(
        `insert into allocations (campaign_pk, account, amount, balance, capped, leaf_index)
         select $1, a, m::numeric, b::numeric, c, l from unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::int[]) as t(a, m, b, c, l)`,
        [pk, part.map((e) => e.account), part.map((e) => e.amount), part.map((e) => e.balance), part.map((e) => e.capped), part.map((e) => leafIndex.get(e.account))]
      );
    }
    const nodes = table.tree.tree;
    for (let i = 0; i < nodes.length; i += INSERT_CHUNK) {
      const part = nodes.slice(i, i + INSERT_CHUNK);
      await q(
        `insert into tree_nodes (campaign_pk, idx, hash) select $1, i, h from unnest($2::int[], $3::text[]) as t(i, h)`,
        [pk, part.map((_, j) => i + j), part]
      );
    }
  });
}

/** Proof for a leaf from stored tree nodes (OpenZeppelin layout: children of i are 2i+1 and 2i+2). */
export async function proofFromDb(db, pk, leafIndex) {
  const path = [];
  for (let i = leafIndex; i > 0; i = Math.floor((i - 1) / 2)) path.push(i % 2 === 1 ? i + 1 : i - 1);
  if (!path.length) return [];
  const rows = await db.query('select idx, hash from tree_nodes where campaign_pk = $1 and idx = any($2::int[])', [pk, path]);
  const byIdx = new Map(rows.map((r) => [Number(r.idx), r.hash]));
  return path.map((i) => {
    if (!byIdx.has(i)) throw new Error(`Tree node ${i} missing for campaign ${pk}`);
    return byIdx.get(i);
  });
}
