// Where the Place Launch contracts live. The source of truth is DEPLOYMENTS.md in Maksyaka12/place-contracts.
// Addresses are lowercase; blocks are bigint.
//
// One entry per chain is the current release (new launches, the launch form, the creator console). Older
// releases stay in `legacy`: their tokens keep trading in the same PoolManager and are still indexed, but
// nothing new is launched there. A legacy release lists only what differs; the rest comes from the current one.
export const LAUNCH_DEPLOYMENTS = {
  84532: {
    name: 'Base Sepolia',
    version: '0.2.0-testnet',
    startBlock: 58740635n,
    factory: '0xeaaaa64419bade6977bf491a9828b68357d47d63',
    hook: '0x1206be7d6eff2fc2f15a6bdfc88cfbd697ea2acc',
    feeEscrow: '0x4244afad1c2789e9da79a97e8ee001ad744d1dc2',
    creatorVaultImplementation: '0x170349bc94ad1d7f62dc82694d4c4d413649d4b6',
    rewardTokenRegistry: '0x092c21c933911a5205588eb1d7592da358108d5c',
    staking: '0x1390719ddd7a3f597abcdd8b48bcc7dc465220df',
    xRecipientRegistry: '0x1eb2d5512f0d7a413acedb1b2252a9cbb003e4d3',
    launchBuyAdapter: '0xbd0c4f2dab3176159b99d0a2c1f3f74480f3e19c',
    announcementRegistry: '0xd9cd4d6b5f49dad3d8cfdf713f9d31a3cf71d9ff',
    tokenDeployer: '0xe5ed380daa6ba73755c2940f5e0be86887dae47f',
    poolManager: '0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408',
    universalRouter: '0x492e6456d9528771018deb9e87ef7750ef184104',
    v4Quoter: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba', // Uniswap V4Quoter, poolManager() checked on chain
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    hub: '0x493f55975bff2e4f111bad8d51637f3b9763bdd1',
    b20Factory: '0xb20f000000000000000000000000000000000000',
    quotes: { eth: '0x0000000000000000000000000000000000000000', usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
    // Holder-campaign template every community-fund campaign commits (rules/launch-holders-v2.json).
    launchRules: [
      {
        schema: 'place.launch-rules/2',
        rulesHash: '0x43ea5fcc1dd629a01af4ab607cdbc11057b81cae85e82893b432cfd29c4ce8c4',
        rulesURI: 'https://raw.githubusercontent.com/Maksyaka12/place-contracts/dev/rules/launch-holders-v2.json',
      },
    ],
    legacy: [
      {
        version: '0.1.0-testnet',
        startBlock: 58275925n,
        factory: '0xf3348e8bc017aae708c278da3e1cbc1a8ae6fc55',
        hook: '0xc6c32a05b5392a51f4eac82fa163979f5166aacc',
        feeEscrow: '0xaaa8458ed82ee3ec69fd0cfda052882eb807c0ea',
        creatorVaultImplementation: '0x7b7d1de1ca7f97acd29d92c8f04bcc38d0fc33e1',
        rewardTokenRegistry: null,
        staking: null,
        xRecipientRegistry: '0x852c1541091f7baf0dd4547fcee2e7934102c68f',
        launchBuyAdapter: '0xac68af3adf53706cd75a641220ae2b8bf9b3e72b',
        announcementRegistry: '0x7fefd265c317e9bd573eb7a9389d00f2e2ea6888',
        tokenDeployer: '0xcea99dc4fde9c22e6ce071720a7aea1772d0931d',
        launchRules: [
          {
            schema: 'place.launch-rules/1',
            rulesHash: '0x3c661671f7061b99611a69edfdfc832a18d327d0dfe34fd997808954768fa015',
            rulesURI: 'https://raw.githubusercontent.com/Maksyaka12/place-contracts/dev/rules/launch-holders-v1.json',
          },
        ],
      },
    ],
  },
};

export const LAUNCH_SUPPLY = 10n ** 27n; // 1 billion with 18 decimals, every launch
export const TOKEN_DECIMALS = 18;
export const TOKEN_ADDRESS_SUFFIX = 0x01;

/** The current release of a chain (null where Place Launch is not deployed). */
export function launchDeployment(chainId) {
  return LAUNCH_DEPLOYMENTS[Number(chainId)] || null;
}

/** Every release of a chain, current first; legacy ones are complete objects with `legacy: true`. */
export function launchReleases(chainId) {
  const d = launchDeployment(chainId);
  if (!d) return [];
  const { legacy = [], ...current } = d;
  return [{ ...current, legacy: false }, ...legacy.map((l) => ({ ...current, ...l, legacy: true }))];
}

/** The release a factory (or hook, or vault implementation) belongs to. */
export function releaseOf(chainId, address) {
  const a = String(address || '').toLowerCase();
  return launchReleases(chainId).find((r) => r.factory === a || r.hook === a || r.creatorVaultImplementation === a) || null;
}

/** The release by version string; unknown versions fall back to the current one. */
export function releaseByVersion(chainId, version) {
  const list = launchReleases(chainId);
  return list.find((r) => r.version === version) || list[0] || null;
}

/** Every rules template a launch vault may commit on this chain, with the release that uses it. */
export function launchRulesTemplates(chainId) {
  return launchReleases(chainId).flatMap((r) => r.launchRules.map((t) => ({ ...t, release: r })));
}

/** The earliest block any release needs indexed from. */
export function launchStartBlock(chainId) {
  const list = launchReleases(chainId);
  return list.length ? list.map((r) => r.startBlock).reduce((a, b) => (a < b ? a : b)) : null;
}

/** Static contracts whose events the shared indexer cursor reads (tokens and vaults are added as found). */
export function launchEventAddresses(chainId) {
  return launchReleases(chainId).flatMap((r) => [r.factory, r.hook, r.feeEscrow, r.announcementRegistry, r.xRecipientRegistry]);
}
