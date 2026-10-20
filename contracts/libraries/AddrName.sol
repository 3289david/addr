// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Name normalization rules enforced on-chain: [a-z0-9-], 1..63 bytes,
/// no leading/trailing hyphen, no consecutive hyphens.
library AddrName {
    bytes32 internal constant ADDR_LABEL = keccak256("addr");

    function validLabel(bytes memory b) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0 || n > 63) return false;
        if (b[0] == 0x2d || b[n - 1] == 0x2d) return false;
        bool prevHyphen;
        for (uint256 i = 0; i < n; i++) {
            bytes1 c = b[i];
            bool hyphen = c == 0x2d;
            if (hyphen && prevHyphen) return false;
            prevHyphen = hyphen;
            if (!(hyphen || (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a))) return false;
        }
        return true;
    }

    /// @dev namehash of a full dotted name which must end in ".addr" and have >= 2 labels.
    function namehash(string memory name) internal pure returns (bytes32 node, bool ok) {
        bytes memory b = bytes(name);
        if (b.length == 0) return (bytes32(0), false);
        uint256 end = b.length;
        uint256 count;
        while (true) {
            uint256 start = end;
            while (start > 0 && b[start - 1] != 0x2e) start--;
            bytes memory label = new bytes(end - start);
            for (uint256 j = 0; j < label.length; j++) label[j] = b[start + j];
            if (!validLabel(label)) return (bytes32(0), false);
            bytes32 lh = keccak256(label);
            if (count == 0 && lh != ADDR_LABEL) return (bytes32(0), false);
            node = keccak256(abi.encodePacked(node, lh));
            count++;
            if (start == 0) break;
            end = start - 1;
        }
        return (node, count >= 2);
    }
}
