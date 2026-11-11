// SPDX-License-Identifier: LicenseRef-ChainIntegrate-All-Rights-Reserved
pragma solidity 0.8.28;

import {
    LSP8IdentifiableDigitalAssetInitAbstract
} from "@lukso/lsp8-contracts/contracts/LSP8IdentifiableDigitalAssetInitAbstract.sol";
import {_LSP8_TOKENID_FORMAT_UNIQUE_ID} from "@lukso/lsp8-contracts/contracts/LSP8Constants.sol";
import {_LSP4_TOKEN_TYPE_COLLECTION} from "@lukso/lsp4-contracts/contracts/LSP4Constants.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title GasCylinderRegistry
/// @notice One company's register of technical gas cylinders: one LSP8 token per cylinder.
///
/// - Token IDs are opaque `bytes32` values (an HMAC of the serial number made off-chain with the company's
///   key): the contract never sees a serial number.
/// - Cylinder data (`GCRInfo`, `GCRState`), counterparties and the wrapped data key are stored encrypted;
///   the contract only stores and compares bytes.
/// - Every write goes through an EIP-712 signature, so that whoever submits the transaction (the relayer)
///   pays the gas and the signer never needs LYX. Signatures of contract accounts (Universal Profiles) are
///   checked with ERC-1271.
/// - Tokens always belong to the registry's owner. They cannot be transferred; `syncHolders` moves them to
///   the current owner after an ownership change (the same company moving to a new account).
///
/// Deployed as EIP-1167 clones by `GasCylinderRegistryFactory`; not upgradeable.
contract GasCylinderRegistry is LSP8IdentifiableDigitalAssetInitAbstract, EIP712Upgradeable {
    // ---------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------

    /// @notice Per-token data key of the encrypted cylinder information (serial, gas, capacity, ownership).
    bytes32 public constant INFO_KEY = keccak256("GCRInfo");
    /// @notice Per-token data key of the encrypted cylinder state (location, condition, last movement).
    bytes32 public constant STATE_KEY = keccak256("GCRState");

    /// @notice `keccak256("")`: the expected hash of a value that was never written.
    bytes32 public constant EMPTY_HASH = keccak256("");

    bytes32 public constant RECORD_DOCUMENT_TYPEHASH =
        keccak256("RecordDocument(address signer,bytes32 payloadHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant SET_OPERATOR_TYPEHASH =
        keccak256("SetOperator(address operator,bool enabled,uint256 nonce,uint256 deadline)");
    bytes32 public constant SET_DATA_TYPEHASH =
        keccak256("SetData(bytes32[] dataKeys,bytes32 dataValuesHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_OWNERSHIP_TYPEHASH =
        keccak256("TransferOwnership(address newOwner,uint256 nonce,uint256 deadline)");
    bytes32 public constant ACCEPT_OWNERSHIP_TYPEHASH =
        keccak256("AcceptOwnership(address newOwner,uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------

    /// @notice A write of one cylinder's `GCRInfo` or `GCRState`, applied only if the current value still
    /// hashes to `expectedHash` (`EMPTY_HASH` for a value never written).
    struct TokenDataUpdate {
        bytes32 tokenId;
        bytes32 dataKey;
        bytes32 expectedHash;
        bytes newValue;
    }

    /// @notice One part of a document (a delivery note, a stock count, a refill note), with the cylinders it
    /// registers and the data it changes. `document` is the encrypted document (may be empty in all parts
    /// but one). `corrects` is the id of an earlier document this one corrects, or zero.
    struct DocumentPayload {
        bytes32 docId;
        uint16 part;
        uint16 parts;
        bytes32 corrects;
        bytes32[] mints;
        TokenDataUpdate[] updates;
        bytes document;
    }

    // ---------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------

    /// @notice The factory that created this registry.
    address public factory;
    /// @notice The account that may accept ownership (two-step transfer), or zero.
    address public pendingOwner;
    /// @notice Number of operators currently authorized.
    uint256 public operatorCount;

    mapping(address => bool) private _registryOperators;
    /// @dev signer => word index => bitmap of used nonces (unordered nonces).
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;
    /// @dev keccak256(docId, part) => recorded.
    mapping(bytes32 => bool) private _recordedParts;
    /// @dev docId => at least one part recorded.
    mapping(bytes32 => bool) private _recordedDocs;
    /// @dev Set only while `syncHolders` moves tokens.
    bool private _syncing;

    // ---------------------------------------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------------------------------------

    event OperatorChanged(address indexed operator, bool enabled);
    event DocumentRecorded(
        bytes32 indexed docId,
        uint16 part,
        uint16 parts,
        address indexed signer,
        bytes32 indexed corrects,
        bytes document
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    error SignatureExpired(uint256 deadline);
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error InvalidSignature(address signer);
    error NotAuthorized(address signer);
    error InvalidDocument();
    error DocumentPartAlreadyRecorded(bytes32 docId, uint16 part);
    error CorrectedDocumentUnknown(bytes32 docId);
    error UnknownCylinder(bytes32 tokenId);
    error DataKeyNotAllowed(bytes32 dataKey);
    error StaleValue(bytes32 tokenId, bytes32 dataKey, bytes32 expectedHash, bytes32 currentHash);
    error InvalidOperator(address operator);
    error OperatorUnchanged(address operator, bool enabled);
    error NotPendingOwner(address account);
    error TransfersDisabled();
    error RenounceDisabled();

    // ---------------------------------------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------------------------------------

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory on a fresh clone.
    /// @param initialDataKeys ERC725Y data written at creation (for example the wrapped data key slots).
    function initialize(
        string memory name_,
        string memory symbol_,
        address owner_,
        bytes32[] memory initialDataKeys,
        bytes[] memory initialDataValues
    ) external initializer {
        LSP8IdentifiableDigitalAssetInitAbstract._initialize(
            name_,
            symbol_,
            owner_,
            _LSP4_TOKEN_TYPE_COLLECTION,
            _LSP8_TOKENID_FORMAT_UNIQUE_ID
        );
        __EIP712_init("GasCylinderRegistry", "1");
        factory = msg.sender;
        if (initialDataKeys.length != initialDataValues.length) revert InvalidDocument();
        for (uint256 i; i < initialDataKeys.length; ++i) {
            _setData(initialDataKeys[i], initialDataValues[i]);
        }
    }

    // ---------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------

    function isOperator(address account) public view returns (bool) {
        return _registryOperators[account];
    }

    /// @notice True for the owner and for authorized operators: who may record documents.
    function isAuthorized(address account) public view returns (bool) {
        return account == owner() || _registryOperators[account];
    }

    function isNonceUsed(address signer, uint256 nonce) public view returns (bool) {
        return _nonceBitmap[signer][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function isDocumentRecorded(bytes32 docId) external view returns (bool) {
        return _recordedDocs[docId];
    }

    function isDocumentPartRecorded(bytes32 docId, uint16 part) external view returns (bool) {
        return _recordedParts[keccak256(abi.encode(docId, part))];
    }

    /// @notice The EIP-712 domain separator (name "GasCylinderRegistry", version "1", this chain, this contract).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The hash an operator signs (inside `RecordDocument`) for a payload.
    function hashPayload(DocumentPayload calldata payload) public pure returns (bytes32) {
        return keccak256(abi.encode(payload));
    }

    // ---------------------------------------------------------------------------------------------------
    // Documents (owner or operator)
    // ---------------------------------------------------------------------------------------------------

    /// @notice Records one part of a document: mints the new cylinders to the owner, applies the data
    /// updates (each only if the value has not changed since the signer read it) and emits the document.
    /// Anyone may submit it; `signer` must be the owner or an operator and must have signed it.
    function recordDocument(
        DocumentPayload calldata payload,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(RECORD_DOCUMENT_TYPEHASH, signer, hashPayload(payload), nonce, deadline)
        );
        _useSignature(signer, structHash, nonce, deadline, signature);
        if (!isAuthorized(signer)) revert NotAuthorized(signer);

        if (payload.docId == bytes32(0) || payload.parts == 0 || payload.part >= payload.parts) {
            revert InvalidDocument();
        }
        bytes32 partKey = keccak256(abi.encode(payload.docId, payload.part));
        if (_recordedParts[partKey]) revert DocumentPartAlreadyRecorded(payload.docId, payload.part);
        if (payload.corrects != bytes32(0)) {
            if (payload.corrects == payload.docId || !_recordedDocs[payload.corrects]) {
                revert CorrectedDocumentUnknown(payload.corrects);
            }
        }
        _recordedParts[partKey] = true;
        _recordedDocs[payload.docId] = true;

        address holder = owner();
        for (uint256 i; i < payload.mints.length; ++i) {
            _mint(holder, payload.mints[i], true, "");
        }

        for (uint256 i; i < payload.updates.length; ++i) {
            TokenDataUpdate calldata u = payload.updates[i];
            if (u.dataKey != INFO_KEY && u.dataKey != STATE_KEY) revert DataKeyNotAllowed(u.dataKey);
            if (!_exists(u.tokenId)) revert UnknownCylinder(u.tokenId);
            bytes32 currentHash = keccak256(_getDataForTokenId(u.tokenId, u.dataKey));
            if (currentHash != u.expectedHash) {
                revert StaleValue(u.tokenId, u.dataKey, u.expectedHash, currentHash);
            }
            _setDataForTokenId(u.tokenId, u.dataKey, u.newValue);
        }

        emit DocumentRecorded(
            payload.docId,
            payload.part,
            payload.parts,
            signer,
            payload.corrects,
            payload.document
        );
    }

    // ---------------------------------------------------------------------------------------------------
    // Owner operations, signed
    // ---------------------------------------------------------------------------------------------------

    /// @notice Authorizes or revokes an operator (a driver's phone), signed by the owner.
    function setOperatorSigned(
        address operator,
        bool enabled,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(abi.encode(SET_OPERATOR_TYPEHASH, operator, enabled, nonce, deadline));
        _useSignature(owner(), structHash, nonce, deadline, signature);
        _setOperator(operator, enabled);
    }

    /// @notice Writes ERC725Y data of the registry (wrapped data key, counterparties, LSP4 metadata),
    /// signed by the owner. The LSP4 name, symbol and token type and the LSP8 token ID format stay
    /// read-only, as in LSP8.
    function setDataSigned(
        bytes32[] calldata dataKeys,
        bytes[] calldata dataValues,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(
                SET_DATA_TYPEHASH,
                keccak256(abi.encodePacked(dataKeys)),
                keccak256(abi.encode(dataValues)),
                nonce,
                deadline
            )
        );
        _useSignature(owner(), structHash, nonce, deadline, signature);
        if (dataKeys.length == 0 || dataKeys.length != dataValues.length) revert InvalidDocument();
        for (uint256 i; i < dataKeys.length; ++i) {
            _setData(dataKeys[i], dataValues[i]);
        }
    }

    /// @notice Starts an ownership transfer, signed by the owner; `newOwner` must accept.
    function transferOwnershipSigned(
        address newOwner,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(abi.encode(TRANSFER_OWNERSHIP_TYPEHASH, newOwner, nonce, deadline));
        _useSignature(owner(), structHash, nonce, deadline, signature);
        _startOwnershipTransfer(newOwner);
    }

    /// @notice Completes an ownership transfer, signed by the pending owner.
    function acceptOwnershipSigned(uint256 nonce, uint256 deadline, bytes calldata signature) external {
        address newOwner = pendingOwner;
        if (newOwner == address(0)) revert NotPendingOwner(address(0));
        bytes32 structHash = keccak256(abi.encode(ACCEPT_OWNERSHIP_TYPEHASH, newOwner, nonce, deadline));
        _useSignature(newOwner, structHash, nonce, deadline, signature);
        _acceptOwnership(newOwner);
    }

    // ---------------------------------------------------------------------------------------------------
    // Owner operations, direct (for an owner who pays its own gas)
    // ---------------------------------------------------------------------------------------------------

    function setOperator(address operator, bool enabled) external onlyOwner {
        _setOperator(operator, enabled);
    }

    /// @notice Two-step: sets `pendingOwner`, which must call `acceptOwnership`.
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _startOwnershipTransfer(newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner(msg.sender);
        _acceptOwnership(msg.sender);
    }

    /// @notice Disabled: a registry without an owner could never be administered again.
    function renounceOwnership() public virtual override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------------
    // Tokens
    // ---------------------------------------------------------------------------------------------------

    /// @notice Moves the given cylinders to the current owner if another account holds them (after an
    /// ownership change). Anyone may call it: it can only move tokens to the owner.
    function syncHolders(bytes32[] calldata tokenIds) external {
        address holder = owner();
        _syncing = true;
        for (uint256 i; i < tokenIds.length; ++i) {
            address current = tokenOwnerOf(tokenIds[i]);
            if (current != holder) {
                _transfer(current, holder, tokenIds[i], true, "");
            }
        }
        _syncing = false;
    }

    /// @dev Only minting and `syncHolders` move tokens.
    function _beforeTokenTransfer(
        address from,
        address to,
        bytes32 tokenId,
        bool force,
        bytes memory data
    ) internal virtual override {
        // Outside minting, tokens move only inside `syncHolders` and only to the owner: an account notified
        // during the sync (LSP1) cannot use the window to send tokens anywhere else.
        if (from != address(0) && (!_syncing || to != owner())) revert TransfersDisabled();
        super._beforeTokenTransfer(from, to, tokenId, force, data);
    }

    // ---------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------

    function _useSignature(
        address signer,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        uint256 word = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        if (_nonceBitmap[signer][word] & bit != 0) revert NonceAlreadyUsed(signer, nonce);
        _nonceBitmap[signer][word] |= bit;
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature(signer);
    }

    function _setOperator(address operator, bool enabled) internal {
        if (operator == address(0) || operator == address(this)) revert InvalidOperator(operator);
        if (_registryOperators[operator] == enabled) revert OperatorUnchanged(operator, enabled);
        _registryOperators[operator] = enabled;
        if (enabled) {
            ++operatorCount;
        } else {
            --operatorCount;
        }
        emit OperatorChanged(operator, enabled);
    }

    function _startOwnershipTransfer(address newOwner) internal {
        if (newOwner == address(0) || newOwner == owner()) revert NotPendingOwner(newOwner);
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    function _acceptOwnership(address newOwner) internal {
        pendingOwner = address(0);
        _transferOwnership(newOwner);
    }
}
