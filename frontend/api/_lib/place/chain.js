// Chain data for Place snapshots, through Alchemy (server key ALCHEMY_API_KEY).
//
// How holders are found (any ERC-20 or ERC-721):
// 1. every wallet that ever received the asset up to the snapshot block (alchemy_getAssetTransfers);
// 2. balanceOf / ownerOf at that block through Multicall3.
// Every step is pageable so the snapshot job can run in short serverless invocations and resume.
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { base, baseSepolia } from 'viem/chains';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const DEAD = '0x000000000000000000000000000000000000dead';

export const NETWORKS = {
  8453: { chain: base, alchemy: 'base-mainnet', poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b' },
  84532: { chain: baseSepolia, alchemy: 'base-sepolia', poolManager: '0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408' },
};

const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ERC721_ABI = parseAbi(['function ownerOf(uint256) view returns (address)']);
const PAIR_ABI = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function retry(fn, tries = 4, delay = 400) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(delay * (i + 1));
    }
  }
  throw last;
}

function network(chainId) {
  const n = NETWORKS[Number(chainId)];
  if (!n) throw new Error(`Unsupported chain ${chainId}`);
  return n;
}

export function alchemyUrl(chainId, key) {
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  return `https://${network(chainId).alchemy}.g.alchemy.com/v2/${key}`;
}

/** viem client on Alchemy. `transport` overrides it (tests). */
export function chainClient({ chainId, key, transport }) {
  return createPublicClient({
    chain: network(chainId).chain,
    transport: transport || http(alchemyUrl(chainId, key), { timeout: 30_000, retryCount: 2 }),
  });
}

/** The last block with timestamp <= unix (the snapshot block). */
export async function blockAtTime(client, unix) {
  const target = BigInt(unix);
  const latest = await retry(() => client.getBlock({ blockTag: 'latest' }));
  // Base makes several blocks per second (200 ms since 2026), so blocks share timestamps: the answer is
  // final only once a block with a later timestamp exists.
  if (latest.timestamp <= target) throw new Error('Snapshot time is not reached on chain yet');
  const get = (n) => retry(() => client.getBlock({ blockNumber: n }));
  // Estimate from the chain's own recent pace (not a fixed block time), then widen until it brackets.
  const span = latest.number > 100_000n ? 100_000n : latest.number;
  const sample = span > 0n ? await get(latest.number - span) : latest;
  const secs = latest.timestamp - sample.timestamp;
  const estimate = secs > 0n ? latest.number - ((latest.timestamp - target) * span) / secs : 0n;
  let lo = estimate > 1000n ? estimate - 1000n : 0n;
  let hi = estimate + 1000n < latest.number ? estimate + 1000n : latest.number;
  while (lo > 0n && (await get(lo)).timestamp > target) lo = lo > 20_000n ? lo - 20_000n : 0n;
  while (hi < latest.number && (await get(hi)).timestamp <= target) {
    hi = hi + 20_000n < latest.number ? hi + 20_000n : latest.number;
  }
  if ((await get(lo)).timestamp > target) throw new Error('Snapshot time is before the chain started');
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await get(mid)).timestamp <= target) lo = mid;
    else hi = mid - 1n;
  }
  return get(lo);
}

/**
 * One page of transfers of `contract` up to `toBlock` (inclusive), oldest first.
 * @returns {{receivers: string[], tokenIds: bigint[], lastBlock: bigint|null, pageKey: string|null}}
 */
