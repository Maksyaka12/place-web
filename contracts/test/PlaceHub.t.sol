// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PlaceConfig} from "../src/PlaceConfig.sol";
import {PlaceHub} from "../src/PlaceHub.sol";
import {MockERC20, MockERC721, FeeOnTransferToken, RejectsEth} from "./utils/Mocks.sol";
import {Merkle} from "./utils/Merkle.sol";

contract PlaceHubTest is Test {
    PlaceConfig config;
    PlaceHub hub;
    MockERC20 target;
    MockERC20 reward;
    MockERC721 nft;

    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address publisher = makeAddr("publisher");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dead = 0x000000000000000000000000000000000000dEaD;

    uint128 constant POOL = 1_000e18;
    uint32 constant CLAIM = 30 days;

    // The last published table, for proofs.
    bytes32[] leaves;

    function setUp() public {
        vm.warp(1_800_000_000);
        config = new PlaceConfig(safe, treasury, publisher, 500, 0.0007 ether);
        hub = new PlaceHub(config);
        vm.prank(safe);
        config.setActiveHub(address(hub));

        target = new MockERC20("Target", "TGT");
        reward = new MockERC20("Reward", "RWD");
        nft = new MockERC721();

        reward.mint(creator, 1e30);
        vm.prank(creator);
        reward.approve(address(hub), type(uint256).max);
        vm.deal(creator, 1_000 ether);
    }

    // ─────────────────────────────── Helpers ───────────────────────────────

    function _params(address rewardToken, uint128 pool) internal view returns (PlaceHub.CreateParams memory p) {
        p.kind = PlaceHub.Kind.TokenHolders;
        p.target = address(target);
        p.rewardToken = rewardToken;
        p.pool = pool;
        p.snapshotAt = uint64(block.timestamp + 1 days);
        p.claimDuration = CLAIM;
        p.burnLeftover = false;
        p.rulesHash = keccak256("rules");
        p.rulesURI = "ipfs://rules";
        p.metadataURI = "ipfs://meta";
    }

    function _create(PlaceHub.CreateParams memory p) internal returns (uint256) {
        uint256 value = p.rewardToken == address(0) ? uint256(p.pool) + (uint256(p.pool) * 500) / 10_000 : 0;
        vm.prank(creator);
        return hub.createCampaign{value: value}(p);
    }

    function _createErc20() internal returns (uint256) {
        return _create(_params(address(reward), POOL));
    }

    /// @dev Warps to the snapshot and publishes a table for alice, bob and carol.
    function _publish(uint256 id, uint256 a, uint256 b, uint256 c) internal returns (uint128 total) {
        vm.warp(hub.getCampaign(id).snapshotAt);
        delete leaves;
        leaves.push(hub.leaf(id, alice, a));
        leaves.push(hub.leaf(id, bob, b));
        leaves.push(hub.leaf(id, carol, c));
        total = uint128(a + b + c);
        vm.prank(publisher);
        hub.publishRoot(id, Merkle.root(leaves), total, "ipfs://proofs");
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory) {
        return Merkle.proof(leaves, index);
    }

    function _status(uint256 id) internal view returns (PlaceHub.Status) {
        return hub.statusOf(id);
    }

    // ─────────────────────────────── Create ───────────────────────────────

    function test_create_erc20_holdsPoolAndFee() public {
        uint256 id = _createErc20();
        assertEq(id, 0);
        assertEq(reward.balanceOf(address(hub)), POOL + 50e18);
        assertEq(reward.balanceOf(treasury), 0, "fee is escrowed until the root");

        PlaceHub.Campaign memory c = hub.getCampaign(id);
        assertEq(c.creator, creator);
        assertEq(c.pool, POOL);
        assertEq(c.fee, 50e18);
        assertEq(c.feeBps, 500);
        assertEq(c.rulesURI, "ipfs://rules");
        assertEq(c.metadataURI, "ipfs://meta");
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Scheduled));
        assertEq(hub.campaignCount(), 1);
    }

    function test_create_eth_exactValue() public {
        PlaceHub.CreateParams memory p = _params(address(0), 1 ether);
        vm.prank(creator);
        vm.expectRevert(PlaceHub.WrongPayment.selector);
        hub.createCampaign{value: 1 ether}(p);

        uint256 id = _create(p);
        assertEq(address(hub).balance, 1.05 ether);
        assertEq(hub.getCampaign(id).fee, 0.05 ether);
    }

    function test_create_erc20_rejectsEth() public {
        PlaceHub.CreateParams memory p = _params(address(reward), POOL);
        vm.prank(creator);
        vm.expectRevert(PlaceHub.WrongPayment.selector);
        hub.createCampaign{value: 1}(p);
    }

    function test_create_nftHolders() public {
        PlaceHub.CreateParams memory p = _params(address(reward), POOL);
        p.kind = PlaceHub.Kind.NftHolders;
        p.target = address(nft);
        uint256 id = _create(p);
        assertEq(uint8(hub.getCampaign(id).kind), uint8(PlaceHub.Kind.NftHolders));
    }

    function test_create_nftHolders_rejectsErc20Target() public {
        PlaceHub.CreateParams memory p = _params(address(reward), POOL);
        p.kind = PlaceHub.Kind.NftHolders;
        vm.prank(creator);
        vm.expectRevert(PlaceHub.InvalidTarget.selector);
        hub.createCampaign(p);
    }

    function test_create_validation() public {
        PlaceHub.CreateParams memory p = _params(address(reward), POOL);

        p.target = alice; // not a contract
        _expectCreateRevert(p, PlaceHub.InvalidTarget.selector);
        p = _params(address(reward), 0);
        _expectCreateRevert(p, PlaceHub.InvalidPool.selector);

        p = _params(address(reward), POOL);
        p.snapshotAt = uint64(block.timestamp);
        _expectCreateRevert(p, PlaceHub.InvalidSchedule.selector);
        p.snapshotAt = uint64(block.timestamp + 366 days);
        _expectCreateRevert(p, PlaceHub.InvalidSchedule.selector);

        p = _params(address(reward), POOL);
        p.claimDuration = 1 days - 1;
        _expectCreateRevert(p, PlaceHub.InvalidClaimDuration.selector);
        p.claimDuration = 365 days + 1;
        _expectCreateRevert(p, PlaceHub.InvalidClaimDuration.selector);

        p = _params(address(reward), POOL);
        p.rulesHash = bytes32(0);
        _expectCreateRevert(p, PlaceHub.InvalidRules.selector);
        p = _params(address(reward), POOL);
        p.rulesURI = "";
        _expectCreateRevert(p, PlaceHub.InvalidRules.selector);

        p = _params(alice, POOL); // reward token without code
        _expectCreateRevert(p, PlaceHub.UnsupportedToken.selector);
    }

    function _expectCreateRevert(PlaceHub.CreateParams memory p, bytes4 sel) internal {
        vm.prank(creator);
        vm.expectRevert(sel);
        hub.createCampaign(p);
    }

    function test_create_poolPlusFeeMustFitUint128() public {
        reward.mint(creator, type(uint256).max - reward.totalSupply());
        uint128 pool = type(uint128).max - 1;
        _expectCreateRevert(_params(address(reward), pool), PlaceHub.InvalidPool.selector);
        // The largest pool that still refunds in full.
        pool = uint128((uint256(type(uint128).max) * 10_000) / 10_500);
        uint256 id = _create(_params(address(reward), pool));
        vm.warp(hub.getCampaign(id).snapshotAt + 72 hours);
        vm.prank(creator);
        hub.refundUnpublished(id);
        assertEq(reward.balanceOf(address(hub)), 0);
    }

    function test_create_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken tax = new FeeOnTransferToken();
        tax.mint(creator, 1e30);
        vm.prank(creator);
        tax.approve(address(hub), type(uint256).max);
        _expectCreateRevert(_params(address(tax), POOL), PlaceHub.UnsupportedToken.selector);
    }

    function test_create_pausedOnlyBlocksNewCampaigns() public {
        uint256 id = _createErc20();
        vm.prank(safe);
        config.setNewCampaignsPaused(true);
        _expectCreateRevert(_params(address(reward), POOL), PlaceHub.Paused.selector);

        // The existing campaign still goes all the way through.
        _publish(id, 100e18, 0, 0);
        vm.prank(alice);
        hub.claim(id, 100e18, _proof(0));
        assertEq(reward.balanceOf(alice), 100e18);
    }

    function test_create_targetFeeOverride() public {
        vm.prank(safe);
        config.setTargetFee(address(target), true, 100);
        uint256 id = _createErc20();
        assertEq(hub.getCampaign(id).fee, 10e18);
        assertEq(hub.getCampaign(id).feeBps, 100);
    }

    function test_feeChangeDoesNotAffectExistingCampaign() public {
        uint256 id = _createErc20();
        vm.prank(safe);
        config.setFeeBps(1_000);
        _publish(id, 1e18, 0, 0);
        assertEq(reward.balanceOf(treasury), 50e18);
    }

    // ─────────────────────────────── Cancel ───────────────────────────────

    function test_cancel_beforeSnapshot_returnsPoolKeepsFee() public {
        uint256 id = _createErc20();
        uint256 before = reward.balanceOf(creator);
        vm.prank(creator);
        hub.cancel(id);
        assertEq(reward.balanceOf(creator) - before, POOL);
        assertEq(reward.balanceOf(treasury), 50e18);
        assertEq(reward.balanceOf(address(hub)), 0);
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Cancelled));

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Cancelled));
        hub.cancel(id);
    }

    function test_cancel_onlyCreator() public {
        uint256 id = _createErc20();
        vm.prank(alice);
        vm.expectRevert(PlaceHub.NotCreator.selector);
        hub.cancel(id);
    }

    function test_cancel_notAfterSnapshot() public {
        uint256 id = _createErc20();
        vm.warp(hub.getCampaign(id).snapshotAt);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Snapshotting));
        hub.cancel(id);
    }

    // ─────────────────────────────── Publish ───────────────────────────────

    function test_publish_opensClaimsAndPaysFee() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 200e18, 300e18);
        PlaceHub.Campaign memory c = hub.getCampaign(id);
        assertEq(c.totalAllocated, 600e18);
        assertEq(c.claimEnd, block.timestamp + CLAIM);
        assertEq(c.proofsURI, "ipfs://proofs");
        assertEq(reward.balanceOf(treasury), 50e18);
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Live));
    }

    function test_publish_onlyPublisher() public {
        uint256 id = _createErc20();
        vm.warp(hub.getCampaign(id).snapshotAt);
        vm.prank(creator);
        vm.expectRevert(PlaceHub.NotPublisher.selector);
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
    }

    function test_publish_notBeforeSnapshot() public {
        uint256 id = _createErc20();
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Scheduled));
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
    }

    function test_publish_rejectsBadRootOrTotal() public {
        uint256 id = _createErc20();
        vm.warp(hub.getCampaign(id).snapshotAt);
        vm.startPrank(publisher);
        vm.expectRevert(PlaceHub.InvalidRoot.selector);
        hub.publishRoot(id, bytes32(0), 1, "");
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.AllocationExceeded.selector, id));
        hub.publishRoot(id, bytes32(uint256(1)), POOL + 1, "");
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.AllocationExceeded.selector, id));
        hub.publishRoot(id, bytes32(uint256(1)), 0, "");
        vm.stopPrank();
    }

    function test_publish_correctionBeforeFirstClaim() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 0, 0);
        uint64 end = hub.getCampaign(id).claimEnd;
        vm.warp(block.timestamp + 1 hours);
        _publishAgain(id, 50e18, 50e18, 0);
        assertEq(hub.getCampaign(id).claimEnd, end, "window stays");
        assertEq(reward.balanceOf(treasury), 50e18, "fee paid once");

        vm.prank(bob);
        hub.claim(id, 50e18, _proof(1));

        delete leaves;
        leaves.push(hub.leaf(id, alice, 1));
        bytes32 root = Merkle.root(leaves);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Live));
        hub.publishRoot(id, root, 1, "");
    }

    function _publishAgain(uint256 id, uint256 a, uint256 b, uint256 c) internal {
        delete leaves;
        leaves.push(hub.leaf(id, alice, a));
        leaves.push(hub.leaf(id, bob, b));
        leaves.push(hub.leaf(id, carol, c));
        vm.prank(publisher);
        hub.publishRoot(id, Merkle.root(leaves), uint128(a + b + c), "ipfs://proofs2");
    }

    function test_publish_rotatedPublisher() public {
        uint256 id = _createErc20();
        address next = makeAddr("next");
        vm.prank(safe);
        config.setPublisher(next);
        vm.warp(hub.getCampaign(id).snapshotAt);
        vm.prank(publisher);
        vm.expectRevert(PlaceHub.NotPublisher.selector);
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
        vm.prank(next);
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
    }

    // ─────────────────────────────── Claim ───────────────────────────────

    function test_claim() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 200e18, 300e18);
        assertTrue(hub.canClaim(alice, id, 100e18, _proof(0)));

        vm.prank(alice);
        hub.claim(id, 100e18, _proof(0));
        assertEq(reward.balanceOf(alice), 100e18);
        assertTrue(hub.isClaimed(id, alice));
        assertEq(hub.getCampaign(id).claimed, 100e18);
        assertFalse(hub.canClaim(alice, id, 100e18, _proof(0)));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.AlreadyClaimed.selector, id, alice));
        hub.claim(id, 100e18, _proof(0));
    }

    function test_claim_wrongAmountOrAccount() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 200e18, 300e18);
        vm.prank(alice);
        vm.expectRevert(PlaceHub.InvalidProof.selector);
        hub.claim(id, 101e18, _proof(0));
        vm.prank(bob);
        vm.expectRevert(PlaceHub.InvalidProof.selector);
        hub.claim(id, 100e18, _proof(0));
    }

    function test_claimFor_paysTheAccount() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 200e18, 300e18);
        address agent = makeAddr("agent");
        vm.prank(agent);
        hub.claimFor(bob, id, 200e18, _proof(1));
        assertEq(reward.balanceOf(bob), 200e18);
        assertEq(reward.balanceOf(agent), 0);
    }

    function test_claim_proofFromAnotherCampaignFails() public {
        uint256 a = _createErc20();
        uint256 b = _createErc20();
        _publish(a, 100e18, 200e18, 300e18);
        bytes32[] memory proofA = _proof(0);
        vm.prank(publisher);
        hub.publishRoot(b, Merkle.root(leaves), 600e18, ""); // same table, but leaves are bound to campaign a
        vm.prank(alice);
        vm.expectRevert(PlaceHub.InvalidProof.selector);
        hub.claim(b, 100e18, proofA);
    }

    function test_claim_eth() public {
        uint256 id = _create(_params(address(0), 1 ether));
        _publish(id, 0.25 ether, 0.75 ether, 0);
        vm.prank(bob);
        hub.claim(id, 0.75 ether, _proof(1));
        assertEq(bob.balance, 0.75 ether);
        assertEq(treasury.balance, 0.05 ether);
    }

    function test_claim_ethToContractThatRejects() public {
        RejectsEth r = new RejectsEth();
        uint256 id = _create(_params(address(0), 1 ether));
        vm.warp(hub.getCampaign(id).snapshotAt);
        delete leaves;
        leaves.push(hub.leaf(id, address(r), 1 ether));
        leaves.push(hub.leaf(id, alice, 0));
        vm.prank(publisher);
        hub.publishRoot(id, Merkle.root(leaves), 1 ether, "");
        vm.expectRevert(PlaceHub.EthTransferFailed.selector);
        hub.claimFor(address(r), id, 1 ether, _proof(0));
        assertFalse(hub.isClaimed(id, address(r)));
    }

    function test_claimMany() public {
        uint256 a = _createErc20();
        uint256 e = _create(_params(address(0), 1 ether));
        _publish(a, 100e18, 0, 0);
        bytes32[] memory pa = _proof(0);
        delete leaves;
        leaves.push(hub.leaf(e, alice, 0.5 ether));
        leaves.push(hub.leaf(e, bob, 0.5 ether));
        vm.prank(publisher);
        hub.publishRoot(e, Merkle.root(leaves), 1 ether, "");
        bytes32[] memory pe = _proof(0);

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = e;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e18;
        amounts[1] = 0.5 ether;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = pa;
        proofs[1] = pe;

        hub.claimMany(alice, ids, amounts, proofs);
        assertEq(reward.balanceOf(alice), 100e18);
        assertEq(alice.balance, 0.5 ether);

        vm.expectRevert(PlaceHub.LengthMismatch.selector);
        hub.claimMany(alice, ids, new uint256[](1), proofs);
    }

    function test_claim_closedAfterEnd() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 0, 0);
        vm.warp(hub.getCampaign(id).claimEnd);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Ended));
        hub.claim(id, 100e18, _proof(0));
    }

    // ─────────────────────────────── Refund ───────────────────────────────

    function test_refundUnpublished() public {
        uint256 id = _createErc20();
        uint64 snap = hub.getCampaign(id).snapshotAt;
        vm.warp(snap + 72 hours - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Snapshotting));
        hub.refundUnpublished(id);

        vm.warp(snap + 72 hours);
        uint256 before = reward.balanceOf(creator);
        vm.prank(creator);
        hub.refundUnpublished(id);
        assertEq(reward.balanceOf(creator) - before, POOL + 50e18, "pool and fee back");
        assertEq(reward.balanceOf(treasury), 0);
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Refunded));

        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Refunded));
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
    }

    function test_publish_lateButBeforeRefund() public {
        uint256 id = _createErc20();
        vm.warp(hub.getCampaign(id).snapshotAt + 80 hours);
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Refundable));
        vm.prank(publisher);
        hub.publishRoot(id, bytes32(uint256(1)), 1, "");
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Live));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Live));
        hub.refundUnpublished(id);
    }

    // ─────────────────────────────── Extend ───────────────────────────────

    function test_extendClaim() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 0, 0);
        uint64 end = hub.getCampaign(id).claimEnd;

        vm.startPrank(creator);
        vm.expectRevert(PlaceHub.InvalidClaimEnd.selector);
        hub.extendClaim(id, end);
        vm.expectRevert(PlaceHub.InvalidClaimEnd.selector);
        hub.extendClaim(id, uint64(block.timestamp + 366 days));
        hub.extendClaim(id, end + 7 days);
        vm.stopPrank();
        assertEq(hub.getCampaign(id).claimEnd, end + 7 days);

        vm.prank(alice);
        vm.expectRevert(PlaceHub.NotCreator.selector);
        hub.extendClaim(id, end + 8 days);
    }

    function test_extendClaim_notBeforeRoot() public {
        uint256 id = _createErc20();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Scheduled));
        hub.extendClaim(id, uint64(block.timestamp + 40 days));
    }

    // ─────────────────────────────── Finalize ───────────────────────────────

    function test_finalize_returnsLeftover() public {
        uint256 id = _createErc20();
        _publish(id, 100e18, 200e18, 300e18);
        vm.prank(alice);
        hub.claim(id, 100e18, _proof(0));

        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Live));
        hub.finalize(id);

        vm.warp(hub.getCampaign(id).claimEnd);
        uint256 before = reward.balanceOf(creator);
        hub.finalize(id);
        assertEq(reward.balanceOf(creator) - before, POOL - 100e18);
        assertEq(reward.balanceOf(address(hub)), 0);
        assertEq(uint8(_status(id)), uint8(PlaceHub.Status.Closed));

        vm.expectRevert(abi.encodeWithSelector(PlaceHub.WrongStatus.selector, id, PlaceHub.Status.Closed));
        hub.finalize(id);
    }

    function test_finalize_burnsLeftover() public {
        PlaceHub.CreateParams memory p = _params(address(reward), POOL);
        p.burnLeftover = true;
        uint256 id = _create(p);
        _publish(id, 100e18, 0, 0);
        vm.warp(hub.getCampaign(id).claimEnd);
        hub.finalize(id);
        assertEq(reward.balanceOf(dead), POOL);
    }

    function test_updateMetadata() public {
        uint256 id = _createErc20();
        vm.prank(creator);
        hub.updateMetadata(id, "ipfs://meta2");
        assertEq(hub.getCampaign(id).metadataURI, "ipfs://meta2");
        vm.prank(alice);
        vm.expectRevert(PlaceHub.NotCreator.selector);
        hub.updateMetadata(id, "x");
    }

    function test_notFound() public {
        vm.expectRevert(abi.encodeWithSelector(PlaceHub.NotFound.selector, 7));
        hub.getCampaign(7);
        assertEq(uint8(hub.statusOf(7)), uint8(PlaceHub.Status.None));
    }

    // ─────────────────────────────── Fuzz ───────────────────────────────

    /// @dev Whatever the pool, fee and table: every claim pays out, the treasury gets exactly the fee, and after
    ///      finalize the hub holds nothing for the campaign.
    function testFuzz_fullLifecycleAccounting(uint128 pool, uint16 feeBps, uint256 a, uint256 b, uint256 c) public {
        pool = uint128(bound(pool, 1, 9e29)); // the creator holds 1e30, enough for pool + a 10% fee
        feeBps = uint16(bound(feeBps, 0, 1_000));
        a = bound(a, 0, pool);
        b = bound(b, 0, pool - a);
        c = bound(c, 0, pool - a - b);
        vm.assume(a + b + c > 0);

        vm.prank(safe);
        config.setFeeBps(feeBps);
        uint256 fee = (uint256(pool) * feeBps) / 10_000;
        uint256 startCreator = reward.balanceOf(creator);

        uint256 id = _create(_params(address(reward), pool));
        _publish(id, a, b, c);
        hub.claimFor(alice, id, a, _proof(0));
        hub.claimFor(bob, id, b, _proof(1));
        hub.claimFor(carol, id, c, _proof(2));
        vm.warp(hub.getCampaign(id).claimEnd);
        hub.finalize(id);

        assertEq(reward.balanceOf(alice), a);
        assertEq(reward.balanceOf(bob), b);
        assertEq(reward.balanceOf(carol), c);
        assertEq(reward.balanceOf(treasury), fee);
        assertEq(reward.balanceOf(address(hub)), 0);
        assertEq(startCreator - reward.balanceOf(creator), a + b + c + fee);
    }

    /// @dev Several campaigns in the same token never dip into each other's pools.
    function testFuzz_campaignsAreIsolated(uint128 p1, uint128 p2, uint256 claim1) public {
        p1 = uint128(bound(p1, 1, 1e27));
        p2 = uint128(bound(p2, 1, 1e27));
        claim1 = bound(claim1, 1, p1);
        uint256 id1 = _create(_params(address(reward), p1));
        uint256 id2 = _create(_params(address(reward), p2));

        _publish(id1, claim1, 0, 0);
        hub.claimFor(alice, id1, claim1, _proof(0));
        // A table for campaign 1 can never pull more than campaign 1's allocation.
        vm.expectRevert();
        hub.claimFor(alice, id1, claim1, _proof(0));

        vm.prank(creator);
        vm.expectRevert(); // campaign 2 is past its snapshot (same snapshotAt), no cancel
        hub.cancel(id2);
        vm.warp(hub.getCampaign(id2).snapshotAt + 72 hours);
        uint256 before = reward.balanceOf(creator);
        vm.prank(creator);
        hub.refundUnpublished(id2);
        assertEq(reward.balanceOf(creator) - before, uint256(p2) + (uint256(p2) * 500) / 10_000);
    }
}
