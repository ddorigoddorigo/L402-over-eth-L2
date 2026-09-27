// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {L402Escrow} from "../src/L402Escrow.sol";

/// @dev Deploys the escrow.
///      forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script {
    function run() external returns (L402Escrow escrow) {
        address owner = vm.envAddress("ESCROW_OWNER");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", owner);
        uint256 feeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(0));
        // Guard against silent truncation: uint16(65536) would become 0.
        require(feeBps <= type(uint16).max, "PROTOCOL_FEE_BPS out of range");

        vm.startBroadcast();
        escrow = new L402Escrow(owner, feeRecipient, uint16(feeBps));
        vm.stopBroadcast();
    }
}
