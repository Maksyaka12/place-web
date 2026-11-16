# Place contracts

Foundry project for the Place hub contracts on Base. Deployed addresses are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

```
src/       contracts (PlaceConfig, PlaceHub, nft/ClubNFT, nft/NftFactory)
script/    deploy scripts for them
test/      unit, fuzz and Base-fork tests for them
```

## Setup

Dependencies are pinned and not committed:

```bash
git clone --depth 1 --branch v1.9.7 https://github.com/foundry-rs/forge-std.git lib/forge-std
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
```

## Test

```bash
forge test --no-match-contract Fork                                    # what CI runs
forge test --match-contract Fork --fork-url https://mainnet.base.org   # Base-fork tests
```
