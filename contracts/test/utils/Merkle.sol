// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Sorted-pair Merkle tree, the same shape OpenZeppelin's MerkleProof verifies. An odd node at the end
///      of a level is carried up unchanged, so it simply has no sibling at that level.
library Merkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = _copy(leaves);
        uint256 n = level.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                level[i] = 2 * i + 1 < n ? hashPair(level[2 * i], level[2 * i + 1]) : level[2 * i];
            }
            n = m;
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        bytes32[] memory level = _copy(leaves);
        bytes32[] memory tmp = new bytes32[](64);
        uint256 len;
        uint256 n = level.length;
        while (n > 1) {
            uint256 sib = index ^ 1;
            if (sib < n) tmp[len++] = level[sib];
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                level[i] = 2 * i + 1 < n ? hashPair(level[2 * i], level[2 * i + 1]) : level[2 * i];
            }
            index /= 2;
            n = m;
        }
        bytes32[] memory out = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            out[i] = tmp[i];
        }
        return out;
    }

    function _copy(bytes32[] memory a) private pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }
}
