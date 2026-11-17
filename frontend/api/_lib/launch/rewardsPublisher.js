// The daily rewards publisher of Place Launch 0.3.0 (PlaceRewardsDistributor).
//
// After the keeper closes a UTC day of a stream (EpochClosed: the day's tax is in, converted and funded), this
// job builds the stream's next table and publishes its cumulative Merkle root:
//   holders   balances at the last block of the day ≥ the stream's criterion (minHolding), from the indexed
//             transfers; not people: PoolManager, hooks, FeeEscrows, 0x…dEaD, the rewards distributors,
//             PlaceStaking and the token's own vaults. Paid in proportion to the balance. Tokens not launched on
//             Place (streams anyone made with createStream): ERC-20 balances, or NFT counts of collections made by
//             the Place NFT factory, at the same block from Alchemy transfers (externalTarget, externalDayWeights).
//   traders   the day's counted Trade.quoteVolume per trader ≥ the criterion (minimum daily volume); swaps of
//             the distributor and the vaults are not counted (indexer). Paid in proportion to the volume. Only
//             Place 0.3.0 launches: other tokens have no Trade events to count (their streams are "unsupported" and
//             the funder reclaims the budget 30 days after the last day).
// The day's budget is everything funded and not yet allocated (funded − cumulativeTotal); when several days are
// closed together each day with someone eligible gets an equal part. A day without anyone eligible leaves the
// budget for the next day (status 'empty', no root).
// Leaves are keccak256(bytes.concat(keccak256(abi.encode(streamId, account, cumulativeAmount)))), i.e.
// OpenZeppelin's StandardMerkleTree over (bytes32, address, uint256), with the cumulative amount of every account
// that ever earned. The table is pinned on IPFS and all new roots go out in one publishRoots per distributor.
//
// States of reward_tables: built → sent → published (indexer, RootPublished) | failed (reverted: built again).
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { parseAbi } from 'viem';
import { deployedReleases, launchReleases } from '../../../src/launch/deployments.js';
import { retry, collectHolders } from '../place/chain.js';
import { releaseGeneration, EPOCH } from './indexer.js';
import { UNSUPPORTED } from './hub.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const LEAF = ['bytes32', 'address', 'uint256'];
export const TABLE_SCHEMA = 'place.rewards-table/1';

/** Not people for holder tables of `token` (row: launch_tokens + launch_economy). */
export function notHolders(chainId, row) {
  const list = launchReleases(chainId);
  return new Set(
    [ZERO, DEAD, list[0].poolManager, ...list.flatMap((r) => [r.hook, r.feeEscrow, r.rewardsDistributor, r.staking, r.launchBuyAdapter]), row?.vault, row?.creator_vault, row?.community_vault]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );
}

/** The last block of a UTC day (timestamp < (epoch + 1) days), found by binary search and cached. Null if the day is not over on chain. */
export async function lastBlockOfDay(db, client, chainId, epoch) {
  const [hit] = await db.query('select block::text as block from launch_epoch_blocks where chain_id = $1 and epoch = $2', [chainId, epoch]);
  if (hit) return BigInt(hit.block);
  const end = BigInt((epoch + 1) * EPOCH);
  const time = async (n) => BigInt((await retry(() => client.getBlock({ blockNumber: n }))).timestamp);
  const head = await retry(() => client.getBlockNumber());
  if ((await time(head)) < end) return null;
  const [prev] = await db.query('select block::text as block from launch_epoch_blocks where chain_id = $1 and epoch < $2 order by epoch desc limit 1', [chainId, epoch]);
  let lo = prev ? BigInt(prev.block) : 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await time(mid)) < end) lo = mid;
    else hi = mid - 1n;
  }
  await db.query('insert into launch_epoch_blocks (chain_id, epoch, block) values ($1, $2, $3) on conflict do nothing', [chainId, epoch, lo.toString()]);
  return lo;
}

