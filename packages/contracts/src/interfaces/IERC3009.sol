// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-3009 — Transfer With Authorization.
/// @dev    `receiveWithAuthorization` is the safe variant: only `to` can submit it,
///         so the signature cannot be front-run.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
