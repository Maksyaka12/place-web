# Deployments

Every contract version gets a repo tag (`contracts-v1.0.0`, …) and a row here. Old hubs stay
listed: the site, API and agents read all of them.

## Base Sepolia (84532)

Deployed 2026-11-11, block 57541327, script `script/DeployPlace.s.sol`
(transactions in `broadcast/DeployPlace.s.sol/84532/run-latest.json`).

| Contract | Version | Address |
|---|---|---|
| PlaceConfig | — | [`0x8d1aD3B73CdeA7E91D7aAf55425B580B010Cb187`](https://sepolia.basescan.org/address/0x8d1aD3B73CdeA7E91D7aAf55425B580B010Cb187) |
| PlaceHub | 1.0.0 | [`0x493F55975Bff2e4f111BAd8D51637F3b9763Bdd1`](https://sepolia.basescan.org/address/0x493F55975Bff2e4f111BAd8D51637F3b9763Bdd1) |
| ClubNFT (implementation) | 1.0.0 | [`0xE7FB58C640d47D345f32f6076E6F0bA175aD4e09`](https://sepolia.basescan.org/address/0xE7FB58C640d47D345f32f6076E6F0bA175aD4e09) |
| NftFactory | — | [`0x3437Efd2D2579E689215ACf0FcC947E1f4200ACf`](https://sepolia.basescan.org/address/0x3437Efd2D2579E689215ACf0FcC947E1f4200ACf) |

Settings (testnet; owner is the deployer wallet, not a Safe):

| Role / setting | Value |
|---|---|
| Owner of PlaceConfig and NftFactory | `0x9F687A81012e8039679b43BD7A910b5Cf4bb6fC4` |
| Treasury | `0x9F687A81012e8039679b43BD7A910b5Cf4bb6fC4` |
| Publisher | `0x0851B25D5D5b38BA260258A1520aff53E72c757d` (since 2026-11-12; was `0xDA370B80eC66da31f24D9B290C6f7068f49C52Cb`, key lost, no longer used) |
| Campaign fee | 500 bps (5%) |
| NFT deploy fee | 0.0007 ETH |

Source code of all four contracts is verified on Basescan (2026-11-11).

Per-target campaign fee overrides (`PlaceConfig.setTargetFee`): 0 bps for the Place Launch L2 test tokens
`0xb200000000000000000000edee389ab594913E01` and `0xB4F38E468f983611a1fB5574989Be0E6a94Efe01` (2026-11-13; their creator
vaults already paid the platform). Place Launch contracts are listed in
[`place-contracts/DEPLOYMENTS.md`](https://github.com/Maksyaka12/place-contracts/blob/dev/DEPLOYMENTS.md).

## Base (8453)

Not deployed yet. Owner and treasury there must be the platform Safe.
