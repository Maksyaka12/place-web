import { getAddress, isAddress, parseAbi } from 'viem';
import { publicClient } from './rpc.js';

// Tokens the wallet, swap and agent know by default on Base. Any other ERC-20 works by its address
// (resolveToken reads its symbol and decimals onchain), so launched tokens, project tokens and tokenized
// stocks need no list entry.

export const ETH_ICON = 'https://assets.coingecko.com/coins/images/279/small/ethereum.png';

export const BASE_TOKENS = [
  { symbol: 'ETH', name: 'Ethereum', address: null, decimals: 18, icon: ETH_ICON },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, icon: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' },
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, icon: ETH_ICON },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, icon: 'https://assets.coingecko.com/coins/images/40143/small/cbbtc.webp' },
];

export const ETH = BASE_TOKENS[0];
export const USDC = BASE_TOKENS[1];
export const WETH_ADDRESS = BASE_TOKENS[2].address;

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** A stable key for a token: its lowercase address, or "eth". */
export const tokenKey = (t) => (t?.address ? t.address.toLowerCase() : 'eth');

export const findKnownToken = (address) =>
  BASE_TOKENS.find((t) => (address ? t.address?.toLowerCase() === String(address).toLowerCase() : !t.address)) || null;

/** A known token, or one read from its contract: { symbol, name, address, decimals, icon }. Throws if it is not an ERC-20. */
export async function resolveToken(address, client = publicClient) {
  if (!isAddress(address || '')) throw new Error('Enter a token address (0x…)');
  const known = findKnownToken(address);
  if (known) return known;
  const a = getAddress(address);
  const [symbol, name, decimals] = await client.multicall({
    allowFailure: false,
    contracts: ['symbol', 'name', 'decimals'].map((functionName) => ({ address: a, abi: ERC20_ABI, functionName })),
  }).catch(() => {
    throw new Error('This address is not an ERC-20 token on Base');
  });
  return { symbol, name, address: a, decimals: Number(decimals), icon: null };
}

/** Balance of one token (ETH when address is null) for a wallet. */
export function readTokenBalance(token, owner, client = publicClient) {
  return token.address
    ? client.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })
    : client.getBalance({ address: owner });
}
