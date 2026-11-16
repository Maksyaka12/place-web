// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {PlaceConfig} from "./PlaceConfig.sol";

/// @title PlaceHub
/// @notice Every reward campaign on Place: creation and funding in one transaction, Merkle roots posted by the
///         Place publisher after the snapshot, claims, extension, refunds and finalization (§4).
/// @dev    Immutable and ownerless. Nobody — not the platform, not the creator — can take a campaign's pool
///         while it runs, and nothing can pause claims. New features ship as a new hub next to this one.
///
///         Money flow per campaign:
///         - create: the creator pays pool + fee; both stay here.
///         - cancel (before the snapshot): pool back to the creator, fee to the treasury.
///         - publishRoot (first time): fee to the treasury, claims open for `claimDuration`.
///         - refundUnpublished (no root 72 h after the snapshot): pool and fee back to the creator.
///         - finalize (after claimEnd): the unclaimed rest back to the creator or burned.
///
///         Leaf = keccak256(bytes.concat(keccak256(abi.encode(hub, chainId, campaignId, account, amount)))),
///         the OpenZeppelin StandardMerkleTree format with the hub, chain and campaign bound in, so a proof
///         cannot be replayed against another hub, chain or campaign.
contract PlaceHub is ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant VERSION = "1.0.0";

    /// @notice If no root is posted this long after the snapshot, the creator can take everything back.
    uint64 public constant PUBLISH_GRACE = 72 hours;
    uint32 public constant MIN_CLAIM_DURATION = 1 days;
    uint32 public constant MAX_CLAIM_DURATION = 365 days;
    /// @notice How far ahead a snapshot can be scheduled.
    uint64 public constant MAX_SCHEDULE_AHEAD = 365 days;
    /// @notice Where burned leftovers go (many tokens refuse transfers to address(0)).
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    enum Kind {
        TokenHolders,
        NftHolders
    }

    /// @notice Stored lifecycle. `Open` covers everything from creation to finalization; `statusOf` splits it.
    enum Stage {
        None,
        Open,
        Cancelled,
        Refunded,
        Finalized
    }

    /// @notice Lifecycle as the UI shows it.
    enum Status {
        None,
        Scheduled, // before snapshotAt, can be cancelled
        Snapshotting, // after snapshotAt, waiting for the root
        Refundable, // no root PUBLISH_GRACE after snapshotAt: the creator can refund
        Live, // root posted, claims open
        Ended, // claimEnd passed, waiting for finalize
        Closed, // finalized
        Cancelled,
        Refunded
    }

    struct Campaign {
        address creator;
        uint64 snapshotAt;
        uint16 feeBps;
        Kind kind;
        bool burnLeftover;
        Stage stage;
        address target;
        uint64 claimEnd; // 0 until the first root is posted
        uint32 claimDuration;
        address rewardToken; // address(0) = ETH
        uint128 pool;
        uint128 fee;
        uint128 totalAllocated;
        uint128 claimed;
        bytes32 merkleRoot;
        bytes32 rulesHash;
        string rulesURI;
        string proofsURI;
        string metadataURI;
    }

    struct CreateParams {
        Kind kind;
        address target;
        address rewardToken;
        uint128 pool;
        uint64 snapshotAt;
        uint32 claimDuration;
        bool burnLeftover;
        bytes32 rulesHash;
        string rulesURI;
        string metadataURI;
    }

    PlaceConfig public immutable config;

    Campaign[] private _campaigns;
    mapping(uint256 id => mapping(address account => bool)) public isClaimed;

    event CampaignCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed target,
        Kind kind,
        address rewardToken,
        uint128 pool,
        uint128 fee,
        uint64 snapshotAt,
        uint32 claimDuration,
        bool burnLeftover
    );
    event CampaignRules(uint256 indexed id, bytes32 rulesHash, string rulesURI);
    event CampaignCancelled(uint256 indexed id, uint128 poolReturned, uint128 feeToTreasury);
    event RootPublished(
        uint256 indexed id, bytes32 merkleRoot, uint128 totalAllocated, uint64 claimEnd, string proofsURI
    );
    event Claimed(uint256 indexed id, address indexed account, uint256 amount, address indexed caller);
    event ClaimExtended(uint256 indexed id, uint64 claimEnd);
    event Refunded(uint256 indexed id, uint128 amount);
    event Finalized(uint256 indexed id, uint128 leftover, bool burned);
    event MetadataUpdated(uint256 indexed id, string metadataURI);

    error ZeroAddress();
    error Paused();
    error InvalidTarget();
    error InvalidPool();
    error InvalidSchedule();
    error InvalidClaimDuration();
    error InvalidRules();
    error WrongPayment();
    error UnsupportedToken();
    error NotFound(uint256 id);
    error NotCreator();
    error NotPublisher();
    error WrongStatus(uint256 id, Status status);
    error InvalidRoot();
    error AlreadyClaimed(uint256 id, address account);
    error InvalidProof();
    error AllocationExceeded(uint256 id);
    error InvalidClaimEnd();
    error LengthMismatch();
    error EthTransferFailed();

    constructor(PlaceConfig config_) {
        if (address(config_) == address(0)) revert ZeroAddress();
        config = config_;
    }

    // ─────────────────────────────── Creator ───────────────────────────────

    /// @notice Creates and funds a campaign in one transaction: pays `pool` plus the current fee for the
    ///         target, in the reward currency (ETH as msg.value, an ERC-20 through an allowance).
    function createCampaign(CreateParams calldata p) external payable nonReentrant returns (uint256 id) {
        if (config.newCampaignsPaused()) revert Paused();
        _validate(p);

        uint16 feeBps = config.campaignFeeBps(p.target);
        uint128 fee = uint128((uint256(p.pool) * feeBps) / 10_000);
        uint256 due = uint256(p.pool) + fee;
        // pool + fee must fit in uint128, or refundUnpublished could never pay it back.
        if (due > type(uint128).max) revert InvalidPool();

        if (p.rewardToken == address(0)) {
            if (msg.value != due) revert WrongPayment();
        } else {
            if (msg.value != 0) revert WrongPayment();
            IERC20 token = IERC20(p.rewardToken);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), due);
            // Rejects fee-on-transfer and similar tokens: the hub must hold exactly what it owes.
            if (token.balanceOf(address(this)) - before != due) revert UnsupportedToken();
        }

        id = _campaigns.length;
        Campaign storage c = _campaigns.push();
        c.creator = msg.sender;
        c.snapshotAt = p.snapshotAt;
        c.feeBps = feeBps;
        c.kind = p.kind;
        c.burnLeftover = p.burnLeftover;
        c.stage = Stage.Open;
        c.target = p.target;
        c.claimDuration = p.claimDuration;
        c.rewardToken = p.rewardToken;
        c.pool = p.pool;
        c.fee = fee;
        c.rulesHash = p.rulesHash;
        c.rulesURI = p.rulesURI;
        c.metadataURI = p.metadataURI;

        emit CampaignCreated(
            id, msg.sender, p.target, p.kind, p.rewardToken, p.pool, fee, p.snapshotAt, p.claimDuration, p.burnLeftover
        );
        emit CampaignRules(id, p.rulesHash, p.rulesURI);
        emit MetadataUpdated(id, p.metadataURI);
    }

    /// @notice Cancels before the snapshot. The pool goes back to the creator; the fee is kept.
    function cancel(uint256 id) external nonReentrant {
        Campaign storage c = _onlyCreator(id);
        Status s = _status(c);
        if (s != Status.Scheduled) revert WrongStatus(id, s);
        c.stage = Stage.Cancelled;
        _send(c.rewardToken, c.creator, c.pool);
        _send(c.rewardToken, config.treasury(), c.fee);
        emit CampaignCancelled(id, c.pool, c.fee);
    }

    /// @notice If the publisher posted no root within PUBLISH_GRACE after the snapshot, returns the pool and the
    ///         fee to the creator.
    function refundUnpublished(uint256 id) external nonReentrant {
        Campaign storage c = _onlyCreator(id);
        Status s = _status(c);
        if (s != Status.Refundable) revert WrongStatus(id, s);
        c.stage = Stage.Refunded;
        uint128 amount = c.pool + c.fee;
        _send(c.rewardToken, c.creator, amount);
        emit Refunded(id, amount);
    }

    /// @notice Moves the end of the claim window later. It can never be moved earlier.
    function extendClaim(uint256 id, uint64 newEnd) external {
        Campaign storage c = _onlyCreator(id);
        Status s = _status(c);
        if (s != Status.Live) revert WrongStatus(id, s);
        if (newEnd <= c.claimEnd || newEnd > block.timestamp + MAX_CLAIM_DURATION) revert InvalidClaimEnd();
        c.claimEnd = newEnd;
        emit ClaimExtended(id, newEnd);
    }

    /// @notice Updates the name, description and banner (IPFS). Events keep the history.
    function updateMetadata(uint256 id, string calldata metadataURI) external {
        Campaign storage c = _onlyCreator(id);
        c.metadataURI = metadataURI;
        emit MetadataUpdated(id, metadataURI);
    }

    // ─────────────────────────────── Publisher ───────────────────────────────

    /// @notice Posts the snapshot's Merkle root. Opens claims and pays the fee to the treasury the first time.
    ///         Before anyone has claimed, the publisher may post a corrected root; the claim window stays.
    function publishRoot(uint256 id, bytes32 root, uint128 totalAllocated, string calldata proofsURI)
        external
        nonReentrant
    {
        if (msg.sender != config.publisher()) revert NotPublisher();
        Campaign storage c = _get(id);
        Status s = _status(c);
        bool first = s == Status.Snapshotting || s == Status.Refundable;
        if (!first && !(s == Status.Live && c.claimed == 0)) revert WrongStatus(id, s);
        if (root == bytes32(0)) revert InvalidRoot();
        if (totalAllocated == 0 || totalAllocated > c.pool) revert AllocationExceeded(id);

        c.merkleRoot = root;
        c.totalAllocated = totalAllocated;
        c.proofsURI = proofsURI;
        if (first) {
            c.claimEnd = uint64(block.timestamp) + c.claimDuration;
            _send(c.rewardToken, config.treasury(), c.fee);
        }
        emit RootPublished(id, root, totalAllocated, c.claimEnd, proofsURI);
    }

    // ─────────────────────────────── Anyone ───────────────────────────────

    /// @notice Claims the caller's allocation.
    function claim(uint256 id, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _claim(msg.sender, id, amount, proof);
    }

    /// @notice Claims `account`'s allocation for it (agents, relayers). The reward always goes to `account`.
    function claimFor(address account, uint256 id, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _claim(account, id, amount, proof);
    }

    /// @notice Claims several campaigns for one account in one transaction ("Claim all").
    function claimMany(address account, uint256[] calldata ids, uint256[] calldata amounts, bytes32[][] calldata proofs)
        external
        nonReentrant
    {
        if (ids.length != amounts.length || ids.length != proofs.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            _claim(account, ids[i], amounts[i], proofs[i]);
        }
    }

    /// @notice After the claim window, sends the unclaimed rest to the creator or burns it, per the campaign.
    function finalize(uint256 id) external nonReentrant {
        Campaign storage c = _get(id);
        Status s = _status(c);
        if (s != Status.Ended) revert WrongStatus(id, s);
        c.stage = Stage.Finalized;
        uint128 leftover = c.pool - c.claimed;
        if (leftover != 0) _send(c.rewardToken, c.burnLeftover ? BURN_ADDRESS : c.creator, leftover);
        emit Finalized(id, leftover, c.burnLeftover);
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function getCampaign(uint256 id) external view returns (Campaign memory) {
        return _get(id);
    }

    function statusOf(uint256 id) external view returns (Status) {
        if (id >= _campaigns.length) return Status.None;
        return _status(_campaigns[id]);
    }

    /// @notice The Merkle leaf for an allocation (for off-chain tools to cross-check).
    function leaf(uint256 id, address account, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(address(this), block.chainid, id, account, amount))));
    }

    /// @notice Whether `account` could claim `amount` right now with this proof.
    function canClaim(address account, uint256 id, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        if (id >= _campaigns.length) return false;
        Campaign storage c = _campaigns[id];
        return _status(c) == Status.Live && !isClaimed[id][account] && uint256(c.claimed) + amount <= c.totalAllocated
            && MerkleProof.verifyCalldata(proof, c.merkleRoot, leaf(id, account, amount));
    }

    // ─────────────────────────────── Internal ───────────────────────────────

    function _claim(address account, uint256 id, uint256 amount, bytes32[] calldata proof) internal {
        if (account == address(0)) revert ZeroAddress();
        Campaign storage c = _get(id);
        Status s = _status(c);
        if (s != Status.Live) revert WrongStatus(id, s);
        if (isClaimed[id][account]) revert AlreadyClaimed(id, account);
        if (!MerkleProof.verifyCalldata(proof, c.merkleRoot, leaf(id, account, amount))) revert InvalidProof();
        uint256 claimedAfter = uint256(c.claimed) + amount;
        if (claimedAfter > c.totalAllocated) revert AllocationExceeded(id);

        isClaimed[id][account] = true;
        c.claimed = uint128(claimedAfter);
        _send(c.rewardToken, account, amount);
        emit Claimed(id, account, amount, msg.sender);
    }

    function _status(Campaign storage c) internal view returns (Status) {
        Stage stage = c.stage;
        if (stage == Stage.None) return Status.None;
        if (stage == Stage.Cancelled) return Status.Cancelled;
        if (stage == Stage.Refunded) return Status.Refunded;
        if (stage == Stage.Finalized) return Status.Closed;
        if (c.merkleRoot == bytes32(0)) {
            if (block.timestamp < c.snapshotAt) return Status.Scheduled;
            if (block.timestamp < uint256(c.snapshotAt) + PUBLISH_GRACE) return Status.Snapshotting;
            return Status.Refundable;
        }
        return block.timestamp < c.claimEnd ? Status.Live : Status.Ended;
    }

    function _validate(CreateParams calldata p) internal view {
        if (p.target == address(0) || p.target.code.length == 0) revert InvalidTarget();
        if (p.kind == Kind.NftHolders && !_isErc721(p.target)) revert InvalidTarget();
        if (p.rewardToken != address(0) && p.rewardToken.code.length == 0) revert UnsupportedToken();
        if (p.pool == 0) revert InvalidPool();
        if (p.snapshotAt <= block.timestamp || p.snapshotAt > block.timestamp + MAX_SCHEDULE_AHEAD) {
            revert InvalidSchedule();
        }
        if (p.claimDuration < MIN_CLAIM_DURATION || p.claimDuration > MAX_CLAIM_DURATION) {
            revert InvalidClaimDuration();
        }
        if (p.rulesHash == bytes32(0) || bytes(p.rulesURI).length == 0) revert InvalidRules();
    }

    function _isErc721(address target) internal view returns (bool) {
        try IERC165(target).supportsInterface{gas: 30_000}(ERC721_INTERFACE_ID) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _get(uint256 id) internal view returns (Campaign storage) {
        if (id >= _campaigns.length) revert NotFound(id);
        return _campaigns[id];
    }

    function _onlyCreator(uint256 id) internal view returns (Campaign storage c) {
        c = _get(id);
        if (msg.sender != c.creator) revert NotCreator();
    }
}
