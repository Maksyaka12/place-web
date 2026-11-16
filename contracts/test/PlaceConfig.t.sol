// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PlaceConfig} from "../src/PlaceConfig.sol";

contract PlaceConfigTest is Test {
    PlaceConfig config;
    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address publisher = makeAddr("publisher");
    address stranger = makeAddr("stranger");

    function setUp() public {
        config = new PlaceConfig(safe, treasury, publisher, 500, 0.0007 ether);
    }

    function test_initialValues() public view {
        assertEq(config.owner(), safe);
        assertEq(config.treasury(), treasury);
        assertEq(config.publisher(), publisher);
        assertEq(config.feeBps(), 500);
        assertEq(config.nftDeployFee(), 0.0007 ether);
        assertFalse(config.newCampaignsPaused());
    }

    function test_constructorBounds() public {
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        new PlaceConfig(safe, treasury, publisher, 1_001, 0);
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        new PlaceConfig(safe, treasury, publisher, 0, 0.01 ether + 1);
        vm.expectRevert(PlaceConfig.ZeroAddress.selector);
        new PlaceConfig(safe, address(0), publisher, 0, 0);
        vm.expectRevert(PlaceConfig.ZeroAddress.selector);
        new PlaceConfig(safe, treasury, address(0), 0, 0);
    }

    function test_ownerSetters() public {
        vm.startPrank(safe);
        config.setFeeBps(1_000);
        config.setNftDeployFee(0.01 ether);
        config.setTreasury(stranger);
        config.setPublisher(stranger);
        config.setNewCampaignsPaused(true);
        config.setActiveHub(address(0x1234));
        config.setNftFactory(address(0x5678));
        vm.stopPrank();
        assertEq(config.feeBps(), 1_000);
        assertEq(config.nftDeployFee(), 0.01 ether);
        assertEq(config.treasury(), stranger);
        assertEq(config.publisher(), stranger);
        assertTrue(config.newCampaignsPaused());
        assertEq(config.activeHub(), address(0x1234));
        assertEq(config.nftFactory(), address(0x5678));
    }

    function test_limits() public {
        vm.startPrank(safe);
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        config.setFeeBps(1_001);
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        config.setNftDeployFee(0.01 ether + 1);
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        config.setTargetFee(address(1), true, 1_001);
        vm.expectRevert(PlaceConfig.FeeTooHigh.selector);
        config.setDeployerNftFee(address(1), true, 0.01 ether + 1);
        vm.expectRevert(PlaceConfig.ZeroAddress.selector);
        config.setTreasury(address(0));
        vm.expectRevert(PlaceConfig.ZeroAddress.selector);
        config.setActiveHub(address(0));
        vm.stopPrank();
    }

    function test_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        config.setFeeBps(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        config.setPublisher(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        config.setNewCampaignsPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        config.setTargetFee(address(1), true, 0);
        vm.stopPrank();
    }

    function test_overrides() public {
        address partner = address(0xb200);
        vm.startPrank(safe);
        config.setTargetFee(partner, true, 0);
        config.setDeployerNftFee(stranger, true, 0);
        vm.stopPrank();
        assertEq(config.campaignFeeBps(partner), 0);
        assertEq(config.campaignFeeBps(address(1)), 500);
        assertEq(config.nftDeployFeeFor(stranger), 0);
        assertEq(config.nftDeployFeeFor(address(1)), 0.0007 ether);

        vm.prank(safe);
        config.setTargetFee(partner, false, 0);
        assertEq(config.campaignFeeBps(partner), 500);
    }

    function test_twoStepOwnership() public {
        vm.prank(safe);
        config.transferOwnership(stranger);
        assertEq(config.owner(), safe);
        vm.prank(stranger);
        config.acceptOwnership();
        assertEq(config.owner(), stranger);
    }
}
