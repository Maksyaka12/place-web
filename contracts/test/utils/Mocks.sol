// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ISwapRouter02} from "../../src/nft/ClubNFT.sol";

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Takes 1% of every transfer, like a taxed meme token.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Tax", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0xbeef), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock NFT", "MNFT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev Refuses ETH, to check that a failing ETH transfer reverts instead of silently losing funds.
contract RejectsEth {
    receive() external payable {
        revert("no ETH");
    }
}

/// @dev Fake SwapRouter02: pays out `rate` burn tokens per input unit (scaled by 1e18), minus `shortfall`.
contract MockSwapRouter is ISwapRouter02 {
    MockERC20 public immutable out;
    address public immutable weth;
    uint256 public rate = 2e18;
    uint256 public shortfall;
    ExactInputSingleParams public last;

    constructor(MockERC20 out_, address weth_) {
        out = out_;
        weth = weth_;
    }

    function setShortfall(uint256 s) external {
        shortfall = s;
    }

    function WETH9() external view returns (address) {
        return weth;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        last = p;
        if (p.tokenIn == weth) {
            require(msg.value == p.amountIn, "value");
        } else {
            ERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        }
        amountOut = (p.amountIn * rate) / 1e18 - shortfall;
        // A real router enforces this; the mock skips it so ClubNFT's own check can be tested.
        out.mint(p.recipient, amountOut);
    }
}
