// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AddrName} from "./libraries/AddrName.sol";

interface IAddrResolverHook {
    function multicallAsRegistry(bytes32 node, bytes[] calldata data) external;
}

/// @title AddrRegistry
/// @notice Source of truth for .addr name ownership, expiry, resolver binding, subnames,
/// locks and guardian recovery. Controllers (the registrar) can only register available
/// names and extend expiry; nobody (including the contract owner) can reassign a live name.
/// Also a standard ERC-721 token: tokenId = uint256(node), so names are listable on any NFT
/// marketplace (OpenSea, Blur, ...) without that marketplace needing to know anything
/// .addr-specific. The ERC-721 surface is purely additive over the existing node-keyed model —
/// transfer(), register() etc. keep their exact original behavior and events.
contract AddrRegistry is Ownable2Step, IERC721, IERC721Metadata, EIP712 {
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

    // --------------------------------------------------------------- ERC-721
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    /// @notice Base URI for token metadata: tokenURI(id) = baseTokenURI + id. Settable so the
    /// metadata host can change without redeploying the contract.
    string public baseTokenURI;
    event BaseTokenURIChanged(string uri);

    event ControllerChanged(address indexed controller, bool enabled);
    event NameRegistered(bytes32 indexed node, string label, address indexed owner, uint64 expires);
    event NameRenewed(bytes32 indexed node, uint64 expires);
    event Transfer(bytes32 indexed node, address indexed from, address indexed to);
    event ResolverChanged(bytes32 indexed node, address resolver);
    // ApprovalForAll is inherited from IERC721 (exact same signature already matches what this
    // contract always emitted).
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
    error TransferRejected();
    error Expired();
    error BadSignature();

    /// @notice Gasless transfer(): anyone (in practice, ADDR's sponsored relayer) can submit this on
    /// the owner's behalf given a fresh signature — same shape as AddrResolver's signed writes.
    mapping(address => uint256) public nonces;
    bytes32 private constant TRANSFER_TYPEHASH = keccak256("Transfer(bytes32 node,address to,uint256 nonce,uint256 deadline)");

    constructor(address admin) Ownable(admin) EIP712("AddrRegistry", "1") {}

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

    function setBaseTokenURI(string calldata uri) external onlyOwner {
        baseTokenURI = uri;
        emit BaseTokenURIChanged(uri);
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
        n.resolver = resolver_;
        n.expires = expires;
        n.parent = ROOT;
        n.depth = 1;
        n.generation += 1;
        n.lockedUntil = 0;
        n.parentControlBurned = false;
        _moveOwnership(node, owner_);
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
        _doTransfer(node, to, msg.sender);
    }

    /// @notice Gasless transfer: valid only with a fresh (unused nonce, unexpired) signature from
    /// the owner or an approved-for-all operator — the same set of callers transfer() itself allows.
    function transferSigned(bytes32 node, address to, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
    {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_TYPEHASH, node, to, nonce, deadline)));
        address signer = ECDSA.recover(digest, signature);
        if (nonce != nonces[signer]) revert BadSignature();
        nonces[signer] = nonce + 1;
        _doTransfer(node, to, signer);
    }

    function _doTransfer(bytes32 node, address to, address authorizer) internal {
        if (!isActive(node)) revert NameNotActive();
        if (to == address(0)) revert InvalidAddress();
        Node storage n = _nodes[node];
        address from = n.owner;
        if (authorizer != from && !isApprovedForAll[from][authorizer]) revert NotAuthorised();
        if (n.lockedUntil > block.timestamp) revert NameLockedError();
        _moveOwnership(node, to);
        emit Transfer(node, from, to);
    }

    /// @dev Core ownership-change bookkeeping shared by every path that moves, mints or burns a
    /// node's owner (register, transfer, createSubname, removeSubname, executeRecovery, and the
    /// ERC-721 transferFrom). Keeps ERC-721 balances/approvals and the standard Transfer event in
    /// sync with the node-keyed owner field in exactly one place, so there is no path that can
    /// update one without the other.
    function _moveOwnership(bytes32 node, address to) internal returns (address from) {
        Node storage n = _nodes[node];
        from = n.owner;
        n.owner = to;
        delete recoveryPolicy[node];
        delete pendingRecovery[node];
        if (from != address(0)) _balances[from] -= 1;
        if (to != address(0)) _balances[to] += 1;
        delete _tokenApprovals[uint256(node)];
        emit Transfer(from, to, uint256(node));
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
    /// Distinct from the ERC-721 approve()/getApproved(), which is specifically about transfer rights.
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
        n.resolver = resolver_;
        n.expires = 0;
        n.lockedUntil = 0;
        n.parent = parent;
        n.parentGeneration = p.generation;
        n.depth = p.depth + 1;
        n.generation += 1;
        n.parentControlBurned = false;
        _moveOwnership(node, owner_);
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
        _moveOwnership(node, address(0));
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
        address from = _moveOwnership(node, p.newOwner);
        emit RecoveryExecuted(node, from, p.newOwner);
        emit Transfer(node, from, p.newOwner);
    }

    // ------------------------------------------------------------------------------- ERC-721
    // tokenId = uint256(node). Fully additive: every function below is new surface built on top
    // of the exact same ownership data the rest of this contract already maintains, so a name
    // is always the same thing whether you look at it through the .addr-specific API above or
    // the generic ERC-721 API below. See _moveOwnership for why there is no way for the two to
    // disagree.

    function balanceOf(address owner_) external view returns (uint256) {
        if (owner_ == address(0)) revert InvalidAddress();
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = ownerOf(bytes32(tokenId));
        if (o == address(0)) revert NameNotActive();
        return o;
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (!isActive(bytes32(tokenId))) revert NameNotActive();
        return _tokenApprovals[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        bytes32 node = bytes32(tokenId);
        if (!isActive(node)) revert NameNotActive();
        address o = _nodes[node].owner;
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotAuthorised();
        _tokenApprovals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        bytes32 node = bytes32(tokenId);
        if (!isActive(node)) revert NameNotActive();
        if (to == address(0)) revert InvalidAddress();
        Node storage n = _nodes[node];
        if (n.owner != from) revert NotAuthorised();
        if (msg.sender != from && msg.sender != _tokenApprovals[tokenId] && !isApprovedForAll[from][msg.sender]) {
            revert NotAuthorised();
        }
        if (n.lockedUntil > block.timestamp) revert NameLockedError();
        _moveOwnership(node, to);
        emit Transfer(node, from, to);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                if (retval != IERC721Receiver.onERC721Received.selector) revert TransferRejected();
            } catch {
                revert TransferRejected();
            }
        }
    }

    function name() external pure returns (string memory) {
        return "ADDR Names";
    }

    function symbol() external pure returns (string memory) {
        return "ADDR";
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (!isActive(bytes32(tokenId))) revert NameNotActive();
        return string(abi.encodePacked(baseTokenURI, Strings.toString(tokenId)));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC721).interfaceId
            || interfaceId == type(IERC721Metadata).interfaceId;
    }
}
