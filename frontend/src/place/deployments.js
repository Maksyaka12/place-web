// Where the Place contracts live (contracts/DEPLOYMENTS.md is the source of truth). Every hub version ever
// deployed stays listed: the indexer, the API and "Claim all" read all of them.
export const DEPLOYMENTS = {
  84532: {
    name: 'Base Sepolia',
    config: '0x8d1ad3b73cdea7e91d7aaf55425b580b010cb187',
    hubs: [{ address: '0x493f55975bff2e4f111bad8d51637f3b9763bdd1', version: '1.0.0', startBlock: 57541327n }],
    nftFactory: { address: '0x3437efd2d2579e689215acf0fcc947e1f4200acf', startBlock: 57541327n },
    clubNftImplementation: '0xe7fb58c640d47d345f32f6076e6f0ba175ad4e09',
  },
};

export function deployment(chainId) {
  const d = DEPLOYMENTS[Number(chainId)];
  if (!d) throw new Error(`Place is not deployed on chain ${chainId}`);
  return d;
}

/** The hub that new campaigns go to (the last one listed). */
export function activeHub(chainId) {
  const { hubs } = deployment(chainId);
  return hubs[hubs.length - 1];
}
