// Name, symbol and decimals of assets, read once from the chain into token_meta.
import { parseAbi } from 'viem';
import { retry } from './chain.js';

const ETH = '0x0000000000000000000000000000000000000000';

const META_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function supportsInterface(bytes4) view returns (bool)',
]);

/** Reads and stores name/symbol/decimals for assets the database does not know yet. */
export async function ensureTokenMeta(deps, chainId, addresses) {
  const list = [...new Set(addresses.filter((a) => a && a !== ETH))];
  if (!list.length) return;
  const known = new Set(
    (await deps.db.query('select address from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, list])).map((r) => r.address)
  );
  const missing = list.filter((a) => !known.has(a));
  if (!missing.length) return;
  const calls = missing.flatMap((a) => [
    { address: a, abi: META_ABI, functionName: 'name' },
    { address: a, abi: META_ABI, functionName: 'symbol' },
    { address: a, abi: META_ABI, functionName: 'decimals' },
    { address: a, abi: META_ABI, functionName: 'supportsInterface', args: ['0x80ac58cd'] },
  ]);
  const res = await retry(() => deps.client(chainId).multicall({ contracts: calls, allowFailure: true }));
  const ok = (r) => (r.status === 'success' ? r.result : null);
  for (let i = 0; i < missing.length; i++) {
    const [n, s, d, nft] = res.slice(4 * i, 4 * i + 4).map(ok);
    await deps.db.query(
      `insert into token_meta (chain_id, address, name, symbol, decimals, is_nft) values ($1, $2, $3, $4, $5, $6)
       on conflict (chain_id, address) do nothing`,
      [chainId, missing[i], n, s, d == null ? null : Number(d), nft === true]
    );
  }
}
