import { http, fallback } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { createConfig } from '@privy-io/wagmi';
import { BASE_RPC_URLS } from './rpc';
import { DATA_SUFFIX } from './builderCode';
import { placeTransport } from '../place/chain';

// Base for the wallet, swap and agent pages; Base Sepolia for Place while it runs on the testnet.
export const privyWagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: fallback(BASE_RPC_URLS.map(url => http(url, { timeout: 10000, retryCount: 2 }))),
    [baseSepolia.id]: placeTransport(baseSepolia.id),
  },
  dataSuffix: DATA_SUFFIX,
});
