// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Test double: accepts or rejects ERC-721 safe transfers depending on `accepts`.
contract MockERC721Receiver is IERC721Receiver {
    bool public accepts;

    constructor(bool accepts_) {
        accepts = accepts_;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!accepts) revert("rejected");
        return IERC721Receiver.onERC721Received.selector;
    }
}
