// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AddrName} from "./libraries/AddrName.sol";

interface IAddrResolverHook {
    function multicallAsRegistry(bytes32 node, bytes[] calldata data) external;
}

/// @title AddrRegistry
/// @notice Source of truth for .addr name ownership, expiry, resolver binding, subnames,
/// locks and guardian recovery. Controllers (the registrar) can only register available
/// names and extend expiry; nobody (including the contract owner) can reassign a live name.
contract AddrRegistry is Ownable2Step {
    // namehash("addr")
    bytes32 public constant ROOT = keccak256(abi.encodePacked(bytes32(0), keccak256("addr")));
    uint64 public constant GRACE_PERIOD = 30 days;
    uint64 public constant MAX_LOCK = 4 * 365 days;
    uint64 public constant MIN_RECOVERY_DELAY = 3 days;
    uint8 public constant MAX_DEPTH = 4; // label.addr is depth 1

    struct Node {
        address owner;
        address resolver;
        uint64 expires; // second-level names only
        uint64 lockedUntil;
        bytes32 parent;
        uint32 generation; // bumped each time the node is (re)created
        uint32 parentGeneration; // subnames: generation of parent at creation
        uint8 depth;
        bool parentControlBurned;
    }

    struct Recovery {
        address guardian;
        uint64 delay;
    }

    struct PendingRecovery {
        address newOwner;
        uint64 executeAfter;
    }

    mapping(bytes32 => Node) private _nodes;
    mapping(address => bool) public controllers;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    // node => owner at approval time => operator => approved
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _nameApprovals;
    mapping(bytes32 => Recovery) public recoveryPolicy;
    mapping(bytes32 => PendingRecovery) public pendingRecovery;

    event ControllerChanged(address indexed controller, bool enabled);
    event NameRegistered(bytes32 indexed node, string label, address indexed owner, uint64 expires);
    event NameRenewed(bytes32 indexed node, uint64 expires);
    event Transfer(bytes32 indexed node, address indexed from, address indexed to);
    event ResolverChanged(bytes32 indexed node, address resolver);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event NameApproval(bytes32 indexed node, address indexed owner, address indexed operator, bool approved);
    event NameLocked(bytes32 indexed node, uint64 until);
    event SubnameCreated(bytes32 indexed parent, bytes32 indexed node, string label, address indexed owner);
    event SubnameRemoved(bytes32 indexed node);
    event ParentControlBurned(bytes32 indexed node);
    event RecoveryPolicySet(bytes32 indexed node, address guardian, uint64 delay);
    event RecoveryStarted(bytes32 indexed node, address newOwner, uint64 executeAfter);
    event RecoveryCancelled(bytes32 indexed node);
    event RecoveryExecuted(bytes32 indexed node, address from, address to);

    error NotController();
    error NotAuthorised();
    error NameUnavailable();
    error NameNotActive();
    error InvalidLabel();
    error InvalidAddress();
    error NameLockedError();
    error NotSecondLevel();
    error DepthExceeded();
    error ParentControlGone();
    error BadRecovery();

    constructor(address admin) Ownable(admin) {}

    modifier onlyController() {
        if (!controllers[msg.sender]) revert NotController();
        _;
    }

    // ------------------------------------------------------------------ views

    function nodeOf(bytes32 parent, bytes32 labelhash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, labelhash));
    }

    function isActive(bytes32 node) public view returns (bool) {
        for (uint256 i = 0; i <= MAX_DEPTH; i++) {
            Node storage n = _nodes[node];
            if (n.owner == address(0)) return false;
            if (n.parent == ROOT) return n.expires > block.timestamp;
            Node storage p = _nodes[n.parent];
            if (p.generation != n.parentGeneration) return false;
            node = n.parent;
        }
        return false;
    }

    function ownerOf(bytes32 node) public view returns (address) {
        return isActive(node) ? _nodes[node].owner : address(0);
    }

    function resolverOf(bytes32 node) external view returns (address) {
        return isActive(node) ? _nodes[node].resolver : address(0);
    }

    function expiresAt(bytes32 node) external view returns (uint64) {
        Node storage n = _nodes[node];
        return n.parent == ROOT ? n.expires : 0;
    }

    function generationOf(bytes32 node) external view returns (uint32) {
        return _nodes[node].generation;
    }

    function lockedUntil(bytes32 node) external view returns (uint64) {
        return _nodes[node].lockedUntil;
    }

    function parentOf(bytes32 node) external view returns (bytes32) {
        return _nodes[node].parent;
    }

    function parentControlBurned(bytes32 node) external view returns (bool) {
        return _nodes[node].parentControlBurned;
    }

    function rawOwner(bytes32 node) external view returns (address) {
        return _nodes[node].owner;
    }

    /// @return 0 = unregistered/available, 1 = active, 2 = grace period, 3 = expired and available
    function statusOf(bytes32 node) external view returns (uint8) {
        Node storage n = _nodes[node];
        if (n.owner == address(0)) return 0;
        if (n.parent != ROOT) return isActive(node) ? 1 : 3;
        if (n.expires > block.timestamp) return 1;
        if (block.timestamp < uint256(n.expires) + GRACE_PERIOD) return 2;
        return 3;
    }

    function available(bytes32 labelhash) public view returns (bool) {
        Node storage n = _nodes[nodeOf(ROOT, labelhash)];
        return n.owner == address(0) || block.timestamp >= uint256(n.expires) + GRACE_PERIOD;
    }

    function isApprovedForName(bytes32 node, address operator) public view returns (bool) {
        address o = _nodes[node].owner;
        return _nameApprovals[node][o][operator];
    }

    /// @notice Owner, global operator, or per-name approved operator.
    function isAuthorised(bytes32 node, address caller) public view returns (bool) {
        address o = _nodes[node].owner;
        if (o == address(0)) return false;
        return caller == o || isApprovedForAll[o][caller] || _nameApprovals[node][o][caller];
    }

    // ------------------------------------------------------------- controllers

    function setController(address controller, bool enabled) external onlyOwner {
        controllers[controller] = enabled;
        emit ControllerChanged(controller, enabled);
    }

    function register(string calldata label, address owner_, uint64 expires, address resolver_)
        external
        onlyController
        returns (bytes32 node)
    {
        bytes memory lb = bytes(label);
        if (!AddrName.validLabel(lb)) revert InvalidLabel();
        if (owner_ == address(0)) revert InvalidAddress();
        bytes32 lh = keccak256(lb);
        if (!available(lh)) revert NameUnavailable();
        node = nodeOf(ROOT, lh);
        Node storage n = _nodes[node];
        n.owner = owner_;
        n.resolver = resolver_;
        n.expires = expires;
        n.parent = ROOT;
        n.depth = 1;
        n.generation += 1;
        n.lockedUntil = 0;
        n.parentControlBurned = false;
        delete recoveryPolicy[node];
        delete pendingRecovery[node];
        emit NameRegistered(node, label, owner_, expires);
        if (resolver_ != address(0)) emit ResolverChanged(node, resolver_);
    }

    function renew(bytes32 node, uint64 newExpires) external onlyController {
        Node storage n = _nodes[node];
        if (n.owner == address(0) || n.parent != ROOT) revert NotSecondLevel();
        if (block.timestamp >= uint256(n.expires) + GRACE_PERIOD) revert NameNotActive();
        require(newExpires > n.expires, "no extension");
        n.expires = newExpires;
        emit NameRenewed(node, newExpires);
    }

    // ------------------------------------------------------------ owner actions

    function transfer(bytes32 node, address to) external {
        if (!isActive(node)) revert NameNotActive();
        Node storage n = _nodes[node];
        address from = n.owner;
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) revert NotAuthorised();
        if (n.lockedUntil > block.timestamp) revert NameLockedError();
        _setOwner(node, to);
        emit Transfer(node, from, to);
    }

    function _setOwner(bytes32 node, address to) internal {
        if (to == address(0)) revert InvalidAddress();
        Node storage n = _nodes[node];
        n.owner = to;
        delete recoveryPolicy[node];
        delete pendingRecovery[node];
    }

    function setResolver(bytes32 node, address resolver_) external {
        if (!isActive(node)) revert NameNotActive();
        Node storage n = _nodes[node];
        if (msg.sender != n.owner && !isApprovedForAll[n.owner][msg.sender]) revert NotAuthorised();
        n.resolver = resolver_;
        emit ResolverChanged(node, resolver_);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /// @notice Approve an operator for records/subname management of one name (cannot transfer).
    function approveName(bytes32 node, address operator, bool approved) external {
        if (!isActive(node)) revert NameNotActive();
        address o = _nodes[node].owner;
        if (msg.sender != o) revert NotAuthorised();
        _nameApprovals[node][o][operator] = approved;
        emit NameApproval(node, o, operator, approved);
    }

    /// @notice Block transfers until `until`. Lock can only be extended, never shortened.
    function lock(bytes32 node, uint64 until) external {
        if (!isActive(node)) revert NameNotActive();
        Node storage n = _nodes[node];
        if (msg.sender != n.owner) revert NotAuthorised();
        require(until > n.lockedUntil && until <= block.timestamp + MAX_LOCK, "bad lock");
        n.lockedUntil = until;
        emit NameLocked(node, until);
    }

    // --------------------------------------------------------------- subnames

    function createSubname(
        bytes32 parent,
        string calldata label,
        address owner_,
        address resolver_,
        bytes[] calldata resolverCalls
    ) external returns (bytes32 node) {
        if (!isActive(parent)) revert NameNotActive();
        if (!isAuthorised(parent, msg.sender)) revert NotAuthorised();
        bytes memory lb = bytes(label);
        if (!AddrName.validLabel(lb)) revert InvalidLabel();
        if (owner_ == address(0)) revert InvalidAddress();
        Node storage p = _nodes[parent];
        if (p.depth >= MAX_DEPTH) revert DepthExceeded();
        node = nodeOf(parent, keccak256(lb));
        if (isActive(node)) revert NameUnavailable();
        Node storage n = _nodes[node];
        n.owner = owner_;
        n.resolver = resolver_;
        n.expires = 0;
        n.lockedUntil = 0;
        n.parent = parent;
        n.parentGeneration = p.generation;
        n.depth = p.depth + 1;
        n.generation += 1;
        n.parentControlBurned = false;
        delete recoveryPolicy[node];
        delete pendingRecovery[node];
        emit SubnameCreated(parent, node, label, owner_);
        if (resolver_ != address(0)) {
            emit ResolverChanged(node, resolver_);
            if (resolverCalls.length > 0) IAddrResolverHook(resolver_).multicallAsRegistry(node, resolverCalls);
        }
    }

    /// @notice Subname owner or (unless burned) the parent's authorised party can remove a subname.
    function removeSubname(bytes32 node) external {
        if (!isActive(node)) revert NameNotActive();
        Node storage n = _nodes[node];
        if (n.parent == ROOT) revert NotSecondLevel();
        bool byOwner = isAuthorised(node, msg.sender) && (msg.sender == n.owner || isApprovedForAll[n.owner][msg.sender]);
        if (!byOwner) {
            if (n.parentControlBurned) revert ParentControlGone();
            if (!isAuthorised(n.parent, msg.sender)) revert NotAuthorised();
        }
        n.owner = address(0);
        n.generation += 1;
        emit SubnameRemoved(node);
    }

    /// @notice Irreversibly makes the subname sovereign: the parent can no longer remove it.
    function burnParentControl(bytes32 node) external {
        if (!isActive(node)) revert NameNotActive();
        Node storage n = _nodes[node];
        if (n.parent == ROOT) revert NotSecondLevel();
        if (msg.sender != n.owner) revert NotAuthorised();
        n.parentControlBurned = true;
        emit ParentControlBurned(node);
    }

    // --------------------------------------------------------------- recovery

    function setRecovery(bytes32 node, address guardian, uint64 delay) external {
        if (!isActive(node)) revert NameNotActive();
        if (msg.sender != _nodes[node].owner) revert NotAuthorised();
        if (guardian != address(0) && delay < MIN_RECOVERY_DELAY) revert BadRecovery();
        recoveryPolicy[node] = Recovery(guardian, delay);
        delete pendingRecovery[node];
        emit RecoveryPolicySet(node, guardian, delay);
    }

    function startRecovery(bytes32 node, address newOwner) external {
        if (!isActive(node)) revert NameNotActive();
        Recovery memory r = recoveryPolicy[node];
        if (r.guardian == address(0) || msg.sender != r.guardian) revert NotAuthorised();
        if (newOwner == address(0)) revert InvalidAddress();
        uint64 at = uint64(block.timestamp) + r.delay;
        pendingRecovery[node] = PendingRecovery(newOwner, at);
        emit RecoveryStarted(node, newOwner, at);
    }

    function cancelRecovery(bytes32 node) external {
        Node storage n = _nodes[node];
        if (msg.sender != n.owner) revert NotAuthorised();
        delete pendingRecovery[node];
        emit RecoveryCancelled(node);
    }

    function executeRecovery(bytes32 node) external {
        if (!isActive(node)) revert NameNotActive();
        PendingRecovery memory p = pendingRecovery[node];
        require(p.newOwner != address(0) && block.timestamp >= p.executeAfter, "not ready");
        Recovery memory r = recoveryPolicy[node];
        require(msg.sender == r.guardian, "guardian only");
        address from = _nodes[node].owner;
        _setOwner(node, p.newOwner);
        emit RecoveryExecuted(node, from, p.newOwner);
        emit Transfer(node, from, p.newOwner);
    }
}
