// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlaceConfig
/// @notice Platform settings shared by every PlaceHub version and the NFT factory: fees, treasury, the
///         snapshot publisher, the pause on new campaigns and which hub takes new campaigns.
/// @dev    The owner is the platform Safe. Every value is bounded in code, and nothing here can touch a
///         campaign's pool: hubs copy the fee into the campaign at creation, so a later change only affects
///         new campaigns. Not upgradeable; a new config is a new contract.
contract PlaceConfig is Ownable2Step {
    /// @notice Upper bound for any campaign fee: 10%.
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice Upper bound for the NFT collection deploy fee.
    uint256 public constant MAX_NFT_DEPLOY_FEE = 0.01 ether;

    struct FeeOverride {
        bool set;
        uint16 bps;
    }

    struct NftFeeOverride {
        bool set;
        uint128 fee;
    }

    /// @notice Default campaign fee in basis points, charged on top of the pool.
    uint16 public feeBps;
    /// @notice Default fee for deploying an NFT collection, in wei.
    uint256 public nftDeployFee;
    /// @notice Receives every fee.
    address public treasury;
    /// @notice The Place service wallet that posts Merkle roots after a snapshot.
    address public publisher;
    /// @notice While true, hubs refuse new campaigns. Existing campaigns and claims are never paused.
    bool public newCampaignsPaused;
    /// @notice The hub that new campaigns go to (older hubs keep serving their own campaigns).
    address public activeHub;
    /// @notice The factory that new NFT collections go through.
    address public nftFactory;

    /// @notice Per-target campaign fee (a discount for a partner project).
    mapping(address target => FeeOverride) public targetFee;
    /// @notice Per-deployer NFT collection deploy fee.
    mapping(address deployer => NftFeeOverride) public deployerNftFee;

    event FeeBpsSet(uint16 bps);
    event NftDeployFeeSet(uint256 fee);
    event TreasurySet(address treasury);
    event PublisherSet(address publisher);
    event NewCampaignsPausedSet(bool paused);
    event ActiveHubSet(address hub);
    event NftFactorySet(address factory);
    event TargetFeeSet(address indexed target, bool set, uint16 bps);
    event DeployerNftFeeSet(address indexed deployer, bool set, uint128 fee);

    error ZeroAddress();
    error FeeTooHigh();

    constructor(address owner_, address treasury_, address publisher_, uint16 feeBps_, uint256 nftDeployFee_)
        Ownable(owner_)
    {
        _setTreasury(treasury_);
        _setPublisher(publisher_);
        _setFeeBps(feeBps_);
        _setNftDeployFee(nftDeployFee_);
    }

    // ─────────────────────────────── Views ───────────────────────────────

    /// @notice The fee a new campaign for `target` pays right now.
    function campaignFeeBps(address target) external view returns (uint16) {
        FeeOverride memory o = targetFee[target];
        return o.set ? o.bps : feeBps;
    }

    /// @notice The fee `deployer` pays right now to deploy an NFT collection.
    function nftDeployFeeFor(address deployer) external view returns (uint256) {
        NftFeeOverride memory o = deployerNftFee[deployer];
        return o.set ? o.fee : nftDeployFee;
    }

    // ─────────────────────────────── Owner ───────────────────────────────

    function setFeeBps(uint16 bps) external onlyOwner {
        _setFeeBps(bps);
    }

    function setNftDeployFee(uint256 fee) external onlyOwner {
        _setNftDeployFee(fee);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function setPublisher(address publisher_) external onlyOwner {
        _setPublisher(publisher_);
    }

    function setNewCampaignsPaused(bool paused) external onlyOwner {
        newCampaignsPaused = paused;
        emit NewCampaignsPausedSet(paused);
    }

    function setActiveHub(address hub) external onlyOwner {
        if (hub == address(0)) revert ZeroAddress();
        activeHub = hub;
        emit ActiveHubSet(hub);
    }

    function setNftFactory(address factory) external onlyOwner {
        if (factory == address(0)) revert ZeroAddress();
        nftFactory = factory;
        emit NftFactorySet(factory);
    }

    /// @notice Sets (`set` = true) or clears a per-target campaign fee.
    function setTargetFee(address target, bool set, uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        targetFee[target] = FeeOverride(set, set ? bps : 0);
        emit TargetFeeSet(target, set, set ? bps : 0);
    }

    /// @notice Sets (`set` = true) or clears a per-deployer NFT deploy fee.
    function setDeployerNftFee(address deployer, bool set, uint128 fee) external onlyOwner {
        if (fee > MAX_NFT_DEPLOY_FEE) revert FeeTooHigh();
        deployerNftFee[deployer] = NftFeeOverride(set, set ? fee : 0);
        emit DeployerNftFeeSet(deployer, set, set ? fee : 0);
    }

    // ─────────────────────────────── Internal ───────────────────────────────

    function _setFeeBps(uint16 bps) internal {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function _setNftDeployFee(uint256 fee) internal {
        if (fee > MAX_NFT_DEPLOY_FEE) revert FeeTooHigh();
        nftDeployFee = fee;
        emit NftDeployFeeSet(fee);
    }

    function _setTreasury(address treasury_) internal {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setPublisher(address publisher_) internal {
        if (publisher_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        emit PublisherSet(publisher_);
    }
}
