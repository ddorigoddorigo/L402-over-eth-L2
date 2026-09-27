// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-2612 — ERC-20 approval via signature.
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    function nonces(address owner) external view returns (uint256);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