/** Eligible accounts of one day with their weights (bigint), sorted by account. */
async function dayWeights(db, client, chainId, stream, row, epoch, indexedBlock) {
  const criterion = BigInt(stream.criterion);
  if (Number(stream.kind) === 1) {
    const rows = await db.query(
      `select trader as account, volume::text as w from launch_trader_volume where chain_id = $1 and token = $2 and epoch = $3 and volume > 0 and volume >= $4 order by trader`,
      [chainId, stream.token, epoch, criterion.toString()]
    );
    const skip = notHolders(chainId, row);
    return { ready: true, weights: rows.filter((r) => !skip.has(r.account)).map((r) => [r.account, BigInt(r.w)]) };
  }
  const block = await lastBlockOfDay(db, client, chainId, epoch);
  if (block == null || block > indexedBlock) return { ready: false };
  const rows = await db.query(
    `select account, sum(delta)::text as w from (
       select to_addr as account, amount as delta from launch_transfers where chain_id = $1 and token = $2 and block <= $3
       union all
       select from_addr as account, -amount as delta from launch_transfers where chain_id = $1 and token = $2 and block <= $3
     ) x group by account having sum(delta) > 0 and sum(delta) >= $4 order by account`,
    [chainId, stream.token, block.toString(), criterion.toString()]
  );
  const skip = notHolders(chainId, row);
  return { ready: true, block, weights: rows.filter((r) => !skip.has(r.account)).map((r) => [r.account, BigInt(r.w)]) };
}

/** Most transfer pages (1,000 transfers each) one table of a token not launched on Place may walk. */
export const EXTERNAL_MAX_PAGES = 200;
const ERC165_ABI = parseAbi(['function supportsInterface(bytes4) view returns (bool)']);

/**
 * How Place builds tables for a stream whose token was not launched on Place: ERC-20 holders, or holders of
 * a collection made by the Place NFT factory. Trader streams and other NFT collections are not supported.
 */
export async function externalTarget(db, client, chainId, s) {
  if (Number(s.kind) === 1) return { unsupported: UNSUPPORTED.traders };
  const [collection] = await db.query('select creator from nft_collections where chain_id = $1 and address = $2', [chainId, s.token]);
  if (collection) return { kind: 'nft-holders' };
  const [meta] = await db.query('select is_nft from token_meta where chain_id = $1 and address = $2', [chainId, s.token]);
  let nft = meta?.is_nft ?? null;
  if (nft == null) nft = await retry(() => client.readContract({ address: s.token, abi: ERC165_ABI, functionName: 'supportsInterface', args: ['0x80ac58cd'] })).catch(() => false);
  return nft ? { unsupported: UNSUPPORTED.nft } : { kind: 'token-holders' };
}

/**
 * Holders of a token not launched on Place at the last block of a day: every receiver from Alchemy's transfer
 * index (no eth_getLogs ranges), then balanceOf (ERC-20) or ownerOf over every token id (ERC-721) at that block.
 * Pools (token0/token1), the PoolManager, zero / dead and Place contracts are left out.
 */
async function externalDayWeights({ db, client, chainId, stream, target, epoch, alchemyKey, fetchFn }) {
  const block = await lastBlockOfDay(db, client, chainId, epoch);
  if (block == null) return { ready: false };
  const min = BigInt(stream.criterion) > 0n ? BigInt(stream.criterion) : 1n;
  const { balances, autoExclude } = await collectHolders({
    client, chainId, key: alchemyKey, kind: target.kind, target: stream.token, hub: stream.distributor, block: { number: block }, minBalance: min, fetchFn, maxPages: EXTERNAL_MAX_PAGES,
  });
  const skip = notHolders(chainId, null);
  const weights = balances
    .filter((b) => b.balance > 0n && b.balance >= min && !autoExclude.has(b.account) && !skip.has(b.account))
    .map((b) => [b.account, b.balance])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return { ready: true, block, weights };
}

/** Splits `budget` over weights pro rata (floor); returns Map(account → amount). */
export function proRata(weights, budget) {
  const out = new Map();
  const total = weights.reduce((s, [, w]) => s + w, 0n);
  if (total === 0n || budget === 0n) return out;
  for (const [a, w] of weights) {
    const v = (budget * w) / total;
    if (v > 0n) out.set(a, v);
  }
  return out;
}

