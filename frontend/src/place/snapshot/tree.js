// The Merkle tree PlaceHub verifies, and the table document pinned to IPFS as proofsURI.
//
// Leaf = keccak256(bytes.concat(keccak256(abi.encode(hub, chainId, campaignId, account, amount)))), which
// is exactly OpenZeppelin's StandardMerkleTree leaf for these five values. Binding hub, chain and campaign
// into the leaf means a proof only ever works for one campaign.
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { encodeAbiParameters, keccak256 } from 'viem';

export const LEAF_ENCODING = ['address', 'uint256', 'uint256', 'address', 'uint256'];
export const TABLE_SCHEMA = 'place.table/1';

/** The leaf for one allocation, computed independently of the tree library (PlaceHub.leaf). */
export function leafHash({ hub, chainId, campaignId, account, amount }) {
  const inner = keccak256(
    encodeAbiParameters(
      LEAF_ENCODING.map((type) => ({ type })),
      [hub, BigInt(chainId), BigInt(campaignId), account, BigInt(amount)]
    )
  );
  return keccak256(inner);
}

/** Builds the tree for a campaign's rows ({account, amount: bigint}). */
export function buildTree({ hub, chainId, campaignId, rows }) {
  if (!rows.length) throw new Error('No allocations: nothing to publish');
  const values = rows.map((r) => [
    hub.toLowerCase(),
    String(chainId),
    String(campaignId),
    r.account.toLowerCase(),
    r.amount.toString(),
  ]);
  const tree = StandardMerkleTree.of(values, LEAF_ENCODING);
  return { tree, root: tree.root };
}

/**
 * The full table document: everything needed to check the published root by recomputing it, and to get a
 * proof for any wallet. Balances and amounts are decimal strings.
 */
export function buildTable({ rules, rulesHash, campaignId, block, rows, totalAllocated }) {
  const { tree, root } = buildTree({ hub: rules.hub, chainId: rules.chainId, campaignId, rows });
  return {
    schema: TABLE_SCHEMA,
    chainId: rules.chainId,
    hub: rules.hub,
    campaignId: String(campaignId),
    rulesHash,
    snapshot: { block: String(block.number), timestamp: Number(block.timestamp) },
    pool: rules.pool,
    totalAllocated: totalAllocated.toString(),
    merkleRoot: root,
    wallets: rows.length,
    entries: rows.map((r) => ({
      account: r.account,
      balance: r.balance.toString(),
      amount: r.amount.toString(),
      capped: r.capped,
    })),
    tree: tree.dump(),
  };
}

/** Recomputes a table from its entries and checks the root and totals. Throws if anything is off. */
export function verifyTable(table) {
  if (table.schema !== TABLE_SCHEMA) throw new Error('Unknown table schema');
  const rows = table.entries.map((e) => ({ account: e.account, amount: BigInt(e.amount) }));
  const { root } = buildTree({ hub: table.hub, chainId: table.chainId, campaignId: table.campaignId, rows });
  if (root !== table.merkleRoot) throw new Error('Root does not match the entries');
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  if (total.toString() !== table.totalAllocated) throw new Error('totalAllocated does not match the entries');
  if (total > BigInt(table.pool)) throw new Error('Table allocates more than the pool');
  return true;
}

/** Amount and proof for one wallet from a table (or null if it has no allocation). */
export function claimFromTable(table, account) {
  const tree = StandardMerkleTree.load(table.tree);
  const a = account.toLowerCase();
  for (const [i, v] of tree.entries()) {
    if (v[3] === a) return { amount: BigInt(v[4]), proof: tree.getProof(i), index: i };
  }
  return null;
}
