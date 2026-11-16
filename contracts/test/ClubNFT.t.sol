// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PlaceConfig} from "../src/PlaceConfig.sol";
import {ClubNFT} from "../src/nft/ClubNFT.sol";
import {NftFactory} from "../src/nft/NftFactory.sol";
import {MockERC20, MockSwapRouter} from "./utils/Mocks.sol";

contract ClubNFTTest is Test {
    PlaceConfig config;
    NftFactory factory;
    ClubNFT impl;
    MockERC20 burnTok;
    MockSwapRouter router;

    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address payout = makeAddr("payout");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address weth = makeAddr("weth");
    address dead = 0x000000000000000000000000000000000000dEaD;

    uint256 constant FEE = 0.0007 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        config = new PlaceConfig(safe, treasury, makeAddr("publisher"), 500, FEE);
        impl = new ClubNFT();
        factory = new NftFactory(config, address(impl), safe);
        burnTok = new MockERC20("Burn", "BURN");
        router = new MockSwapRouter(burnTok, weth);
        vm.deal(creator, 10 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _params() internal view returns (ClubNFT.InitParams memory p) {
        p.name = "Club";
        p.symbol = "CLUB";
        p.maxSupply = 10;
        p.maxPerWallet = 2;
        p.paymentToken = address(0);
        p.price = 0.01 ether;
        p.mintStart = uint64(block.timestamp);
        p.payout = payout;
        p.burnBps = 8_000;
        p.burnToken = address(burnTok);
        p.swapRouter = address(router);
        p.swapPoolFee = 10_000;
        p.baseURI = "ipfs://base/";
        p.contractURI = "ipfs://contract";
        p.royaltyReceiver = payout;
        p.royaltyBps = 500;
    }

    function _deploy(ClubNFT.InitParams memory p) internal returns (ClubNFT) {
        vm.prank(creator);
        return ClubNFT(factory.createCollection{value: FEE}(p));
    }

    // ─────────────────────────────── Factory ───────────────────────────────

    function test_factory_deploysCloneAndPaysFee() public {
        ClubNFT c = _deploy(_params());
        assertEq(c.owner(), creator);
        assertEq(c.name(), "Club");
        assertEq(c.symbol(), "CLUB");
        assertEq(treasury.balance, FEE);
        assertTrue(factory.isCollection(address(c)));
        assertEq(factory.collectionCount(), 1);
        assertEq(address(c).code.length, 45, "EIP-1167 clone");
    }

    function test_factory_wrongFee() public {
        ClubNFT.InitParams memory p = _params();
        vm.prank(creator);
        vm.expectRevert(NftFactory.WrongFee.selector);
        factory.createCollection{value: FEE - 1}(p);
    }

    function test_factory_deployerOverride() public {
        vm.prank(safe);
        config.setDeployerNftFee(creator, true, 0);
        ClubNFT.InitParams memory p = _params();
        vm.prank(creator);
        factory.createCollection(p);
        assertEq(treasury.balance, 0);
    }

    function test_factory_newImplementationOnlyForNewCollections() public {
        ClubNFT a = _deploy(_params());
        ClubNFT impl2 = new ClubNFT();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setImplementation(address(impl2));
        vm.prank(safe);
        factory.setImplementation(address(impl2));
        ClubNFT b = _deploy(_params());
        assertEq(_cloneTarget(address(b)), address(impl2));
        assertEq(_cloneTarget(address(a)), address(impl));
    }

    function _cloneTarget(address clone) internal view returns (address impl_) {
        bytes memory code = clone.code;
        assembly {
            impl_ := shr(96, mload(add(code, 42)))
        }
    }

    function test_implementationAndClonesCannotBeReinitialized() public {
        ClubNFT.InitParams memory p = _params();
        vm.expectRevert(ClubNFT.AlreadyInitialized.selector);
        impl.initialize(p, alice);
        ClubNFT c = _deploy(p);
        vm.expectRevert(ClubNFT.AlreadyInitialized.selector);
        c.initialize(p, alice);
    }

    function test_initValidation() public {
        ClubNFT.InitParams memory p = _params();
        p.burnToken = address(0);
        _expectDeployRevert(p, ClubNFT.InvalidParams.selector);

        p = _params();
        p.swapRouter = address(0); // ETH payments need a swap to buy back
        _expectDeployRevert(p, ClubNFT.InvalidParams.selector);

        p = _params();
        p.burnBps = 10_001;
        _expectDeployRevert(p, ClubNFT.InvalidParams.selector);

        p = _params();
        p.maxSupply = 0;
        _expectDeployRevert(p, ClubNFT.InvalidParams.selector);

        p = _params();
        p.royaltyBps = 1_001;
        _expectDeployRevert(p, ClubNFT.RoyaltyTooHigh.selector);
    }

    function _expectDeployRevert(ClubNFT.InitParams memory p, bytes4 sel) internal {
        vm.prank(creator);
        vm.expectRevert(sel);
        factory.createCollection{value: FEE}(p);
    }

    // ─────────────────────────────── Mint ───────────────────────────────

    function test_mint_eth_exactPrice() public {
        ClubNFT c = _deploy(_params());
        vm.startPrank(alice);
        vm.expectRevert(ClubNFT.WrongPayment.selector);
        c.mint{value: 1}(1); // dust never mints
        vm.expectRevert(ClubNFT.WrongPayment.selector);
        c.mint{value: 0.03 ether}(2);
        c.mint{value: 0.02 ether}(2);
        vm.stopPrank();

        assertEq(c.balanceOf(alice), 2);
        assertEq(c.ownerOf(1), alice);
        assertEq(c.ownerOf(2), alice);
        assertEq(c.totalSupply(), 2);
        assertEq(c.buybackBalance(), 0.016 ether);
        assertEq(c.payoutBalance(), 0.004 ether);
        assertEq(c.tokenURI(1), "ipfs://base/1");
    }

    function test_mint_limits() public {
        ClubNFT.InitParams memory p = _params();
        p.mintStart = uint64(block.timestamp + 1 hours);
        p.maxSupply = 3;
        ClubNFT c = _deploy(p);

        vm.prank(alice);
        vm.expectRevert(ClubNFT.MintNotStarted.selector);
        c.mint{value: 0.01 ether}(1);
        vm.warp(block.timestamp + 1 hours);

        vm.prank(alice);
        vm.expectRevert(ClubNFT.WalletLimit.selector);
        c.mint{value: 0.03 ether}(3);

        vm.prank(alice);
        c.mint{value: 0.02 ether}(2);
        vm.prank(bob);
        vm.expectRevert(ClubNFT.SoldOut.selector);
        c.mint{value: 0.02 ether}(2);
        vm.prank(bob);
        c.mint{value: 0.01 ether}(1);
        assertEq(c.totalSupply(), 3);
    }

    function test_mint_payInBurnToken_burnsAtOnce() public {
        ClubNFT.InitParams memory p = _params();
        p.paymentToken = address(burnTok);
        p.price = 1_000e18;
        p.swapRouter = address(0); // not needed when paying in the burn token
        ClubNFT c = _deploy(p);

        burnTok.mint(alice, 10_000e18);
        vm.startPrank(alice);
        burnTok.approve(address(c), type(uint256).max);
        vm.expectRevert(ClubNFT.WrongPayment.selector);
        c.mint{value: 1}(1);
        c.mint(2);
        vm.stopPrank();

        assertEq(burnTok.balanceOf(dead), 1_600e18);
        assertEq(c.payoutBalance(), 400e18);
        assertEq(c.buybackBalance(), 0);

        c.withdrawPayout();
        assertEq(burnTok.balanceOf(payout), 400e18);
    }

    function test_withdrawPayout_eth() public {
        ClubNFT c = _deploy(_params());
        vm.prank(alice);
        c.mint{value: 0.01 ether}(1);
        vm.prank(bob); // anyone can trigger, money goes to payout
        c.withdrawPayout();
        assertEq(payout.balance, 0.002 ether);
        vm.expectRevert(ClubNFT.NothingToDo.selector);
        c.withdrawPayout();
    }

    function test_ownerMint() public {
        ClubNFT c = _deploy(_params());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        c.ownerMint(alice, 1);
        vm.prank(creator);
        c.ownerMint(bob, 5); // above the wallet limit is fine for the owner
        assertEq(c.balanceOf(bob), 5);
        vm.prank(creator);
        vm.expectRevert(ClubNFT.SoldOut.selector);
        c.ownerMint(bob, 6);
    }

    // ─────────────────────────────── Settings ───────────────────────────────

    function test_priceLockedAfterFirstMint() public {
        ClubNFT c = _deploy(_params());
        vm.startPrank(creator);
        c.setPrice(0.02 ether);
        c.setMintStart(uint64(block.timestamp));
        vm.stopPrank();
        vm.prank(alice);
        c.mint{value: 0.02 ether}(1);
        vm.startPrank(creator);
        vm.expectRevert(ClubNFT.MintStarted.selector);
        c.setPrice(0);
        vm.expectRevert(ClubNFT.MintStarted.selector);
        c.setMintStart(0);
        vm.stopPrank();
    }

    function test_freezeMetadata() public {
        ClubNFT c = _deploy(_params());
        vm.startPrank(creator);
        c.setBaseURI("ipfs://v2/");
        c.setContractURI("ipfs://c2");
        c.freezeMetadata();
        vm.expectRevert(ClubNFT.Frozen.selector);
        c.setBaseURI("ipfs://v3/");
        vm.expectRevert(ClubNFT.Frozen.selector);
        c.setContractURI("ipfs://c3");
        vm.stopPrank();
        assertEq(c.baseURI(), "ipfs://v2/");
    }

    function test_royalty() public {
        ClubNFT c = _deploy(_params());
        (address r, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(r, payout);
        assertEq(amount, 0.05 ether);
        vm.startPrank(creator);
        vm.expectRevert(ClubNFT.RoyaltyTooHigh.selector);
        c.setRoyalty(payout, 1_001);
        c.setRoyalty(alice, 1_000);
        vm.stopPrank();
        (r, amount) = c.royaltyInfo(1, 1 ether);
        assertEq(r, alice);
        assertEq(amount, 0.1 ether);
        assertTrue(c.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(c.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(c.supportsInterface(0x49064906)); // ERC-4906
    }

    // ─────────────────────────────── Buyback ───────────────────────────────

    function test_buybackAndBurn_eth() public {
        ClubNFT c = _deploy(_params());
        vm.prank(alice);
        c.mint{value: 0.02 ether}(2);

        vm.startPrank(creator);
        vm.expectRevert(ClubNFT.InvalidParams.selector);
        c.buybackAndBurn(0.016 ether, 0, block.timestamp); // no minimum = no sandwich protection
        vm.expectRevert(ClubNFT.InvalidParams.selector);
        c.buybackAndBurn(0.016 ether + 1, 1, block.timestamp);
        vm.expectRevert(ClubNFT.Expired.selector);
        c.buybackAndBurn(0.016 ether, 1, block.timestamp - 1);

        c.buybackAndBurn(0.016 ether, 0.032 ether, block.timestamp);
        vm.stopPrank();

        assertEq(burnTok.balanceOf(dead), 0.032 ether);
        assertEq(c.buybackBalance(), 0);
        (address tokenIn, address tokenOut, uint24 fee,,, uint256 minOut,) = router.last();
        assertEq(tokenIn, weth);
        assertEq(tokenOut, address(burnTok));
        assertEq(fee, 10_000);
        assertEq(minOut, 0.032 ether);
        assertEq(address(router).balance, 0.016 ether);
    }

    function test_buyback_checksReceivedAmount() public {
        ClubNFT c = _deploy(_params());
        vm.prank(alice);
        c.mint{value: 0.01 ether}(1);
        router.setShortfall(1);
        vm.prank(creator);
        vm.expectRevert(ClubNFT.WrongPayment.selector);
        c.buybackAndBurn(0.008 ether, 0.016 ether, block.timestamp);
    }

    function test_buyback_onlyOwner() public {
        ClubNFT c = _deploy(_params());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        c.buybackAndBurn(1, 1, block.timestamp);
    }

    function test_buyback_erc20Payment() public {
        MockERC20 usdc = new MockERC20("USD", "USDC");
        ClubNFT.InitParams memory p = _params();
        p.paymentToken = address(usdc);
        p.price = 100e6;
        ClubNFT c = _deploy(p);
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(c), type(uint256).max);
        c.mint(1);
        vm.stopPrank();
        assertEq(c.buybackBalance(), 80e6);

        vm.prank(creator);
        c.buybackAndBurn(80e6, 160e6, block.timestamp);
        assertEq(burnTok.balanceOf(dead), 160e6);
        assertEq(usdc.balanceOf(address(router)), 80e6);
        assertEq(usdc.allowance(address(c), address(router)), 0);
    }

    // ─────────────────────────────── Fuzz ───────────────────────────────

    /// @dev Revenue is always split exactly: payout + buyback/burn = what minters paid.
    function testFuzz_revenueSplit(uint16 burnBps, uint128 price, uint8 qty) public {
        burnBps = uint16(bound(burnBps, 0, 10_000));
        price = uint128(bound(price, 0, 1 ether));
        qty = uint8(bound(qty, 1, 10));
        ClubNFT.InitParams memory p = _params();
        p.burnBps = burnBps;
        p.price = price;
        p.maxPerWallet = 0;
        ClubNFT c = _deploy(p);

        uint256 cost = uint256(price) * qty;
        vm.deal(alice, cost);
        vm.prank(alice);
        c.mint{value: cost}(qty);
        assertEq(c.payoutBalance() + c.buybackBalance(), cost);
        assertEq(address(c).balance, cost);
        assertEq(c.buybackBalance(), (cost * burnBps) / 10_000);
    }
}