/**
 * Builds the cumulative table of one stream from its last published table and the new days. Pure: no IO.
 * prev: Map(account → cumulative); days: [{ epoch, weights }]; budget: bigint (funded − previous total).
 */
export function buildTable({ streamId, prev, days, budget }) {
  const eligibleDays = days.filter((d) => d.weights.length);
  const amounts = new Map();
  const dayInfo = days.map((d) => ({ epoch: d.epoch, eligible: d.weights.length, budget: '0' }));
  if (eligibleDays.length && budget > 0n) {
    const share = budget / BigInt(eligibleDays.length);
    eligibleDays.forEach((d, i) => {
      const part = i === eligibleDays.length - 1 ? budget - share * BigInt(eligibleDays.length - 1) : share;
      dayInfo.find((x) => x.epoch === d.epoch).budget = part.toString();
      for (const [a, v] of proRata(d.weights, part)) amounts.set(a, (amounts.get(a) ?? 0n) + v);
    });
  }
  const accounts = [...new Set([...prev.keys(), ...amounts.keys()])].sort();
  const entries = accounts.map((account) => {
    const amount = amounts.get(account) ?? 0n;
    return { account, amount, cumulative: (prev.get(account) ?? 0n) + amount };
  });
  const allocatedNow = [...amounts.values()].reduce((s, v) => s + v, 0n);
  const cumulativeTotal = entries.reduce((s, e) => s + e.cumulative, 0n);
  if (!allocatedNow || !entries.length) return { empty: true, days: dayInfo, cumulativeTotal, entries, allocatedNow };
  const tree = StandardMerkleTree.of(entries.map((e) => [streamId, e.account, e.cumulative.toString()]), LEAF);
  const proofs = new Map();
  for (const [i, v] of tree.entries()) proofs.set(v[1].toLowerCase(), tree.getProof(i));
  return { empty: false, root: tree.root, days: dayInfo, cumulativeTotal, entries, proofs, allocatedNow };
}

const jsonText = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * One publisher pass for a chain. deps: { db, client, chainId, ipfs: { pin(text, name) }, publisher (with
 * publishRoots and status), now (unix s) }. Returns what it did per stream.
 */
