// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PlaceConfig} from "../src/PlaceConfig.sol";
import {PlaceHub} from "../src/PlaceHub.sol";
import {ClubNFT} from "../src/nft/ClubNFT.sol";
import {NftFactory} from "../src/nft/NftFactory.sol";

/// @notice Deploys PlaceConfig, PlaceHub, the ClubNFT implementation and NftFactory, wires them, and hands
///         ownership of the config and the factory to the platform Safe (two-step: the Safe must call
///         acceptOwnership on both).
///
///   Env: OWNER (Safe), TREASURY, PUBLISHER; optional FEE_BPS (default 500), NFT_DEPLOY_FEE (default 0.0007 ETH).
///
///   forge script script/DeployPlace.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --verify
contract DeployPlace is Script {
    function run() external {
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");
        address publisher = vm.envAddress("PUBLISHER");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(500)));
        uint256 nftFee = vm.envOr("NFT_DEPLOY_FEE", uint256(0.0007 ether));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the broadcasting account

        // The deployer owns the config only for the wiring below.
        PlaceConfig config = new PlaceConfig(deployer, treasury, publisher, feeBps, nftFee);
        PlaceHub hub = new PlaceHub(config);
        ClubNFT impl = new ClubNFT();
        NftFactory factory = new NftFactory(config, address(impl), owner);

        config.setActiveHub(address(hub));
        config.setNftFactory(address(factory));
        if (owner != deployer) config.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("chainId        ", block.chainid);
        console2.log("PlaceConfig    ", address(config));
        console2.log("PlaceHub       ", address(hub));
        console2.log("ClubNFT impl   ", address(impl));
        console2.log("NftFactory     ", address(factory));
        console2.log("pending owner  ", owner);
    }
}
