// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlaceConfig} from "../src/PlaceConfig.sol";
import {PlaceHub} from "../src/PlaceHub.sol";
import {ClubNFT} from "../src/nft/ClubNFT.sol";
import {NftFactory} from "../src/nft/NftFactory.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @dev Runs against Base mainnet state:
///      forge test --match-contract Fork --fork-url https://mainnet.base.org
contract BaseForkTest is Test {
    address constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    PlaceConfig config;
    PlaceHub hub;
    NftFactory factory;
    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address publisher = makeAddr("publisher");
    address creator = makeAddr("creator");
    // Not "alice": that label's address has code on Base mainnet and refuses ERC-721 transfers.
    address alice = makeAddr("place-fork-minter");

    function setUp() public {
        if (block.chainid != 8453) vm.skip(true);
        config = new PlaceConfig(safe, treasury, publisher, 500, 0.0007 ether);
        hub = new PlaceHub(config);
        factory = new NftFactory(config, address(new ClubNFT()), safe);
        vm.deal(creator, 10 ether);
        vm.deal(alice, 10 ether);
    }

    /// @dev The buyback really goes through SwapRouter02 with a minimum out (WETH → USDC as a liquid stand-in).
    function test_fork_buybackThroughSwapRouter02() public {
        ClubNFT.InitParams memory p;
        p.name = "Fork Club";
        p.symbol = "FORK";
        p.maxSupply = 100;
        p.price = 0.1 ether;
        p.mintStart = uint64(block.timestamp);
        p.payout = creator;
        p.burnBps = 8_000;
        p.burnToken = USDC;
        p.swapRouter = SWAP_ROUTER_02;
        p.swapPoolFee = 500;
        vm.prank(creator);
        ClubNFT c = ClubNFT(factory.createCollection{value: 0.0007 ether}(p));

        vm.prank(alice);
        c.mint{value: 0.1 ether}(1);
        assertEq(c.buybackBalance(), 0.08 ether);

        uint256 deadBefore = IERC20(USDC).balanceOf(DEAD);
        // An absurd minimum must make the router revert (sandwich protection works end to end).
        vm.prank(creator);
        vm.expectRevert();
        c.buybackAndBurn(0.08 ether, 1e15, block.timestamp);

        vm.prank(creator);
        c.buybackAndBurn(0.08 ether, 1, block.timestamp);
        assertGt(IERC20(USDC).balanceOf(DEAD), deadBefore);
        assertEq(c.buybackBalance(), 0);
    }

    /// @dev A full campaign paid in real USDC (a token with blocklist and proxy, but no transfer fee).
    function test_fork_usdcCampaign() public {
        deal(USDC, creator, 1_050e6);
        vm.prank(creator);
        IERC20(USDC).approve(address(hub), type(uint256).max);

        PlaceHub.CreateParams memory p;
        p.kind = PlaceHub.Kind.TokenHolders;
        p.target = WETH;
        p.rewardToken = USDC;
        p.pool = 1_000e6;
        p.snapshotAt = uint64(block.timestamp + 1 hours);
        p.claimDuration = 7 days;
        p.rulesHash = keccak256("rules");
        p.rulesURI = "ipfs://rules";
        vm.prank(creator);
        uint256 id = hub.createCampaign(p);

        vm.warp(p.snapshotAt);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = hub.leaf(id, alice, 600e6);
        leaves[1] = hub.leaf(id, creator, 400e6);
        vm.prank(publisher);
        hub.publishRoot(id, Merkle.root(leaves), 1_000e6, "");
        hub.claimFor(alice, id, 600e6, Merkle.proof(leaves, 0));
        assertEq(IERC20(USDC).balanceOf(alice), 600e6);
        assertEq(IERC20(USDC).balanceOf(treasury), 50e6);
    }
}
