// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AddrRegistry} from "./AddrRegistry.sol";
import {AddrName} from "./libraries/AddrName.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title AddrRegistrar
/// @notice Registration and renewal with public, length-based USD pricing (micro-USD, 1e6),
/// one free 5+ char name per wallet (optionally voucher-gated), commit-reveal anti-front-running,
/// ETH / stablecoin payment, and a rate-capped operator path for names paid in off-chain coins.
contract AddrRegistrar is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint64 public constant YEAR = 365 days;
    uint8 public constant MAX_YEARS = 5;
    uint256 public constant MAX_ORACLE_AGE = 1 days;
    bytes32 private constant FREE_CLAIM_TYPEHASH = keccak256("FreeClaim(address owner,bytes32 labelhash,uint256 deadline)");

    struct Tier {
        uint128 priceUsd; // micro-USD per year
        bool enabled;
    }

    struct RegisterRequest {
        string label;
        address owner;
        uint8 years_;
        address token; // address(0) = native ETH
        bytes32 secret;
        uint256 deadline; // free-claim voucher deadline
        bytes voucher; // free-claim voucher signature (if freeSigner set)
    }

    AddrRegistry public immutable registry;
    address public resolver;
    address public treasury;
    address public freeSigner;
    IAggregatorV3 public ethUsdFeed;
    uint64 public minCommitmentAge = 60;
    uint64 public constant MAX_COMMITMENT_AGE = 1 days;

    // tiers[len] for len 1..4; tiers[5] = price for additional (non-free) names of length >= 5
    mapping(uint256 => Tier) public tiers;
    mapping(bytes32 => uint256) public premiumUsd; // labelhash => micro-USD per year
    mapping(bytes32 => bool) public reserved;
    mapping(address => uint8) public acceptedTokenDecimals; // 0 = not accepted
    mapping(address => bool) public freeClaimed;
    mapping(bytes32 => bool) public freeNode; // free-claimed names renew for free
    mapping(bytes32 => uint64) public commitments;

    // off-chain-paid registrations
    mapping(address => bool) public paymentOperators;
    mapping(bytes32 => bool) public paymentRefUsed;
    uint32 public operatorDailyCap = 500;
    uint64 public operatorWindowStart;
    uint32 public operatorWindowCount;

    event Commitment(bytes32 indexed commitment);
    event NameRegistered(bytes32 indexed node, string label, address indexed owner, uint8 years_, uint256 usdPaid, bool free, address token, uint256 amountPaid);
    event NameRenewed(bytes32 indexed node, uint8 years_, uint256 usdPaid, address token, uint256 amountPaid);
    event PaidRegistration(bytes32 indexed node, string label, address indexed owner, uint8 years_, bytes32 indexed paymentRef);
    event PaidRenewal(bytes32 indexed node, uint8 years_, bytes32 indexed paymentRef);
    event TierSet(uint256 indexed length, uint128 priceUsd, bool enabled);
    event PremiumSet(bytes32 indexed labelhash, uint256 priceUsd);
    event ReservedSet(bytes32 indexed labelhash, bool reserved);
    event TokenAccepted(address indexed token, uint8 decimals);
    event TreasuryChanged(address treasury);
    event PaymentOperatorChanged(address indexed operator, bool enabled);

    error InvalidLabel();
    error ReservedName();
    error LengthNotOpen();
    error BadDuration();
    error CommitmentMissing();
    error CommitmentTooNew();
    error CommitmentExpired();
    error FreeAlreadyClaimed();
    error BadVoucher();
    error TokenNotAccepted();
    error Underpaid(uint256 required, uint256 sent);
    error OracleStale();
    error NotOperator();
    error OperatorCapReached();
    error RefUsed();
    error PaymentFailed();
    error DurationCap();
    error NotReserved();

    constructor(AddrRegistry registry_, address admin, address treasury_) Ownable(admin) EIP712("AddrRegistrar", "1") {
        registry = registry_;
        treasury = treasury_;
        // initial public pricing (admin may change via timelock; applies to future registrations only)
        _setTier(1, 0, false);
        _setTier(2, 200e6, true);
        _setTier(3, 50e6, true);
        _setTier(4, 15e6, true);
        _setTier(5, 5e6, true);
    }

    // ------------------------------------------------------------------ admin

    function setResolver(address r) external onlyOwner {
        resolver = r;
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "zero");
        treasury = t;
        emit TreasuryChanged(t);
    }

    function setFreeSigner(address s) external onlyOwner {
        freeSigner = s;
    }

    function setEthUsdFeed(address f) external onlyOwner {
        ethUsdFeed = IAggregatorV3(f);
    }

    function setMinCommitmentAge(uint64 s) external onlyOwner {
        require(s < MAX_COMMITMENT_AGE, "too long");
        minCommitmentAge = s;
    }

    function setTier(uint256 length, uint128 priceUsd, bool enabled) external onlyOwner {
        require(length >= 1 && length <= 5, "length");
        _setTier(length, priceUsd, enabled);
    }

    function _setTier(uint256 length, uint128 priceUsd, bool enabled) internal {
        tiers[length] = Tier(priceUsd, enabled);
        emit TierSet(length, priceUsd, enabled);
    }

    function setPremium(bytes32 labelhash, uint256 priceUsd) external onlyOwner {
        premiumUsd[labelhash] = priceUsd;
        emit PremiumSet(labelhash, priceUsd);
    }

    function setReserved(bytes32[] calldata labelhashes, bool value) external onlyOwner {
        for (uint256 i = 0; i < labelhashes.length; i++) {
            reserved[labelhashes[i]] = value;
            emit ReservedSet(labelhashes[i], value);
        }
    }

    function setAcceptedToken(address token, uint8 decimals_) external onlyOwner {
        acceptedTokenDecimals[token] = decimals_;
        emit TokenAccepted(token, decimals_);
    }

    function setPaymentOperator(address op, bool enabled) external onlyOwner {
        paymentOperators[op] = enabled;
        emit PaymentOperatorChanged(op, enabled);
    }

    function setOperatorDailyCap(uint32 cap) external onlyOwner {
        operatorDailyCap = cap;
    }

    /// @notice Issue a reserved system name (admin.addr, support.addr ...). Cannot touch registered names:
    /// the registry only registers available names.
    function mintReserved(string calldata label, address owner_, uint8 years_) external onlyOwner {
        bytes32 lh = keccak256(bytes(label));
        if (!reserved[lh]) revert NotReserved();
        if (years_ == 0 || years_ > MAX_YEARS) revert BadDuration();
        _registerNode(label, owner_, years_);
    }

    // ------------------------------------------------------------------ views

    function makeCommitment(string calldata label, address owner_, bytes32 secret) public pure returns (bytes32) {
        return keccak256(abi.encode(label, owner_, secret));
    }

    function commit(bytes32 commitment) external {
        require(commitments[commitment] == 0 || block.timestamp > commitments[commitment] + MAX_COMMITMENT_AGE, "already committed");
        commitments[commitment] = uint64(block.timestamp);
        emit Commitment(commitment);
    }

    function available(string calldata label) external view returns (bool) {
        bytes memory lb = bytes(label);
        if (!AddrName.validLabel(lb)) return false;
        bytes32 lh = keccak256(lb);
        if (reserved[lh]) return false;
        return registry.available(lh) && _lengthOpen(lb.length, lh);
    }

    function _lengthOpen(uint256 len, bytes32 lh) internal view returns (bool) {
        if (premiumUsd[lh] > 0) return true;
        if (len >= 5) return tiers[5].enabled;
        return tiers[len].enabled && tiers[len].priceUsd > 0;
    }

    /// @return usdPerYear micro-USD price for one year, and whether this wallet would receive the free tier.
    function priceFor(string calldata label, address owner_) public view returns (uint256 usdPerYear, bool free) {
        bytes memory lb = bytes(label);
        bytes32 lh = keccak256(lb);
        uint256 prem = premiumUsd[lh];
        if (prem > 0) return (prem, false);
        uint256 len = lb.length;
        if (len >= 5) {
            if (!freeClaimed[owner_]) return (0, true);
            return (tiers[5].priceUsd, false);
        }
        return (tiers[len].priceUsd, false);
    }

    function renewalPriceFor(string calldata label) public view returns (uint256 usdPerYear) {
        bytes memory lb = bytes(label);
        bytes32 lh = keccak256(lb);
        bytes32 node = registry.nodeOf(registry.ROOT(), lh);
        if (freeNode[node]) return 0;
        uint256 prem = premiumUsd[lh];
        if (prem > 0) return prem;
        uint256 len = lb.length;
        return tiers[len >= 5 ? 5 : len].priceUsd;
    }

    function ethForUsd(uint256 usdMicro) public view returns (uint256) {
        if (address(ethUsdFeed) == address(0)) revert TokenNotAccepted();
        (, int256 answer, , uint256 updatedAt, ) = ethUsdFeed.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_ORACLE_AGE) revert OracleStale();
        uint8 fd = ethUsdFeed.decimals();
        // usdMicro * 1e12 = usd * 1e18 ; price = answer / 10^fd ; wei = usd18 / price
        uint256 usd18 = usdMicro * 1e12;
        return (usd18 * (10 ** fd)) / uint256(answer) + 1; // round up
    }

    function tokenForUsd(address token, uint256 usdMicro) public view returns (uint256) {
        uint8 d = acceptedTokenDecimals[token];
        if (d == 0) revert TokenNotAccepted();
        return d >= 6 ? usdMicro * (10 ** (d - 6)) : usdMicro / (10 ** (6 - d));
    }

    // -------------------------------------------------------------- registration

    function register(RegisterRequest calldata r) external payable nonReentrant {
        bytes memory lb = bytes(r.label);
        if (!AddrName.validLabel(lb)) revert InvalidLabel();
        bytes32 lh = keccak256(lb);
        if (reserved[lh]) revert ReservedName();
        if (r.years_ == 0 || r.years_ > MAX_YEARS) revert BadDuration();
        if (r.owner == address(0)) revert BadDuration();
        if (!_lengthOpen(lb.length, lh)) revert LengthNotOpen();
        _consumeCommitment(makeCommitment(r.label, r.owner, r.secret));

        (uint256 perYear, bool free) = this.priceFor(r.label, r.owner);
        uint256 usd = perYear * r.years_;
        uint256 paid;
        if (free) {
            if (freeClaimed[r.owner]) revert FreeAlreadyClaimed();
            if (r.years_ != 1) revert BadDuration();
            if (msg.value != 0) revert PaymentFailed();
            if (freeSigner != address(0)) _checkVoucher(r.owner, lh, r.deadline, r.voucher);
            freeClaimed[r.owner] = true;
        } else {
            paid = _collect(usd, r.token);
        }
        bytes32 node = _registerNode(r.label, r.owner, r.years_);
        if (free) freeNode[node] = true;
        emit NameRegistered(node, r.label, r.owner, r.years_, usd, free, free ? address(0) : r.token, paid);
    }

    function renew(string calldata label, uint8 years_, address token) external payable nonReentrant {
        if (years_ == 0 || years_ > MAX_YEARS) revert BadDuration();
        bytes32 node = registry.nodeOf(registry.ROOT(), keccak256(bytes(label)));
        uint256 usd = renewalPriceFor(label) * years_;
        uint256 paid;
        if (usd > 0) paid = _collect(usd, token);
        else if (msg.value != 0) revert PaymentFailed();
        _extend(node, years_);
        emit NameRenewed(node, years_, usd, usd > 0 ? token : address(0), paid);
    }

    function _registerNode(string calldata label, address owner_, uint8 years_) internal returns (bytes32 node) {
        node = registry.register(label, owner_, uint64(block.timestamp) + YEAR * years_, resolver);
    }

    function _extend(bytes32 node, uint8 years_) internal {
        uint64 current = registry.expiresAt(node);
        uint64 next = current + YEAR * years_;
        if (next > block.timestamp + uint256(YEAR) * MAX_YEARS) revert DurationCap();
        registry.renew(node, next);
    }

    function _consumeCommitment(bytes32 c) internal {
        uint64 t = commitments[c];
        if (t == 0) revert CommitmentMissing();
        if (block.timestamp < uint256(t) + minCommitmentAge) revert CommitmentTooNew();
        if (block.timestamp > uint256(t) + MAX_COMMITMENT_AGE) revert CommitmentExpired();
        delete commitments[c];
    }

    function _checkVoucher(address owner_, bytes32 lh, uint256 deadline, bytes calldata sig) internal view {
        if (block.timestamp > deadline) revert BadVoucher();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FREE_CLAIM_TYPEHASH, owner_, lh, deadline)));
        if (ECDSA.recover(digest, sig) != freeSigner) revert BadVoucher();
    }

    function _collect(uint256 usdMicro, address token) internal returns (uint256 amount) {
        if (token == address(0)) {
            amount = ethForUsd(usdMicro);
            if (msg.value < amount) revert Underpaid(amount, msg.value);
            (bool ok, ) = treasury.call{value: amount}("");
            if (!ok) revert PaymentFailed();
            if (msg.value > amount) {
                (bool ok2, ) = msg.sender.call{value: msg.value - amount}("");
                if (!ok2) revert PaymentFailed();
            }
        } else {
            if (msg.value != 0) revert PaymentFailed();
            amount = tokenForUsd(token, usdMicro);
            IERC20(token).safeTransferFrom(msg.sender, treasury, amount);
        }
    }

    // ------------------------------------------------ operator path (off-chain coins)

    modifier onlyOperator() {
        if (!paymentOperators[msg.sender]) revert NotOperator();
        _;
    }

    function _operatorTick() internal {
        if (block.timestamp >= operatorWindowStart + 1 days) {
            operatorWindowStart = uint64(block.timestamp);
            operatorWindowCount = 0;
        }
        if (operatorWindowCount >= operatorDailyCap) revert OperatorCapReached();
        operatorWindowCount += 1;
    }

    /// @notice Register a name whose price was paid in BTC/LTC/SOL/TRX etc. The payment reference is
    /// recorded on-chain and may only be used once. The operator can only mint available, non-reserved names.
    function registerPaid(string calldata label, address owner_, uint8 years_, bytes32 paymentRef) external onlyOperator nonReentrant {
        bytes memory lb = bytes(label);
        if (!AddrName.validLabel(lb)) revert InvalidLabel();
        bytes32 lh = keccak256(lb);
        if (reserved[lh]) revert ReservedName();
        if (years_ == 0 || years_ > MAX_YEARS) revert BadDuration();
        if (!_lengthOpen(lb.length, lh)) revert LengthNotOpen();
        if (paymentRefUsed[paymentRef]) revert RefUsed();
        paymentRefUsed[paymentRef] = true;
        _operatorTick();
        bytes32 node = _registerNode(label, owner_, years_);
        emit PaidRegistration(node, label, owner_, years_, paymentRef);
    }

    function renewPaid(string calldata label, uint8 years_, bytes32 paymentRef) external onlyOperator nonReentrant {
        if (years_ == 0 || years_ > MAX_YEARS) revert BadDuration();
        if (paymentRefUsed[paymentRef]) revert RefUsed();
        paymentRefUsed[paymentRef] = true;
        _operatorTick();
        bytes32 node = registry.nodeOf(registry.ROOT(), keccak256(bytes(label)));
        _extend(node, years_);
        emit PaidRenewal(node, years_, paymentRef);
    }
}
