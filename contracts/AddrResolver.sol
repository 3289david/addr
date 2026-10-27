// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AddrRegistry} from "./AddrRegistry.sol";
import {AddrName} from "./libraries/AddrName.sol";

/// @title AddrResolver
/// @notice Multichain address records (ENSIP-9 / ENSIP-11 coin types), text records and
/// forward-verified reverse records. Records of expired or re-registered names are invisible.
/// Gasless writes: setAddrSigned/setPrimaryNameSigned let the owner sign an EIP-712 message
/// authorizing a change and have anyone (in practice, ADDR's sponsored relayer) submit and pay gas
/// for it. The signer is recovered and checked with the exact same registry.isAuthorised rule the
/// plain msg.sender path uses — a relayed call can do nothing a direct call from the owner couldn't.
contract AddrResolver is EIP712 {
    AddrRegistry public immutable registry;
    mapping(address => uint256) public nonces;

    bytes32 private constant SET_ADDR_TYPEHASH =
        keccak256("SetAddr(bytes32 node,uint256 coinType,bytes value,uint256 nonce,uint256 deadline)");
    bytes32 private constant SET_PRIMARY_NAME_TYPEHASH =
        keccak256("SetPrimaryName(bytes32 node,string name,uint256 nonce,uint256 deadline)");

    error Expired();
    error BadSignature();

    struct Meta {
        uint64 updatedAt;
        uint64 updatedBlock;
        uint32 version; // number of writes to this coinType for the current record epoch
    }

    mapping(bytes32 => uint64) public recordVersions;
    // node => epoch => coinType => value
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => bytes))) private _addrs;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => Meta))) private _meta;
    mapping(bytes32 => mapping(uint256 => mapping(string => string))) private _texts;

    struct Primary {
        bytes32 node;
        string name;
    }

    mapping(address => Primary) private _primary;
    bytes32 private _registryNode; // set only while the registry bootstraps a new subname

    event AddrChanged(bytes32 indexed node, uint256 indexed coinType, bytes newAddress, uint32 version);
    event AddressChanged(bytes32 indexed node, address a); // ENS-compatible
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);
    event RecordsCleared(bytes32 indexed node, uint64 version);
    event PrimaryNameSet(address indexed account, bytes32 indexed node, string name);

    error NotAuthorised();
    error InvalidRecord(uint256 coinType);
    error InvalidName();
    error NotVerified();

    uint256 internal constant COIN_BTC = 0;
    uint256 internal constant COIN_LTC = 2;
    uint256 internal constant COIN_TRX = 195;
    uint256 internal constant COIN_SOL = 501;
    uint256 internal constant COIN_ETH = 60;
    uint256 internal constant EVM_FLAG = 0x80000000;

    constructor(AddrRegistry registry_) EIP712("AddrResolver", "1") {
        registry = registry_;
    }

    // ---------------------------------------------------------------- auth

    function _auth(bytes32 node) internal view {
        if (msg.sender == address(registry) && _registryNode == node) return;
        if (!registry.isActive(node) || !registry.isAuthorised(node, msg.sender)) revert NotAuthorised();
    }

    function _epoch(bytes32 node) internal view returns (uint256) {
        return (uint256(registry.generationOf(node)) << 64) | recordVersions[node];
    }

    // ------------------------------------------------------------- addresses

    function setAddr(bytes32 node, uint256 coinType, bytes memory a) public {
        _auth(node);
        _setAddr(node, coinType, a);
    }

    /// @dev ENS-compatible ETH setter.
    function setAddr(bytes32 node, address a) external {
        setAddr(node, COIN_ETH, a == address(0) ? bytes("") : abi.encodePacked(a));
    }

    /// @notice Gasless setAddr: anyone can submit this on the owner's behalf, as long as it carries
    /// a fresh (unused nonce, not-yet-expired) signature from an address registry.isAuthorised
    /// accepts for this node — the exact same authorization setAddr() itself requires.
    function setAddrSigned(
        bytes32 node,
        uint256 coinType,
        bytes calldata a,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(SET_ADDR_TYPEHASH, node, coinType, keccak256(a), nonce, deadline)));
        address signer = ECDSA.recover(digest, signature);
        if (nonce != nonces[signer]) revert BadSignature();
        if (!registry.isActive(node) || !registry.isAuthorised(node, signer)) revert NotAuthorised();
        nonces[signer] = nonce + 1;
        _setAddr(node, coinType, a);
    }

    function _setAddr(bytes32 node, uint256 coinType, bytes memory a) internal {
        _validate(coinType, a);
        uint256 ep = _epoch(node);
        _addrs[node][ep][coinType] = a;
        Meta storage m = _meta[node][ep][coinType];
        m.updatedAt = uint64(block.timestamp);
        m.updatedBlock = uint64(block.number);
        m.version += 1;
        emit AddrChanged(node, coinType, a, m.version);
        if (coinType == COIN_ETH) emit AddressChanged(node, _bytesToAddress(a));
    }

    function addr(bytes32 node, uint256 coinType) public view returns (bytes memory) {
        if (!registry.isActive(node)) return "";
        return _addrs[node][_epoch(node)][coinType];
    }

    /// @dev ENS-compatible ETH getter.
    function addr(bytes32 node) external view returns (address payable) {
        return payable(_bytesToAddress(addr(node, COIN_ETH)));
    }

    function addrMeta(bytes32 node, uint256 coinType)
        external
        view
        returns (uint64 updatedAt, uint64 updatedBlock, uint32 version)
    {
        Meta storage m = _meta[node][_epoch(node)][coinType];
        return (m.updatedAt, m.updatedBlock, m.version);
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        _auth(node);
        require(bytes(value).length <= 1024 && bytes(key).length <= 64, "too long");
        _texts[node][_epoch(node)][key] = value;
        emit TextChanged(node, key, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        if (!registry.isActive(node)) return "";
        return _texts[node][_epoch(node)][key];
    }

    /// @notice Invalidates every record of a name in O(1).
    function clearRecords(bytes32 node) external {
        _auth(node);
        recordVersions[node] += 1;
        emit RecordsCleared(node, recordVersions[node]);
    }

    // --------------------------------------------------------------- reverse

    /// @notice Set caller's primary name. The caller must control the name and the name must not
    /// be hijackable: it has to be owned by the caller or resolve (coin 60) to the caller.
    function setPrimaryName(string calldata name) external {
        (bytes32 node, bool ok) = AddrName.namehash(name);
        if (!ok) revert InvalidName();
        if (!_forwardOk(node, msg.sender)) revert NotVerified();
        _primary[msg.sender] = Primary(node, name);
        emit PrimaryNameSet(msg.sender, node, name);
    }

    /// @notice Gasless setPrimaryName, same signed-relay shape as setAddrSigned.
    function setPrimaryNameSigned(string calldata name, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
    {
        if (block.timestamp > deadline) revert Expired();
        (bytes32 node, bool ok) = AddrName.namehash(name);
        if (!ok) revert InvalidName();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SET_PRIMARY_NAME_TYPEHASH, node, keccak256(bytes(name)), nonce, deadline))
        );
        address signer = ECDSA.recover(digest, signature);
        if (nonce != nonces[signer]) revert BadSignature();
        if (!_forwardOk(node, signer)) revert NotVerified();
        nonces[signer] = nonce + 1;
        _primary[signer] = Primary(node, name);
        emit PrimaryNameSet(signer, node, name);
    }

    function clearPrimaryName() external {
        delete _primary[msg.sender];
        emit PrimaryNameSet(msg.sender, bytes32(0), "");
    }

    /// @return name empty unless the primary name is set AND still verifies (active and owned / resolving to `account`)
    function reverse(address account) external view returns (string memory name, bytes32 node) {
        Primary storage p = _primary[account];
        if (p.node == bytes32(0) || !_forwardOk(p.node, account)) return ("", bytes32(0));
        return (p.name, p.node);
    }

    function _forwardOk(bytes32 node, address account) internal view returns (bool) {
        if (!registry.isActive(node)) return false;
        if (registry.ownerOf(node) == account) return true;
        bytes memory a = _addrs[node][_epoch(node)][COIN_ETH];
        return a.length == 20 && _bytesToAddress(a) == account;
    }

    // ------------------------------------------------------------- multicall

    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }

    /// @dev Called by the registry while creating a subname so an issuer can provision records
    /// atomically for the new owner. Only writes for exactly `node` are accepted.
    function multicallAsRegistry(bytes32 node, bytes[] calldata data) external {
        require(msg.sender == address(registry), "registry only");
        _registryNode = node;
        for (uint256 i = 0; i < data.length; i++) {
            require(data[i].length >= 36 && bytes32(data[i][4:36]) == node, "wrong node");
            bytes4 sel = bytes4(data[i][0:4]);
            require(
                sel == bytes4(keccak256("setAddr(bytes32,uint256,bytes)")) ||
                    sel == bytes4(keccak256("setAddr(bytes32,address)")) ||
                    sel == bytes4(keccak256("setText(bytes32,string,string)")),
                "selector"
            );
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        _registryNode = bytes32(0);
    }

    // ------------------------------------------------------------ validation

    function _validate(uint256 coinType, bytes memory a) internal pure {
        uint256 n = a.length;
        if (n == 0) return; // clearing
        if (coinType == COIN_ETH || (coinType & EVM_FLAG != 0 && coinType < 0x100000000)) {
            if (n != 20) revert InvalidRecord(coinType);
        } else if (coinType == COIN_SOL) {
            if (n != 32) revert InvalidRecord(coinType);
        } else if (coinType == COIN_TRX) {
            if (n != 21 || a[0] != 0x41) revert InvalidRecord(coinType);
        } else if (coinType == COIN_BTC || coinType == COIN_LTC) {
            bool ok;
            if (n == 25) ok = a[0] == 0x76 && a[1] == 0xa9 && a[2] == 0x14 && a[23] == 0x88 && a[24] == 0xac;
            else if (n == 23) ok = a[0] == 0xa9 && a[1] == 0x14 && a[22] == 0x87;
            else if (n == 22) ok = a[0] == 0x00 && a[1] == 0x14;
            else if (n == 34) ok = (a[0] == 0x00 && a[1] == 0x20) || (a[0] == 0x51 && a[1] == 0x20);
            if (!ok) revert InvalidRecord(coinType);
        } else if (n > 128) {
            revert InvalidRecord(coinType);
        }
    }

    function _bytesToAddress(bytes memory b) internal pure returns (address a) {
        if (b.length != 20) return address(0);
        assembly {
            a := shr(96, mload(add(b, 32)))
        }
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return
            id == 0x01ffc9a7 || // ERC165
            id == 0x3b3b57de || // addr(bytes32)
            id == 0xf1cb7e06 || // addr(bytes32,uint256)
            id == 0x59d1d43c; // text(bytes32,string)
    }
}