export async function transfersPage({ chainId, key, contract, category, fromBlock = 0n, toBlock, pageKey = null, fetchFn = fetch }) {
  const params = {
    fromBlock: `0x${BigInt(fromBlock).toString(16)}`,
    toBlock: `0x${BigInt(toBlock).toString(16)}`,
    contractAddresses: [contract],
    category: [category],
    withMetadata: false,
    excludeZeroValue: false,
    maxCount: '0x3e8',
    order: 'asc',
  };
  if (pageKey) params.pageKey = pageKey;
  const body = await retry(async () => {
    const res = await fetchFn(alchemyUrl(chainId, key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.error) throw new Error(`Alchemy transfers: ${json?.error?.message || res.status}`);
    return json;
  });
  const transfers = body.result?.transfers || [];
  const receivers = [];
  const tokenIds = [];
  let lastBlock = null;
  for (const t of transfers) {
    if (t.to) receivers.push(t.to.toLowerCase());
    const id = t.tokenId ?? t.erc721TokenId;
    if (category === 'erc721' && id != null) tokenIds.push(BigInt(id));
    lastBlock = BigInt(t.blockNum);
  }
  return { receivers, tokenIds, lastBlock, pageKey: body.result?.pageKey || null };
}

/**
 * Walks transfer pages until done or `maxPages` is reached. Feeds `into` (Sets) so a caller can keep the
 * sets between invocations; returns the pageKey to continue from, or null when finished.
 */
export async function collectTransfers({ into, maxPages = Infinity, ...page }) {
  let pageKey = page.pageKey || null;
  for (let n = 0; n < maxPages; n++) {
    const p = await transfersPage({ ...page, pageKey });
    p.receivers.forEach((r) => into.receivers.add(r));
    if (into.tokenIds) p.tokenIds.forEach((id) => into.tokenIds.add(id));
    pageKey = p.pageKey;
    if (!pageKey) return null;
  }
  return pageKey;
}

async function multicallStrict(client, contracts, blockNumber, chunk) {
  const out = [];
  for (let i = 0; i < contracts.length; i += chunk) {
    const part = contracts.slice(i, i + chunk);
    const res = await retry(() => client.multicall({ contracts: part, blockNumber, allowFailure: true }), 5);
    out.push(...res);
  }
  return out;
}

/** ERC-20 balances at `blockNumber`. A failed read throws: a table must never silently miss a holder. */
export async function erc20BalancesAt(client, token, accounts, blockNumber, chunk = 400) {
  const list = [...accounts];
  const res = await multicallStrict(
    client,
    list.map((a) => ({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] })),
    blockNumber,
    chunk
  );
  return list.map((account, i) => {
    if (res[i].status !== 'success') throw new Error(`balanceOf(${account}) failed at block ${blockNumber}`);
    return { account: account.toLowerCase(), balance: res[i].result };
  });
}

/**
 * NFT counts per owner at `blockNumber`, from ownerOf over every token id ever transferred. Tokens whose
 * ownerOf reverts (burned, or not minted yet at that block) are skipped.
 */
export async function nftHoldingsAt(client, collection, tokenIds, blockNumber, chunk = 400) {
  const ids = [...tokenIds];
  const res = await multicallStrict(
    client,
    ids.map((id) => ({ address: collection, abi: ERC721_ABI, functionName: 'ownerOf', args: [id] })),
    blockNumber,
    chunk
  );
  const counts = new Map();
  res.forEach((r) => {
    if (r.status !== 'success') return;
    const owner = r.result.toLowerCase();
    counts.set(owner, (counts.get(owner) || 0n) + 1n);
  });
  return [...counts].map(([account, balance]) => ({ account, balance }));
}

/**
 * Addresses that hold the asset but are not people: zero and dead
 * addresses, the hub, the Uniswap v4 PoolManager, and any holder that answers token0() and token1() —
 * Uniswap v2/v3, Aerodrome and other AMM pools. Smart wallets and Safes do not answer those, so they stay.
 */
export async function autoExclusions(client, { chainId, hub, holders, blockNumber, chunk = 300 }) {
  const out = new Set([ZERO, DEAD, hub.toLowerCase(), network(chainId).poolManager]);
  const list = [...holders];
  const calls = list.flatMap((a) => [
    { address: a, abi: PAIR_ABI, functionName: 'token0' },
    { address: a, abi: PAIR_ABI, functionName: 'token1' },
  ]);
  const res = await multicallStrict(client, calls, blockNumber, chunk * 2);
  list.forEach((a, i) => {
    const t0 = res[2 * i];
    const t1 = res[2 * i + 1];
    if (t0.status === 'success' && t1.status === 'success' && t0.result !== ZERO && t1.result !== ZERO) {
      out.add(a.toLowerCase());
    }
  });
  return out;
}

/**
 * Everything the engine needs for one campaign, in a single run (for scripts and small assets; the cron
 * job uses the pieces above step by step).
 */
export async function collectHolders({ client, chainId, key, kind, target, hub, block, minBalance = 1n, fetchFn = fetch, onProgress = () => {} }) {
  const into = { receivers: new Set(), tokenIds: kind === 'nft-holders' ? new Set() : null };
  await collectTransfers({
    into,
    chainId,
    key,
    contract: getAddress(target),
    category: kind === 'nft-holders' ? 'erc721' : 'erc20',
    toBlock: block.number,
    fetchFn,
  });
  onProgress(`${into.receivers.size} receivers${into.tokenIds ? `, ${into.tokenIds.size} token ids` : ''}`);

  const balances =
    kind === 'nft-holders'
      ? await nftHoldingsAt(client, target, into.tokenIds, block.number)
      : await erc20BalancesAt(client, target, [...into.receivers].filter((a) => a !== ZERO), block.number);
  const holders = balances.filter((b) => b.balance >= minBalance && b.balance > 0n);
  onProgress(`${holders.length} wallets at or above the minimum`);

  const excluded = await autoExclusions(client, { chainId, hub, holders: holders.map((h) => h.account), blockNumber: block.number });
  onProgress(`${[...excluded].filter((a) => holders.some((h) => h.account === a)).length} holders auto-excluded`);
  return { balances, autoExclude: excluded, receivers: into.receivers.size };
}
