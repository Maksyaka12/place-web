// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlaceConfig} from "../PlaceConfig.sol";
import {ClubNFT} from "./ClubNFT.sol";

/// @title NftFactory
/// @notice Deploys ClubNFT collections as EIP-1167 clones for a fixed fee that goes to the Place treasury.
/// @dev    The owner (platform Safe) can point the factory at a new ClubNFT implementation; collections that
///         already exist keep the code they were cloned from.
contract NftFactory is Ownable2Step, ReentrancyGuard {
    PlaceConfig public immutable config;

    /// @notice What new collections are cloned from.
    address public implementation;

    address[] public collections;
    mapping(address => bool) public isCollection;

    event CollectionCreated(
        address indexed collection, address indexed creator, address indexed implementation, uint256 feePaid
    );
    event ImplementationSet(address implementation);

    error ZeroAddress();
    error WrongFee();
    error EthTransferFailed();

    constructor(PlaceConfig config_, address implementation_, address owner_) Ownable(owner_) {
        if (address(config_) == address(0)) revert ZeroAddress();
        config = config_;
        _setImplementation(implementation_);
    }

    /// @notice Deploys a collection owned by the caller. msg.value must equal the caller's current deploy fee.
    function createCollection(ClubNFT.InitParams calldata p) external payable nonReentrant returns (address c) {
        uint256 fee = config.nftDeployFeeFor(msg.sender);
        if (msg.value != fee) revert WrongFee();

        address impl = implementation;
        c = Clones.clone(impl);
        ClubNFT(c).initialize(p, msg.sender);
        collections.push(c);
        isCollection[c] = true;

        if (fee != 0) {
            (bool ok,) = payable(config.treasury()).call{value: fee}("");
            if (!ok) revert EthTransferFailed();
        }
        emit CollectionCreated(c, msg.sender, impl, fee);
    }

    function setImplementation(address implementation_) external onlyOwner {
        _setImplementation(implementation_);
    }

    function collectionCount() external view returns (uint256) {
        return collections.length;
    }

    function _setImplementation(address implementation_) internal {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert ZeroAddress();
        implementation = implementation_;
        emit ImplementationSet(implementation_);
    }
}
