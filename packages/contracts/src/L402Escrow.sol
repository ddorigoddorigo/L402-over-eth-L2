// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IERC2612} from "./interfaces/IERC2612.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title L402Escrow — unidirectional payment channels for the L402-EL2 protocol
/// @notice A payer (a user, or an AI agent through an ERC-4337 account) deposits an
///         ERC-20 token (e.g. cbBTC on Base) into a channel towards a provider (an MCP
///         server). Every API call is paid off-chain with an EIP-712 voucher carrying a
///         CUMULATIVE amount, signed by the payer or by a delegated session key. The
///         provider settles on-chain whenever it wants by presenting only the latest
///         voucher it received.
/// @dev    Core invariants:
///         - `claimed` and `refunded` only ever grow and are never reset.
///         - `deposited >= claimed + refunded` at all times.
///         - The cumulative counter of a channel starts at `cumulativeFloor = claimed +
///           refunded`: a voucher is settleable only if its amount is above the floor, and
///           it pays out `cumulativeAmount - floor`. Because refunds raise the floor too,
///           every voucher signed before a withdrawal becomes useless forever, even if the
///           same channel is later reopened with fresh funds.
///         - Anything a payer can do to invalidate vouchers it already handed out (closing
///           the channel, revoking or tightening a session key) only takes effect after
///           `CLOSE_CHALLENGE_PERIOD`, so the provider always has time to settle.
contract L402Escrow is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* -------------------------------------------------------------------------- */
    /*                                    TYPES                                   */
    /* -------------------------------------------------------------------------- */

    struct Channel {
        address payer;
        address provider;
        address token;
        uint256 deposited; // lifetime total deposited
        uint256 claimed; // lifetime total settled by the provider (gross, fee included)
        uint256 refunded; // lifetime total returned to the payer
        uint64 expiry; // after this instant the payer can withdraw without waiting
        uint64 closeRequestedAt; // != 0 => a unilateral close is in progress
        bool exists;
    }

    /// @notice Off-chain voucher: authorizes the provider to collect up to
    ///         `cumulativeAmount` in total from the channel.
    struct Voucher {
        bytes32 channelId;
        uint256 cumulativeAmount;
        uint64 nonce;
        uint64 validUntil;
    }

    /// @notice Signing delegation (session key). Lets an AI agent sign vouchers up to
    ///         `maxCumulative` without holding the payer's key.
    struct Delegation {
        uint256 maxCumulative;
        uint64 validUntil;
        bool active;
    }

    /* -------------------------------------------------------------------------- */
    /*                                  CONSTANTS                                 */
    /* -------------------------------------------------------------------------- */

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount,uint64 nonce,uint64 validUntil)");

    bytes32 public constant DELEGATION_TYPEHASH =
        keccak256("Delegation(address payer,address signer,uint256 maxCumulative,uint64 validUntil,uint256 nonce)");

    /// @notice Grace period the provider gets to settle before a payer action takes
    ///         effect: a unilateral close, a session key revocation or a session key
    ///         whose cap/expiry is being tightened.
    uint64 public constant CLOSE_CHALLENGE_PERIOD = 24 hours;

    /// @notice Minimum / maximum channel lifetime.
    uint64 public constant MIN_CHANNEL_DURATION = 1 hours;
    uint64 public constant MAX_CHANNEL_DURATION = 365 days;

    /// @notice Hard cap on the protocol fee (5%).
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 500;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /* -------------------------------------------------------------------------- */
    /*                                    STATE                                   */
    /* -------------------------------------------------------------------------- */

    mapping(bytes32 channelId => Channel) private _channels;

    /// @notice payer => session key => delegation
    mapping(address payer => mapping(address signer => Delegation)) public delegations;

    /// @notice Next expected nonce for delegations signed off-chain (`authorizeSignerWithSig`).
    mapping(address payer => uint256) public delegationNonces;

    uint16 public protocolFeeBps;
    address public feeRecipient;

    /* -------------------------------------------------------------------------- */
    /*                                   EVENTS                                   */
    /* -------------------------------------------------------------------------- */

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed payer,
        address indexed provider,
        address token,
        uint256 amount,
        uint64 expiry
    );
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 newDeposited, uint64 expiry);
    event VoucherSettled(
        bytes32 indexed channelId,
        address indexed provider,
        uint256 cumulativeAmount,
        uint256 delta,
        uint256 fee,
        uint64 nonce
    );
    event CloseRequested(bytes32 indexed channelId, address indexed by, uint64 claimableAt);
    event CloseCancelled(bytes32 indexed channelId);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed payer, uint256 amount);
    event SignerAuthorized(address indexed payer, address indexed signer, uint256 maxCumulative, uint64 validUntil);
    /// @param effectiveAt Moment from which vouchers signed by `signer` stop being settleable.
    event SignerRevoked(address indexed payer, address indexed signer, uint64 effectiveAt);
    event DelegationNonceInvalidated(address indexed payer, uint256 newNonce);
    event ProtocolFeeUpdated(uint16 bps, address recipient);

    /* -------------------------------------------------------------------------- */
    /*                                   ERRORS                                   */
    /* -------------------------------------------------------------------------- */

    error ChannelNotFound();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidAddress();
    error NotPayer();
    error NotProvider();
    error VoucherExpired();
    error VoucherNotMonotonic();
    error InsufficientChannelBalance();
    error InvalidSignature();
    error DelegationInactive();
    error DelegationExpired();
    error DelegationCapExceeded();
    /// @dev A live delegation can only be widened immediately; narrowing it must go
    ///      through `revokeSigner`, which honours the grace period.
    error DelegationTightened();
    error CloseNotRequested();
    error CloseNotMatured();
    error FeeTooHigh();
    error LengthMismatch();
    error NothingToWithdraw();

    /* -------------------------------------------------------------------------- */
    /*                                 CONSTRUCTOR                                */
    /* -------------------------------------------------------------------------- */

    constructor(address initialOwner, address initialFeeRecipient, uint16 initialFeeBps)
        EIP712("L402-EL2", "1")
        Ownable(initialOwner)
    {
        _setProtocolFee(initialFeeBps, initialFeeRecipient);
    }

    /* -------------------------------------------------------------------------- */
    /*                               VIEWS / HELPERS                              */
    /* -------------------------------------------------------------------------- */

    /// @notice Deterministic channel id. Clients compute it offline, without any RPC call.
    function computeChannelId(address payer, address provider, address token) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, provider, token));
    }

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    /// @notice ERC-3009 nonce bound to the channel parameters. It prevents a
    ///         `receiveWithAuthorization` signature intercepted in the mempool from being
    ///         used to open a channel towards a provider the payer did not choose.
    function computeAuthNonce(
        address payer,
        address provider,
        address token,
        uint256 amount,
        uint64 duration,
        uint256 validBefore
    ) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), payer, provider, token, amount, duration, validBefore));
    }

    /// @notice Funds still spendable on the channel (neither settled nor refunded).
    function available(bytes32 channelId) public view returns (uint256) {
        Channel storage ch = _channels[channelId];
        return ch.deposited - ch.claimed - ch.refunded;
    }

    /// @notice Where the cumulative counter of the channel currently stands: the next
    ///         voucher must be strictly above this value. Clients sign from here.
    function cumulativeFloor(bytes32 channelId) public view returns (uint256) {
        Channel storage ch = _channels[channelId];
        return ch.claimed + ch.refunded;
    }

    /// @notice EIP-712 digest of a voucher, handy for clients that sign or verify.
    function voucherDigest(Voucher calldata voucher) public view returns (bytes32) {
        return _hashVoucher(voucher);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _hashVoucher(Voucher calldata voucher) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH, voucher.channelId, voucher.cumulativeAmount, voucher.nonce, voucher.validUntil
                )
            )
        );
    }

    /// @dev `min(current, now + CLOSE_CHALLENGE_PERIOD)`: the earliest moment a payer
    ///      action is allowed to invalidate vouchers that are already in circulation.
    function _earliestAllowedDeadline(uint64 current) internal view returns (uint64) {
        uint64 graceEnd = uint64(block.timestamp) + CLOSE_CHALLENGE_PERIOD;
        return current < graceEnd ? current : graceEnd;
    }

    /* -------------------------------------------------------------------------- */
    /*                               OPENING CHANNELS                             */
    /* -------------------------------------------------------------------------- */

    /// @notice Opens (or tops up) a channel, pulling the tokens with `transferFrom`.
    /// @dev    Needs a prior `approve`, or an ERC-4337 batch that runs
    ///         `approve` + `openChannel` atomically.
    function openChannel(address provider, address token, uint256 amount, uint64 duration)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 channelId)
    {
        channelId = _openOrTopUp(msg.sender, provider, token, amount, duration);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Single-transaction opening for tokens that support EIP-2612 (`permit`).
    function openChannelWithPermit(
        address provider,
        address token,
        uint256 amount,
        uint64 duration,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant returns (bytes32 channelId) {
        // `try` because a permit that was already consumed (benign front-running) must
        // not make the deposit fail: `transferFrom` checks the allowance anyway.
        try IERC2612(token).permit(msg.sender, address(this), permitValue, permitDeadline, v, r, s) {} catch {}
        channelId = _openOrTopUp(msg.sender, provider, token, amount, duration);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Gasless-friendly opening for tokens that support EIP-3009 (`receiveWithAuthorization`).
    /// @dev    A relayer can submit it on behalf of the payer. The ERC-3009 nonce is bound
    ///         to the channel parameters (`computeAuthNonce`), so a front-runner that
    ///         intercepts the signature cannot redirect it to a different provider.
    function openChannelWithAuthorization(
        address payer,
        address provider,
        address token,
        uint256 amount,
        uint64 duration,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authNonce,
        bytes calldata authSignature
    ) external whenNotPaused nonReentrant returns (bytes32 channelId) {
        if (authNonce != computeAuthNonce(payer, provider, token, amount, duration, validBefore)) {
            revert InvalidSignature();
        }
        channelId = _openOrTopUp(payer, provider, token, amount, duration);
        IERC3009(token).receiveWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, authNonce, authSignature
        );
    }

    /// @notice Adds funds to an existing channel and optionally extends its expiry.
    /// @param newExpiry New absolute expiry. Ignored if not later than the current one.
    function topUp(bytes32 channelId, uint256 amount, uint64 newExpiry) external whenNotPaused nonReentrant {
        Channel storage ch = _channels[channelId];
        if (!ch.exists) revert ChannelNotFound();
        if (msg.sender != ch.payer) revert NotPayer();
        if (amount == 0) revert InvalidAmount();

        ch.deposited += amount;
        if (newExpiry > ch.expiry) {
            if (newExpiry < block.timestamp + MIN_CHANNEL_DURATION) revert InvalidDuration();
            if (newExpiry > block.timestamp + MAX_CHANNEL_DURATION) revert InvalidDuration();
            ch.expiry = newExpiry;
        }
        _cancelPendingClose(ch, channelId);

        IERC20(ch.token).safeTransferFrom(msg.sender, address(this), amount);
        emit ChannelToppedUp(channelId, amount, ch.deposited, ch.expiry);
    }

    function _openOrTopUp(address payer, address provider, address token, uint256 amount, uint64 duration)
        internal
        returns (bytes32 channelId)
    {
        if (provider == address(0) || token == address(0) || payer == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (duration < MIN_CHANNEL_DURATION || duration > MAX_CHANNEL_DURATION) revert InvalidDuration();

        channelId = computeChannelId(payer, provider, token);
        Channel storage ch = _channels[channelId];
        uint64 newExpiry = uint64(block.timestamp) + duration;

        if (!ch.exists) {
            ch.payer = payer;
            ch.provider = provider;
            ch.token = token;
            ch.exists = true;
        }
        ch.deposited += amount;
        if (newExpiry > ch.expiry) ch.expiry = newExpiry;
        _cancelPendingClose(ch, channelId);

        emit ChannelOpened(channelId, payer, provider, token, amount, ch.expiry);
    }

    /// @dev A new deposit means the payer wants to keep using the channel.
    function _cancelPendingClose(Channel storage ch, bytes32 channelId) internal {
        if (ch.closeRequestedAt != 0) {
            ch.closeRequestedAt = 0;
            emit CloseCancelled(channelId);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                         SIGNING DELEGATION (SESSION KEY)                    */
    /* -------------------------------------------------------------------------- */

    /// @notice Authorizes a session key to sign vouchers on behalf of `msg.sender`, up to
    ///         `maxCumulative` and not after `validUntil`.
    /// @dev    Callable from an ERC-4337 smart account: it is the on-chain form of
    ///         "I allow the agent to spend up to X". A live delegation can be widened
    ///         (higher cap, later expiry) but never narrowed here — see `revokeSigner`.
    /// @dev    The cap is checked against the voucher's cumulative amount, so it bounds
    ///         what the key can authorize on EACH channel of the payer.
    function authorizeSigner(address signer, uint256 maxCumulative, uint64 validUntil) external {
        _authorizeSigner(msg.sender, signer, maxCumulative, validUntil);
    }

    /// @notice Same as `authorizeSigner`, but authorized by the payer's EIP-712 signature
    ///         (the human signs, the agent or a relayer pays the gas).
    function authorizeSignerWithSig(
        address payer,
        address signer,
        uint256 maxCumulative,
        uint64 validUntil,
        uint256 nonce,
        bytes calldata signature
    ) external {
        if (nonce != delegationNonces[payer]) revert InvalidSignature();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(DELEGATION_TYPEHASH, payer, signer, maxCumulative, validUntil, nonce))
        );
        if (!SignatureChecker.isValidSignatureNow(payer, digest, signature)) revert InvalidSignature();
        delegationNonces[payer] = nonce + 1;
        _authorizeSigner(payer, signer, maxCumulative, validUntil);
    }

    /// @notice Invalidates every delegation the caller signed off-chain but nobody has
    ///         submitted yet (they all use the current nonce).
    function invalidateDelegationNonce() external {
        uint256 next = ++delegationNonces[msg.sender];
        emit DelegationNonceInvalidated(msg.sender, next);
    }

    /// @notice Revokes a session key.
    /// @dev    The revocation takes effect after `CLOSE_CHALLENGE_PERIOD` (or at the
    ///         delegation's own expiry, if earlier). Revoking instantly would let a payer
    ///         consume a service with session-key vouchers and then make them
    ///         unsettleable before the provider has a chance to collect.
    function revokeSigner(address signer) external {
        Delegation storage delegation = delegations[msg.sender][signer];
        if (!delegation.active) revert DelegationInactive();
        delegation.validUntil = _earliestAllowedDeadline(delegation.validUntil);
        emit SignerRevoked(msg.sender, signer, delegation.validUntil);
    }

    function _authorizeSigner(address payer, address signer, uint256 maxCumulative, uint64 validUntil) internal {
        if (signer == address(0)) revert InvalidAddress();
        if (validUntil <= block.timestamp) revert DelegationExpired();

        Delegation storage current = delegations[payer][signer];
        bool isLive = current.active && current.validUntil >= block.timestamp;
        if (isLive) {
            // Vouchers signed under the current terms may still be waiting to be settled.
            if (maxCumulative < current.maxCumulative) revert DelegationTightened();
            if (validUntil < _earliestAllowedDeadline(current.validUntil)) revert DelegationTightened();
        }

        current.maxCumulative = maxCumulative;
        current.validUntil = validUntil;
        current.active = true;
        emit SignerAuthorized(payer, signer, maxCumulative, validUntil);
    }

    /* -------------------------------------------------------------------------- */
    /*                                  SETTLEMENT                                */
    /* -------------------------------------------------------------------------- */

    /// @notice The provider collects by presenting the latest voucher it received.
    /// @param signer Address that signed the voucher: the payer or a delegated session
    ///               key. Pass `address(0)` for "signed by the payer".
    function settle(Voucher calldata voucher, bytes calldata signature, address signer)
        external
        nonReentrant
        returns (uint256 paid)
    {
        Channel storage ch = _providerChannel(voucher.channelId);
        paid = _settle(ch, voucher, signature, signer);
    }

    /// @notice Batch settlement: one L2 transaction for N channels/payers.
    /// @dev    All-or-nothing: a single invalid voucher reverts the whole batch. The
    ///         off-chain settler simulates first and drops vouchers that would fail.
    function settleBatch(Voucher[] calldata vouchers, bytes[] calldata signatures, address[] calldata signers)
        external
        nonReentrant
        returns (uint256 totalPaid)
    {
        uint256 count = vouchers.length;
        if (count != signatures.length || count != signers.length) revert LengthMismatch();
        for (uint256 i; i < count; ++i) {
            Channel storage ch = _providerChannel(vouchers[i].channelId);
            totalPaid += _settle(ch, vouchers[i], signatures[i], signers[i]);
        }
    }

    /// @notice Cooperative close: the provider settles the latest voucher and returns the
    ///         remainder to the payer immediately, with no waiting period.
    function settleAndClose(Voucher calldata voucher, bytes calldata signature, address signer)
        external
        nonReentrant
        returns (uint256 paid, uint256 refund)
    {
        bytes32 channelId = voucher.channelId;
        Channel storage ch = _providerChannel(channelId);

        paid = _settle(ch, voucher, signature, signer);

        refund = available(channelId);
        if (refund != 0) {
            ch.refunded += refund;
            IERC20(ch.token).safeTransfer(ch.payer, refund);
            emit ChannelWithdrawn(channelId, ch.payer, refund);
        }
        ch.closeRequestedAt = 0;
        ch.expiry = uint64(block.timestamp);
    }

    /// @dev Loads a channel and checks that the caller is its provider.
    function _providerChannel(bytes32 channelId) internal view returns (Channel storage ch) {
        ch = _channels[channelId];
        if (!ch.exists) revert ChannelNotFound();
        if (msg.sender != ch.provider) revert NotProvider();
    }

    /// @return net Amount transferred to the provider (delta minus protocol fee).
    function _settle(Channel storage ch, Voucher calldata voucher, bytes calldata signature, address signer)
        internal
        returns (uint256 net)
    {
        if (voucher.validUntil < block.timestamp) revert VoucherExpired();
        uint256 floor = ch.claimed + ch.refunded;
        if (voucher.cumulativeAmount <= floor) revert VoucherNotMonotonic();

        address effectiveSigner = signer == address(0) ? ch.payer : signer;
        if (effectiveSigner != ch.payer) {
            Delegation memory delegation = delegations[ch.payer][effectiveSigner];
            if (!delegation.active) revert DelegationInactive();
            if (delegation.validUntil < block.timestamp) revert DelegationExpired();
            if (voucher.cumulativeAmount > delegation.maxCumulative) revert DelegationCapExceeded();
        }
        if (!SignatureChecker.isValidSignatureNow(effectiveSigner, _hashVoucher(voucher), signature)) {
            revert InvalidSignature();
        }

        uint256 delta = voucher.cumulativeAmount - floor;
        if (delta > ch.deposited - floor) revert InsufficientChannelBalance();

        ch.claimed += delta;

        uint256 fee = (delta * protocolFeeBps) / BPS_DENOMINATOR;
        net = delta - fee;

        IERC20 token = IERC20(ch.token);
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
        token.safeTransfer(ch.provider, net);

        emit VoucherSettled(voucher.channelId, ch.provider, voucher.cumulativeAmount, delta, fee, voucher.nonce);
    }

    /* -------------------------------------------------------------------------- */
    /*                             CLOSING AND REFUNDS                            */
    /* -------------------------------------------------------------------------- */

    /// @notice The payer starts a unilateral close: the provider has
    ///         `CLOSE_CHALLENGE_PERIOD` to present its latest voucher before the
    ///         remaining funds can be withdrawn.
    function requestClose(bytes32 channelId) external {
        Channel storage ch = _channels[channelId];
        if (!ch.exists) revert ChannelNotFound();
        if (msg.sender != ch.payer) revert NotPayer();
        ch.closeRequestedAt = uint64(block.timestamp);
        emit CloseRequested(channelId, msg.sender, uint64(block.timestamp) + CLOSE_CHALLENGE_PERIOD);
    }

    /// @notice The payer withdraws the remaining funds, either after the challenge period
    ///         of a close request or after the channel's natural expiry.
    function withdraw(bytes32 channelId) external nonReentrant returns (uint256 amount) {
        Channel storage ch = _channels[channelId];
        if (!ch.exists) revert ChannelNotFound();
        if (msg.sender != ch.payer) revert NotPayer();

        bool expired = ch.expiry <= block.timestamp;
        bool closeMatured =
            ch.closeRequestedAt != 0 && block.timestamp >= ch.closeRequestedAt + CLOSE_CHALLENGE_PERIOD;
        if (!expired && !closeMatured) {
            if (ch.closeRequestedAt == 0) revert CloseNotRequested();
            revert CloseNotMatured();
        }

        amount = available(channelId);
        if (amount == 0) revert NothingToWithdraw();

        ch.refunded += amount;
        ch.closeRequestedAt = 0;
        ch.expiry = uint64(block.timestamp);

        IERC20(ch.token).safeTransfer(ch.payer, amount);
        emit ChannelWithdrawn(channelId, ch.payer, amount);
    }

    /* -------------------------------------------------------------------------- */
    /*                                ADMINISTRATION                              */
    /* -------------------------------------------------------------------------- */

    function setProtocolFee(uint16 bps, address recipient) external onlyOwner {
        _setProtocolFee(bps, recipient);
        emit ProtocolFeeUpdated(bps, recipient);
    }

    function _setProtocolFee(uint16 bps, address recipient) internal {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh();
        if (bps != 0 && recipient == address(0)) revert InvalidAddress();
        protocolFeeBps = bps;
        feeRecipient = recipient;
    }

    /// @notice Pausing only blocks NEW deposits. Settlements and withdrawals always
    ///         remain possible: the owner can never freeze user funds.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