export async function runRewardsPublisher({ db, client, chainId, ipfs, publisher, alchemyKey = null, fetchFn = fetch, budgetMs = 30_000 }) {
  const distributors = deployedReleases(chainId).filter((r) => releaseGeneration(r.version) >= 3 && r.rewardsDistributor).map((r) => r.rewardsDistributor);
  if (!distributors.length) return { skipped: 'no 0.3.0 rewards distributor deployed' };
  const started = Date.now();
  const out = { built: [], empty: [], sent: [], failed: [], waiting: [], unsupported: [] };

  // 1. Sent tables: a reverted transaction makes them failed (built again below); mined ones wait for the indexer.
  for (const t of await db.query(`select stream_id, epoch::text as epoch, tx from reward_tables where chain_id = $1 and status = 'sent'`, [chainId])) {
    const status = publisher && t.tx ? await publisher.status(t.tx) : null;
    if (status === 'reverted') {
      await db.query(`update reward_tables set status = 'failed', error = 'publishRoots reverted' where chain_id = $1 and stream_id = $2 and epoch = $3`, [chainId, t.stream_id, t.epoch]);
      out.failed.push(t.stream_id);
    }
  }

  // 2. New tables for streams with closed days after their last final table.
  const [cursor] = await db.query("select max(last_block)::text as b from indexer_cursors where chain_id = $1 and contract like 'events:%'", [chainId]);
  const indexedBlock = cursor?.b == null ? -1n : BigInt(cursor.b);
  const streams = await db.query(
    `select s.*, s.criterion::text as criterion, s.funded::text as funded, s.allocated::text as allocated, s.start_epoch::text as start_epoch,
            s.last_closed_epoch::text as last_closed_epoch,
            (select max(epoch) from reward_tables t where t.chain_id = s.chain_id and t.stream_id = s.stream_id and t.status in ('published', 'empty'))::text as final_epoch,
            (select count(*)::int from reward_tables t where t.chain_id = s.chain_id and t.stream_id = s.stream_id and t.status in ('built', 'sent')) as in_flight
     from reward_streams s where s.chain_id = $1 and s.distributor = any($2::text[]) and s.last_closed_epoch >= s.start_epoch order by s.created_block`,
    [chainId, distributors]
  );
  for (const s of streams) {
    if (Date.now() - started > budgetMs) break;
    if (s.in_flight) {
      out.waiting.push(s.stream_id);
      continue;
    }
    const from = Math.max(Number(s.start_epoch), (s.final_epoch == null ? Number(s.start_epoch) - 1 : Number(s.final_epoch)) + 1);
    const to = Number(s.last_closed_epoch);
    if (from > to) continue;
    // Where the distributor stands now: its root must be one of our tables, its leaves are the baseline.
    let prev = new Map();
    let prevTotal = 0n;
    if (s.root) {
      const [base] = await db.query(`select epoch::text as epoch, cumulative_total::text as total from reward_tables where chain_id = $1 and stream_id = $2 and root = $3 order by epoch desc limit 1`, [chainId, s.stream_id, s.root]);
      if (!base) {
        out.waiting.push(s.stream_id); // a root this database did not build: never overwrite it blindly
        continue;
      }
      prevTotal = BigInt(base.total);
      prev = new Map((await db.query(`select account, cumulative::text as c from reward_allocations where chain_id = $1 and stream_id = $2 and epoch = $3`, [chainId, s.stream_id, base.epoch])).map((r) => [r.account, BigInt(r.c)]));
    }
    const [row] = await db.query(
      `select t.vault, e.creator_vault, e.community_vault, e.version from launch_tokens t left join launch_economy e on e.chain_id = t.chain_id and e.token = t.token where t.chain_id = $1 and t.token = $2`,
      [chainId, s.token]
    );
    // Tokens not launched on Place: holder tables from Alchemy transfers and balances at the end of the day.
    const target = row ? (Number(s.kind) === 1 && releaseGeneration(row.version || '0.1.0') < 3 ? { unsupported: UNSUPPORTED.traders } : null) : await externalTarget(db, client, chainId, s);
    if (target?.unsupported) {
      out.unsupported.push({ stream: s.stream_id, reason: target.unsupported }); // the funder reclaims the budget 30 days after the last day
      continue;
    }
    if (target && !alchemyKey) {
      out.waiting.push(s.stream_id);
      out.error = 'ALCHEMY_API_KEY is not set: tables of tokens not launched on Place need it';
      continue;
    }
    const days = [];
    let ready = true;
    try {
      for (let e = from; e <= to; e++) {
        const w = target
          ? await externalDayWeights({ db, client, chainId, stream: s, target, epoch: e, alchemyKey, fetchFn })
          : await dayWeights(db, client, chainId, s, row, e, indexedBlock);
        if (!w.ready) {
          ready = false;
          break;
        }
        days.push({ epoch: e, weights: w.weights, block: w.block });
      }
    } catch (e) {
      ready = false;
      out.error = `${s.stream_id}: ${e.message}`;
    }
    if (!ready) {
      out.waiting.push(s.stream_id);
      continue;
    }
    const budget = BigInt(s.funded) - (prevTotal > BigInt(s.allocated) ? prevTotal : BigInt(s.allocated));
    const t = buildTable({ streamId: s.stream_id, prev, days, budget: budget > 0n ? budget : 0n });
    if (t.empty) {
      await db.query(
        `insert into reward_tables (chain_id, stream_id, epoch, root, cumulative_total, budget, eligible, status) values ($1, $2, $3, null, $4, $5, 0, 'empty')
         on conflict (chain_id, stream_id, epoch) do update set status = 'empty', error = null`,
        [chainId, s.stream_id, to, prevTotal.toString(), (budget > 0n ? budget : 0n).toString()]
      );
      out.empty.push(s.stream_id);
      continue;
    }
    if (t.cumulativeTotal > BigInt(s.funded)) throw new Error(`table of ${s.stream_id} allocates more than funded`);
    const doc = {
      schema: TABLE_SCHEMA,
      chainId,
      distributor: s.distributor,
      streamId: s.stream_id,
      token: s.token,
      kind: Number(s.kind) === 1 ? 'traders' : target?.kind === 'nft-holders' ? 'nft-holders' : 'holders',
      source: row ? 'place-launch' : target.kind === 'nft-holders' ? 'erc721-ownerOf' : 'erc20-balanceOf',
      rewardToken: s.reward_token,
      criterion: s.criterion,
      epoch: to,
      days: t.days.map((d) => ({ ...d, day: new Date(d.epoch * EPOCH * 1000).toISOString().slice(0, 10), block: days.find((x) => x.epoch === d.epoch)?.block?.toString() ?? null })),
      budget: budget.toString(),
      allocated: t.allocatedNow,
      cumulativeTotal: t.cumulativeTotal,
      root: t.root,
      leaf: 'keccak256(bytes.concat(keccak256(abi.encode(streamId, account, cumulativeAmount))))',
      entries: t.entries.map((e) => ({ account: e.account, amount: e.amount, cumulative: e.cumulative })),
    };
    let uri;
    try {
      uri = await ipfs.pin(jsonText(doc), `place-rewards-${s.stream_id.slice(2, 12)}-${to}.json`);
    } catch (e) {
      out.waiting.push(s.stream_id);
      out.error = e.message;
      continue;
    }
    const eligible = t.days.reduce((n, d) => n + d.eligible, 0);
    await db.tx(async (q) => {
      await q('delete from reward_allocations where chain_id = $1 and stream_id = $2 and epoch = $3', [chainId, s.stream_id, to]);
      await q(
        `insert into reward_tables (chain_id, stream_id, epoch, root, cumulative_total, budget, eligible, uri, status) values ($1, $2, $3, $4, $5, $6, $7, $8, 'built')
         on conflict (chain_id, stream_id, epoch) do update set root = excluded.root, cumulative_total = excluded.cumulative_total, budget = excluded.budget,
           eligible = excluded.eligible, uri = excluded.uri, status = 'built', tx = null, error = null`,
        [chainId, s.stream_id, to, t.root, t.cumulativeTotal.toString(), budget.toString(), eligible, uri]
      );
      for (const e of t.entries) {
        await q(`insert into reward_allocations (chain_id, stream_id, epoch, account, amount, cumulative, proof) values ($1, $2, $3, $4, $5, $6, $7)`, [
          chainId, s.stream_id, to, e.account, e.amount.toString(), e.cumulative.toString(), JSON.stringify(t.proofs.get(e.account)),
        ]);
      }
    });
    out.built.push({ stream: s.stream_id, epoch: to, root: t.root, eligible, uri });
  }

  // 3. Send every built table, one publishRoots per distributor.
  if (!publisher) return { ...out, skipped: 'PUBLISHER_PRIVATE_KEY is not set: tables are built, roots not sent' };
  const built = await db.query(
    `select t.stream_id, t.epoch::text as epoch, t.root, t.cumulative_total::text as total, t.uri, s.distributor from reward_tables t
     join reward_streams s on s.chain_id = t.chain_id and s.stream_id = t.stream_id where t.chain_id = $1 and t.status = 'built' order by t.stream_id`,
    [chainId]
  );
  for (const distributor of new Set(built.map((b) => b.distributor))) {
    const updates = built.filter((b) => b.distributor === distributor);
    try {
      const hash = await publisher.publishRoots({
        distributor,
        updates: updates.map((u) => ({ streamId: u.stream_id, epoch: BigInt(u.epoch), root: u.root, cumulativeTotal: BigInt(u.total), uri: u.uri })),
      });
      for (const u of updates) {
        await db.query(`update reward_tables set status = 'sent', tx = $4 where chain_id = $1 and stream_id = $2 and epoch = $3 and status = 'built'`, [chainId, u.stream_id, u.epoch, hash]);
      }
      out.sent.push({ distributor, tx: hash, streams: updates.length });
    } catch (e) {
      out.error = e.shortMessage || e.message;
    }
  }
  return out;
}
