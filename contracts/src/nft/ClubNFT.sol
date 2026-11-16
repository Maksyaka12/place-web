// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Uniswap V3 SwapRouter02 (Base: 0x2626664c2603336E57B271c5C0b26F421741e481).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function WETH9() external view returns (address);
}

/// @title ClubNFT
/// @notice An NFT collection deployed through Place's NftFactory as an EIP-1167 clone:
///         - the mint price is set and enforced by the contract, so a mint can never be paid with dust;
///         - the buyback swap needs a non-zero minimum output and a deadline, set by the owner from a quote;
///         - no hardcoded token or router: everything is a parameter at creation.
/// @dev    Revenue split, fixed at creation: `burnBps` of every mint goes to buyback-and-burn of `burnToken`,
///         the rest to the creator's `payout`. When people pay in `burnToken` itself, its share is burned at
///         once; otherwise it is set aside and only the swap can spend it.
contract ClubNFT is ERC721, ERC2981, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant VERSION = "1.0.0";
    uint96 public constant MAX_ROYALTY_BPS = 1_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct InitParams {
        string name;
        string symbol;
        uint32 maxSupply;
        uint32 maxPerWallet; // 0 = no limit
        address paymentToken; // address(0) = ETH
        uint128 price; // per NFT, in paymentToken
        uint64 mintStart; // unix time
        address payout; // receives the creator's share
        uint16 burnBps; // share of revenue for buyback-and-burn
        address burnToken; // token bought back and burned; required when burnBps > 0
        address swapRouter; // SwapRouter02; required when burnBps > 0 and paymentToken != burnToken
        uint24 swapPoolFee; // Uniswap V3 pool fee tier for paymentToken → burnToken
        string baseURI;
        string contractURI;
        address royaltyReceiver;
        uint96 royaltyBps;
    }

    bool private _initialized;
    string private _name;
    string private _symbol;

    // Fixed at creation.
    uint32 public maxSupply;
    uint32 public maxPerWallet;
    address public paymentToken;
    address public payout;
    uint16 public burnBps;
    address public burnToken;
    address public swapRouter;
    uint24 public swapPoolFee;

    // Changeable until the first mint.
    uint128 public price;
    uint64 public mintStart;

    // Changeable until freezeMetadata.
    string public baseURI;
    string public contractURI;
    bool public metadataFrozen;

    uint32 public totalMinted;
    mapping(address => uint32) public mintedBy;

    /// @notice Revenue waiting for withdrawPayout, in paymentToken.
    uint256 public payoutBalance;
    /// @notice Revenue set aside for buybackAndBurn, in paymentToken.
    uint256 public buybackBalance;

    event Initialized(address indexed owner, address indexed factory);
    event Minted(address indexed to, uint256 firstTokenId, uint256 quantity, uint256 paid);
    event OwnerMinted(address indexed to, uint256 firstTokenId, uint256 quantity);
    event PriceSet(uint128 price);
    event MintStartSet(uint64 mintStart);
    event BaseURISet(string baseURI);
    event ContractURISet(string contractURI);
    event MetadataFrozen();
    event RoyaltySet(address receiver, uint96 bps);
    event Burned(address indexed token, uint256 amount);
    event BuybackExecuted(uint256 amountIn, uint256 amountOut);
    event PayoutWithdrawn(address indexed to, uint256 amount);

    error AlreadyInitialized();
    error InvalidParams();
    error MintNotStarted();
    error SoldOut();
    error WalletLimit();
    error WrongPayment();
    error MintStarted();
    error Frozen();
    error RoyaltyTooHigh();
    error Expired();
    error NothingToDo();
    error EthTransferFailed();

    /// @dev The implementation itself is locked; only clones are initialized.
    constructor() ERC721("", "") Ownable(msg.sender) {
        _initialized = true;
    }

    /// @notice Called once by the factory right after cloning.
    function initialize(InitParams calldata p, address owner_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (owner_ == address(0) || p.payout == address(0) || p.maxSupply == 0) revert InvalidParams();
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.paymentToken != address(0) && p.paymentToken.code.length == 0) revert InvalidParams();
        if (p.burnBps > 10_000) revert InvalidParams();
        if (p.burnBps > 0) {
            if (p.burnToken == address(0) || p.burnToken.code.length == 0) revert InvalidParams();
            if (p.paymentToken != p.burnToken && p.swapRouter == address(0)) revert InvalidParams();
        }
        if (p.royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();

        _transferOwnership(owner_);
        _name = p.name;
        _symbol = p.symbol;
        maxSupply = p.maxSupply;
        maxPerWallet = p.maxPerWallet;
        paymentToken = p.paymentToken;
        payout = p.payout;
        burnBps = p.burnBps;
        burnToken = p.burnToken;
        swapRouter = p.swapRouter;
        swapPoolFee = p.swapPoolFee;
        price = p.price;
        mintStart = p.mintStart;
        baseURI = p.baseURI;
        contractURI = p.contractURI;
        if (p.royaltyReceiver != address(0) && p.royaltyBps > 0) _setDefaultRoyalty(p.royaltyReceiver, p.royaltyBps);

        emit Initialized(owner_, msg.sender);
    }

    // ─────────────────────────────── Mint ───────────────────────────────

    /// @notice Mints `quantity` NFTs to the caller for exactly price × quantity (ETH as msg.value, an ERC-20
    ///         through an allowance).
    function mint(uint256 quantity) external payable nonReentrant {
        if (block.timestamp < mintStart) revert MintNotStarted();
        if (quantity == 0) revert InvalidParams();
        uint256 cost = uint256(price) * quantity;

        if (paymentToken == address(0)) {
            if (msg.value != cost) revert WrongPayment();
        } else {
            if (msg.value != 0) revert WrongPayment();
            if (cost != 0) {
                IERC20 token = IERC20(paymentToken);
                uint256 before = token.balanceOf(address(this));
                token.safeTransferFrom(msg.sender, address(this), cost);
                if (token.balanceOf(address(this)) - before != cost) revert WrongPayment();
            }
        }

        uint32 walletAfter = mintedBy[msg.sender] + uint32(quantity);
        if (maxPerWallet != 0 && walletAfter > maxPerWallet) revert WalletLimit();
        mintedBy[msg.sender] = walletAfter;

        uint256 first = _mintMany(msg.sender, quantity);
        _split(cost);
        emit Minted(msg.sender, first, quantity, cost);
    }

    /// @notice The owner mints for free (airdrops, reserves). Respects maxSupply, not the wallet limit.
    function ownerMint(address to, uint256 quantity) external onlyOwner nonReentrant {
        if (quantity == 0) revert InvalidParams();
        uint256 first = _mintMany(to, quantity);
        emit OwnerMinted(to, first, quantity);
    }

    // ─────────────────────────────── Revenue ───────────────────────────────

    /// @notice Sends the creator's share to `payout`. Anyone can trigger it; the destination is fixed.
    function withdrawPayout() external nonReentrant {
        uint256 amount = payoutBalance;
        if (amount == 0) revert NothingToDo();
        payoutBalance = 0;
        _send(paymentToken, payout, amount);
        emit PayoutWithdrawn(payout, amount);
    }

    /// @notice Swaps `amountIn` of the set-aside revenue to `burnToken` and burns all of it. The owner passes
    ///         a minimum output from a fresh quote, which protects the swap from sandwiching.
    function buybackAndBurn(uint256 amountIn, uint256 minOut, uint256 deadline) external onlyOwner nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0 || amountIn > buybackBalance || minOut == 0) revert InvalidParams();
        buybackBalance -= amountIn;

        ISwapRouter02 router = ISwapRouter02(swapRouter);
        IERC20 out = IERC20(burnToken);
        uint256 before = out.balanceOf(address(this));
        ISwapRouter02.ExactInputSingleParams memory sp = ISwapRouter02.ExactInputSingleParams({
            tokenIn: paymentToken == address(0) ? router.WETH9() : paymentToken,
            tokenOut: burnToken,
            fee: swapPoolFee,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
        if (paymentToken == address(0)) {
            router.exactInputSingle{value: amountIn}(sp);
        } else {
            IERC20(paymentToken).forceApprove(address(router), amountIn);
            router.exactInputSingle(sp);
        }
        uint256 received = out.balanceOf(address(this)) - before;
        if (received < minOut) revert WrongPayment();
        out.safeTransfer(BURN_ADDRESS, received);
        emit BuybackExecuted(amountIn, received);
        emit Burned(burnToken, received);
    }

    // ─────────────────────────────── Owner settings ───────────────────────────────

    function setPrice(uint128 newPrice) external onlyOwner {
        if (totalMinted != 0) revert MintStarted();
        price = newPrice;
        emit PriceSet(newPrice);
    }

    function setMintStart(uint64 newStart) external onlyOwner {
        if (totalMinted != 0) revert MintStarted();
        mintStart = newStart;
        emit MintStartSet(newStart);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        baseURI = uri;
        emit BaseURISet(uri);
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    function setContractURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        contractURI = uri;
        emit ContractURISet(uri);
    }

    /// @notice Locks baseURI and contractURI forever.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (receiver == address(0) || bps == 0) _deleteDefaultRoyalty();
        else _setDefaultRoyalty(receiver, bps);
        emit RoyaltySet(receiver, bps);
    }

    // ─────────────────────────────── Views ───────────────────────────────

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == 0x49064906 // ERC-4906 metadata updates
            || super.supportsInterface(interfaceId);
    }

    /// @dev ERC-4906.
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    // ─────────────────────────────── Internal ───────────────────────────────

    function _mintMany(address to, uint256 quantity) internal returns (uint256 first) {
        uint256 total = uint256(totalMinted) + quantity;
        if (total > maxSupply) revert SoldOut();
        first = uint256(totalMinted) + 1;
        totalMinted = uint32(total);
        for (uint256 i; i < quantity; ++i) {
            _safeMint(to, first + i);
        }
    }

    function _split(uint256 cost) internal {
        if (cost == 0) return;
        uint256 burnPart = (cost * burnBps) / 10_000;
        payoutBalance += cost - burnPart;
        if (burnPart == 0) return;
        if (paymentToken == burnToken) {
            IERC20(burnToken).safeTransfer(BURN_ADDRESS, burnPart);
            emit Burned(burnToken, burnPart);
        } else {
            buybackBalance += burnPart;
        }
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
