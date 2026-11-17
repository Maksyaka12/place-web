// The Place publisher wallet (env PUBLISHER_PRIVATE_KEY): the only key allowed to publish roots, on the
// PlaceHub (campaign roots, publishRoot) and on the Place Launch 0.3.0 PlaceRewardsDistributor (daily cumulative
// roots, publishRoots). It cannot move funds; this module only ever sends those two calls.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PLACE_HUB_ABI } from '../../../src/place/abi.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../../../src/launch/abi.js';
import { DATA_SUFFIX } from '../../../src/config/builderCode.js';
import { NETWORKS, alchemyUrl } from './chain.js';

export function makePublisher({ chainId, alchemyKey, privateKey = process.env.PUBLISHER_PRIVATE_KEY, readClient }) {
  if (!privateKey) throw new Error('PUBLISHER_PRIVATE_KEY is not set');
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: NETWORKS[Number(chainId)].chain,
    transport: http(alchemyUrl(chainId, alchemyKey), { timeout: 30_000 }),
    dataSuffix: DATA_SUFFIX, // Place Builder Code on every publishRoot
  });
  return {
    address: account.address.toLowerCase(),
    /** Sends publishRoot and returns the transaction hash (does not wait). */
    async publishRoot({ hub, campaignId, root, totalAllocated, proofsURI }) {
      return wallet.writeContract({
        address: hub,
        abi: PLACE_HUB_ABI,
        functionName: 'publishRoot',
        args: [BigInt(campaignId), root, BigInt(totalAllocated), proofsURI],
      });
    },
    /** Sends PlaceRewardsDistributor.publishRoots(updates) and returns the hash (does not wait). */
    async publishRoots({ distributor, updates }) {
      return wallet.writeContract({ address: distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'publishRoots', args: [updates] });
    },
    /** 'success', 'reverted', or null while the transaction is not mined yet. */
    async status(hash) {
      try {
        const r = await readClient.getTransactionReceipt({ hash });
        return r.status;
      } catch {
        return null;
      }
    },
  };
}
