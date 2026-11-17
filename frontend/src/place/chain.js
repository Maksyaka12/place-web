// The chain the Place portal works on. Base Sepolia (84532) until the mainnet launch;
// VITE_PLACE_CHAIN switches it without code changes. Addresses come from deployments.js.
import { createPublicClient, http, fallback } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { deployment } from './deployments.js';

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const PLACE_CHAIN_ID = Number(env.VITE_PLACE_CHAIN || 84532);
export const PLACE_CHAIN = PLACE_CHAIN_ID === base.id ? base : baseSepolia;

export const RPC_URLS = {
  [base.id]: ['https://base.drpc.org', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  [baseSepolia.id]: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'],
};

export const placeTransport = (chainId = PLACE_CHAIN_ID) =>
  fallback(RPC_URLS[chainId].map((url) => http(url, { timeout: 10000, retryCount: 2 })));

let client = null;
/** Reads from the Place chain, whatever chain the wallet is on. */
export function placeClient() {
  if (!client) client = createPublicClient({ chain: PLACE_CHAIN, transport: placeTransport() });
  return client;
}

export const placeDeployment = () => deployment(PLACE_CHAIN_ID);
export const isTestnet = PLACE_CHAIN_ID !== base.id;

const EXPLORER = PLACE_CHAIN_ID === base.id ? 'https://basescan.org' : 'https://sepolia.basescan.org';
export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (a) => `${EXPLORER}/address/${a}`;
