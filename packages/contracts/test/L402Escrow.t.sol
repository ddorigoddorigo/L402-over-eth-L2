// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {L402Escrow} from "../src/L402Escrow.sol";
import {MockBTC} from "../src/mocks/MockBTC.sol";
import {MockSmartAccount} from "../src/mocks/MockSmartAccount.sol";

/// @dev Needs forge-std (`npm i -D forge-std@github:foundry-rs/forge-std` or
///      `forge install foundry-rs/forge-std`, see remappings.txt).
///      The same scenarios also run without Foundry: see tools/escrow.test.mjs.
contract L402EscrowTest is Test {
    L402Escrow internal escrow;
    MockBTC internal token;

    uint256 internal payerPk = 0xA11CE;
    uint256 internal sessionPk = 0xB0B;
    uint256 internal outsiderPk = 0xBAD;

    address internal payer;
    address internal sessionKey;
    address internal outsider;
    address internal provider = address(0xBEEF);
    address internal owner = address(0xA0);
    address internal treasury = address(0xFEE);

    uint64 internal constant DURATION = 30 days;
    uint256 internal constant DEPOSIT = 1e8; // 1 cbBTC

    function setUp() public {
        payer = vm.addr(payerPk);
        sessionKey = vm.addr(sessionPk);
        outsider = vm.addr(outsiderPk);

        token = new MockBTC();
        escrow = new L402Escrow(owner, treasury, 0);

        token.mint(payer, 100e8);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    /* ------------------------------- helpers ------------------------------- */

    function _open(uint256 amount) internal returns (bytes32 channelId) {
        vm.prank(payer);
        channelId = escrow.openChannel(provider, address(token), amount, DURATION);
    }

    function _voucher(bytes32 channelId, uint256 cumulative, uint64 nonce)
        internal
        view
        returns (L402Escrow.Voucher memory)
    {
        return L402Escrow.Voucher({
            channelId: channelId,
            cumulativeAmount: cumulative,
            nonce: nonce,
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }

    /// @dev Makes an external call (`voucherDigest`): always compute signatures BEFORE
    ///      `vm.prank` / `vm.expectRevert`, which only apply to the very next call.
    function _sign(uint256 pk, L402Escrow.Voucher memory v) internal view returns (bytes memory) {
        bytes32 digest = escrow.voucherDigest(v);
        (uint8 sig, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sig);
    }

    /* -------------------------------- tests -------------------------------- */

    function test_OpenChannel_DepositsAndDerivesId() public {
        bytes32 channelId = _open(DEPOSIT);
        assertEq(channelId, escrow.computeChannelId(payer, provider, address(token)));

        L402Escrow.Channel memory ch = escrow.getChannel(channelId);
        assertEq(ch.deposited, DEPOSIT);
        assertEq(ch.claimed, 0);
        assertEq(ch.payer, payer);
        assertEq(escrow.available(channelId), DEPOSIT);
        assertEq(token.balanceOf(address(escrow)), DEPOSIT);
    }

    function test_Settle_PaysCumulativeDelta() public {
        bytes32 channelId = _open(DEPOSIT);

        L402Escrow.Voucher memory v1 = _voucher(channelId, 1e5, 1);
        bytes memory sigV1 = _sign(payerPk, v1);
        vm.prank(provider);
        escrow.settle(v1, sigV1, address(0));
        assertEq(token.balanceOf(provider), 1e5);

        L402Escrow.Voucher memory v2 = _voucher(channelId, 3e5, 2);
        bytes memory sigV2 = _sign(payerPk, v2);
        vm.prank(provider);
        escrow.settle(v2, sigV2, address(0));
        assertEq(token.balanceOf(provider), 3e5);
        assertEq(escrow.getChannel(channelId).claimed, 3e5);
    }

    function test_RevertWhen_VoucherReplayed() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 5e5, 1);
        bytes memory sig = _sign(payerPk, v);

        vm.prank(provider);
        escrow.settle(v, sig, address(0));

        vm.prank(provider);
        vm.expectRevert(L402Escrow.VoucherNotMonotonic.selector);
        escrow.settle(v, sig, address(0));
    }

    function test_RevertWhen_VoucherExceedsDeposit() public {
        bytes32 channelId = _open(1e6);
        L402Escrow.Voucher memory v = _voucher(channelId, 5e8, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.prank(provider);
        vm.expectRevert(L402Escrow.InsufficientChannelBalance.selector);
        escrow.settle(v, sig, address(0));
    }

    function test_RevertWhen_SignedByStranger() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 1e5, 1);
        bytes memory sig = _sign(outsiderPk, v);
        vm.prank(provider);
        vm.expectRevert(L402Escrow.InvalidSignature.selector);
        escrow.settle(v, sig, address(0));
    }

    function test_RevertWhen_VoucherExpired() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 1e5, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(provider);
        vm.expectRevert(L402Escrow.VoucherExpired.selector);
        escrow.settle(v, sig, address(0));
    }

    function test_RevertWhen_NotProvider() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 1e5, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.prank(outsider);
        vm.expectRevert(L402Escrow.NotProvider.selector);
        escrow.settle(v, sig, address(0));
    }

    function test_SessionKey_WithinCap() public {
        bytes32 channelId = _open(DEPOSIT);
        vm.prank(payer);
        escrow.authorizeSigner(sessionKey, 5e6, uint64(block.timestamp + 1 days));

        L402Escrow.Voucher memory v = _voucher(channelId, 4e6, 1);
        bytes memory sig = _sign(sessionPk, v);
        vm.prank(provider);
        escrow.settle(v, sig, sessionKey);
        assertEq(token.balanceOf(provider), 4e6);
    }

    function test_RevertWhen_SessionKeyOverCap() public {
        bytes32 channelId = _open(DEPOSIT);
        vm.prank(payer);
        escrow.authorizeSigner(sessionKey, 5e6, uint64(block.timestamp + 1 days));

        L402Escrow.Voucher memory v = _voucher(channelId, 6e6, 1);
        bytes memory sig = _sign(sessionPk, v);
        vm.prank(provider);
        vm.expectRevert(L402Escrow.DelegationCapExceeded.selector);
        escrow.settle(v, sig, sessionKey);
    }

    function test_SessionKeyRevocation_HonoursGracePeriod() public {
        bytes32 channelId = _open(DEPOSIT);
        vm.prank(payer);
        escrow.authorizeSigner(sessionKey, 5e6, uint64(block.timestamp + 30 days));

        L402Escrow.Voucher memory v = _voucher(channelId, 1e5, 1);
        v.validUntil = uint64(block.timestamp + 10 days);
        bytes memory sig = _sign(sessionPk, v);

        vm.prank(payer);
        escrow.revokeSigner(sessionKey);

        // Still settleable inside the grace period...
        vm.prank(provider);
        escrow.settle(v, sig, sessionKey);
        assertEq(token.balanceOf(provider), 1e5);

        // ...dead afterwards.
        vm.warp(block.timestamp + escrow.CLOSE_CHALLENGE_PERIOD() + 1);
        L402Escrow.Voucher memory later = _voucher(channelId, 2e5, 2);
        bytes memory sigLater = _sign(sessionPk, later);
        vm.prank(provider);
        vm.expectRevert(L402Escrow.DelegationExpired.selector);
        escrow.settle(later, sigLater, sessionKey);
    }

    function test_RevertWhen_LiveDelegationTightened() public {
        uint64 expiry = uint64(block.timestamp + 30 days);
        vm.startPrank(payer);
        escrow.authorizeSigner(sessionKey, 5e6, expiry);

        vm.expectRevert(L402Escrow.DelegationTightened.selector);
        escrow.authorizeSigner(sessionKey, 1e6, expiry);

        vm.expectRevert(L402Escrow.DelegationTightened.selector);
        escrow.authorizeSigner(sessionKey, 5e6, uint64(block.timestamp + 60));

        escrow.authorizeSigner(sessionKey, 6e6, expiry + 1 days); // widening is fine
        vm.stopPrank();
    }

    function test_WithdrawVoidsVouchersFromPreviousLife() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory stale = _voucher(channelId, 5e7, 1);
        stale.validUntil = uint64(block.timestamp + 60 days);
        bytes memory staleSig = _sign(payerPk, stale);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(payer);
        escrow.withdraw(channelId);
        assertEq(escrow.cumulativeFloor(channelId), DEPOSIT);

        _open(DEPOSIT); // same channelId, fresh funds

        vm.prank(provider);
        vm.expectRevert(L402Escrow.VoucherNotMonotonic.selector);
        escrow.settle(stale, staleSig, address(0));
    }

    function test_SmartAccount_ERC1271Voucher() public {
        MockSmartAccount account = new MockSmartAccount(payer);
        token.mint(address(account), DEPOSIT);

        address[] memory targets = new address[](2);
        bytes[] memory data = new bytes[](2);
        targets[0] = address(token);
        data[0] = abi.encodeCall(token.approve, (address(escrow), DEPOSIT));
        targets[1] = address(escrow);
        data[1] = abi.encodeCall(escrow.openChannel, (provider, address(token), DEPOSIT, DURATION));

        vm.prank(payer);
        account.executeBatch(targets, data);

        bytes32 channelId = escrow.computeChannelId(address(account), provider, address(token));
        assertEq(escrow.getChannel(channelId).deposited, DEPOSIT);

        L402Escrow.Voucher memory v = _voucher(channelId, 2e6, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.prank(provider);
        escrow.settle(v, sig, address(0));
        assertEq(token.balanceOf(provider), 2e6);
    }

    function test_SettleBatch() public {
        uint256 n = 3;
        L402Escrow.Voucher[] memory vouchers = new L402Escrow.Voucher[](n);
        bytes[] memory sigs = new bytes[](n);
        address[] memory signers = new address[](n);

        for (uint256 i; i < n; ++i) {
            uint256 pk = 0x1000 + i;
            address p = vm.addr(pk);
            token.mint(p, DEPOSIT);
            vm.startPrank(p);
            token.approve(address(escrow), DEPOSIT);
            bytes32 channelId = escrow.openChannel(provider, address(token), DEPOSIT, DURATION);
            vm.stopPrank();

            vouchers[i] = _voucher(channelId, 1e6, 1);
            sigs[i] = _sign(pk, vouchers[i]);
            signers[i] = address(0);
        }

        vm.prank(provider);
        escrow.settleBatch(vouchers, sigs, signers);
        assertEq(token.balanceOf(provider), 3e6);
    }

    function test_UnilateralClose_RespectsChallengePeriod() public {
        bytes32 channelId = _open(DEPOSIT);

        vm.prank(payer);
        vm.expectRevert(L402Escrow.CloseNotRequested.selector);
        escrow.withdraw(channelId);

        vm.prank(payer);
        escrow.requestClose(channelId);

        vm.prank(payer);
        vm.expectRevert(L402Escrow.CloseNotMatured.selector);
        escrow.withdraw(channelId);

        L402Escrow.Voucher memory v = _voucher(channelId, 1e7, 9);
        bytes memory sig = _sign(payerPk, v);
        vm.prank(provider);
        escrow.settle(v, sig, address(0));

        vm.warp(block.timestamp + escrow.CLOSE_CHALLENGE_PERIOD() + 1);
        uint256 before = token.balanceOf(payer);
        vm.prank(payer);
        escrow.withdraw(channelId);
        assertEq(token.balanceOf(payer) - before, DEPOSIT - 1e7);
    }

    function test_SettleAndClose() public {
        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 2e7, 4);
        uint256 before = token.balanceOf(payer);

        bytes memory sig = _sign(payerPk, v);

        vm.prank(provider);
        escrow.settleAndClose(v, sig, address(0));

        assertEq(token.balanceOf(provider), 2e7);
        assertEq(token.balanceOf(payer) - before, DEPOSIT - 2e7);
        assertEq(escrow.available(channelId), 0);
    }

    function test_ProtocolFee() public {
        vm.prank(owner);
        escrow.setProtocolFee(100, treasury); // 1%

        bytes32 channelId = _open(DEPOSIT);
        L402Escrow.Voucher memory v = _voucher(channelId, 1e7, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.prank(provider);
        escrow.settle(v, sig, address(0));

        assertEq(token.balanceOf(treasury), 1e7 / 100);
        assertEq(token.balanceOf(provider), 1e7 - 1e7 / 100);
    }

    function testFuzz_CumulativeVouchersNeverOverpay(uint96[8] memory amounts) public {
        bytes32 channelId = _open(DEPOSIT);
        uint256 cumulative;
        uint64 nonce;

        for (uint256 i; i < amounts.length; ++i) {
            uint256 next = cumulative + (uint256(amounts[i]) % 1e6);
            if (next <= cumulative || next > DEPOSIT) continue;
            cumulative = next;
            L402Escrow.Voucher memory v = _voucher(channelId, cumulative, ++nonce);
            bytes memory sig = _sign(payerPk, v);
            vm.prank(provider);
            escrow.settle(v, sig, address(0));
        }

        assertEq(token.balanceOf(provider), cumulative);
        assertEq(escrow.available(channelId), DEPOSIT - cumulative);
        assertEq(token.balanceOf(address(escrow)), DEPOSIT - cumulative);
    }
}
