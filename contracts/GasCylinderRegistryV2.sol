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
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev The two reads the registry makes on a contract owner (a Universal Profile): its keys' permissions
/// (ERC725Y, LSP6) and its direct owner (ERC173).
interface IOwnerAccount {
    function getData(bytes32 dataKey) external view returns (bytes memory);

    function owner() external view returns (address);
}

/// @title GasCylinderRegistryV2
/// @notice One company's register of technical gas cylinders: one LSP8 token per cylinder. Version 2, with
/// the contract changes of the external review of November 2026 (docs/security-review-2026-11.md):
///
/// - A01 / X-01: when the owner is a contract account (a Universal Profile with an LSP6 Key Manager), its
///   signatures are accepted only from a key with administrator permissions on the account
///   (EDITPERMISSIONS, as the ChainIntegrate Account extension 0.6.0 defines an administrator), read
///   from the account. Every owner operation is signed: the direct `onlyOwner` paths are closed.
/// - Ownership transfer waits `OWNERSHIP_DELAY` (3 days) after it starts, and the owner can cancel it.
/// - A06: a phone (operator) writes a cylinder's information only when it registers the cylinder; a
///   correction of registered information is the owner's.
/// - A11: a document's parts share a manifest, a signer and a number of parts, fixed by its first part;
///   `documentStatus` tells a complete document from an interrupted one.
/// - G-07: every signature carries `validFrom` and `deadline`, at most `MAX_VALIDITY` (7 days) apart, and
///   unsent signatures can be cancelled by their nonce.
/// - A05 (a replaceable data key) needs no contract change: the key wraps of each epoch are owner data
///   (`setDataSigned`).
///
/// Token IDs are opaque (an HMAC of the serial number made off-chain); cylinder data, counterparties and
/// the wrapped data keys are stored encrypted; the contract only stores and compares bytes. Tokens always
/// belong to the owner and cannot be transferred. Deployed as EIP-1167 clones by
/// `GasCylinderRegistryFactoryV2`; not upgradeable.
contract GasCylinderRegistryV2 is LSP8IdentifiableDigitalAssetInitAbstract, EIP712Upgradeable {
    // ---------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------

    uint256 public constant VERSION = 2;

    /// @notice Per-token data key of the encrypted cylinder information (serial, gas, capacity, ownership).
    bytes32 public constant INFO_KEY = keccak256("GCRInfo");
    /// @notice Per-token data key of the encrypted cylinder state (location, condition, last movement).
    bytes32 public constant STATE_KEY = keccak256("GCRState");
    /// @notice `keccak256("")`: the expected hash of a value that was never written.
    bytes32 public constant EMPTY_HASH = keccak256("");

    /// @notice The longest a signature may be valid: `deadline - validFrom`.
    uint256 public constant MAX_VALIDITY = 7 days;
    /// @notice How far in the future `validFrom` may be when a signature is used (signers' clocks).
    uint256 public constant MAX_CLOCK_SKEW = 1 hours;
    /// @notice The wait between the start of an ownership transfer and its acceptance.
    uint256 public constant OWNERSHIP_DELAY = 3 days;

    /// @notice LSP6 `AddressPermissions:Permissions:<address>` prefix (bytes10, then bytes2 zero, address).
    bytes10 public constant PERMISSIONS_PREFIX = 0x4b80742de2bf82acb363;
    /// @notice LSP6 EDITPERMISSIONS: the permission that makes a key an administrator of its account.
    uint256 public constant ADMIN_PERMISSION = 0x4;

    bytes32 public constant RECORD_DOCUMENT_TYPEHASH =
        keccak256(
            "RecordDocument(address signer,bytes32 payloadHash,uint256 nonce,uint256 validFrom,uint256 deadline)"
        );
    bytes32 public constant SET_OPERATOR_TYPEHASH =
        keccak256("SetOperator(address operator,bool enabled,uint256 nonce,uint256 validFrom,uint256 deadline)");
    bytes32 public constant SET_DATA_TYPEHASH =
        keccak256(
            "SetData(bytes32[] dataKeys,bytes32 dataValuesHash,uint256 nonce,uint256 validFrom,uint256 deadline)"
        );
    bytes32 public constant TRANSFER_OWNERSHIP_TYPEHASH =
        keccak256("TransferOwnership(address newOwner,uint256 nonce,uint256 validFrom,uint256 deadline)");
    bytes32 public constant CANCEL_OWNERSHIP_TRANSFER_TYPEHASH =
        keccak256("CancelOwnershipTransfer(address pendingOwner,uint256 nonce,uint256 validFrom,uint256 deadline)");
    bytes32 public constant ACCEPT_OWNERSHIP_TYPEHASH =
        keccak256("AcceptOwnership(address newOwner,uint256 nonce,uint256 validFrom,uint256 deadline)");
    bytes32 public constant CANCEL_NONCES_TYPEHASH =
        keccak256(
            "CancelNonces(address signer,uint256[] nonces,uint256 nonce,uint256 validFrom,uint256 deadline)"
        );

    // ---------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------

    /// @notice The validity and the replay protection every signature carries.
    struct Validity {
        uint256 nonce;
        uint256 validFrom;
        uint256 deadline;
    }

    /// @notice A write of one cylinder's `GCRInfo` or `GCRState`, applied only if the current value still
    /// hashes to `expectedHash` (`EMPTY_HASH` for a value never written).
    struct TokenDataUpdate {
        bytes32 tokenId;
        bytes32 dataKey;
        bytes32 expectedHash;
        bytes newValue;
    }

    /// @notice One part of a document (a delivery note, a stock count, a refill note, a correction).
    /// `manifest` (not zero) is the same in every part of a document: the signer's commitment to the whole
    /// document (DESIGN.md: the hash of the document ID, the number of parts and every part's hash);
    /// `document` is the encrypted document (may be empty in all parts but one); `corrects` is the id of an
    /// earlier document this one corrects, or zero.
    struct DocumentPayload {
        bytes32 docId;
        uint16 part;
        uint16 parts;
        bytes32 manifest;
        bytes32 corrects;
        bytes32[] mints;
        TokenDataUpdate[] updates;
        bytes document;
    }

    /// @notice What the first recorded part of a document fixed, and how many parts are recorded.
    struct DocumentStatus {
        address signer;
        uint16 parts;
        uint16 recorded;
        bytes32 manifest;
    }

    // ---------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------

    /// @notice The factory that created this registry.
    address public factory;
    /// @notice The account that may accept ownership once `ownershipTransferReadyAt`, or zero.
    address public pendingOwner;
    /// @notice When the pending ownership transfer may be accepted (zero when none).
    uint256 public ownershipTransferReadyAt;
    /// @notice Number of operators currently authorized.
    uint256 public operatorCount;

    mapping(address => bool) private _registryOperators;
    /// @dev signer => word index => bitmap of used nonces (unordered nonces).
    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;
    /// @dev keccak256(docId, part) => recorded.
    mapping(bytes32 => bool) private _recordedParts;
    mapping(bytes32 => DocumentStatus) private _documents;
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
        bytes32 manifest,
        bytes document
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner, uint256 readyAt);
    event OwnershipTransferCancelled(address indexed owner, address indexed pendingOwner);
    event NoncesCancelled(address indexed signer, address indexed by, uint256[] nonces);

    error SignatureExpired(uint256 deadline);
    error SignatureNotYetValid(uint256 validFrom);
    error ValidityTooLong(uint256 validFrom, uint256 deadline);
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error InvalidSignature(address signer);
    error NotAdministrator(address account, address key);
    error NotAuthorized(address signer);
    error InvalidDocument();
    error DocumentMismatch(bytes32 docId);
    error DocumentPartAlreadyRecorded(bytes32 docId, uint16 part);
    error CorrectedDocumentUnknown(bytes32 docId);
    error UnknownCylinder(bytes32 tokenId);
    error DataKeyNotAllowed(bytes32 dataKey);
    error InfoAlreadyRegistered(bytes32 tokenId);
    error StaleValue(bytes32 tokenId, bytes32 dataKey, bytes32 expectedHash, bytes32 currentHash);
    error InvalidOperator(address operator);
    error OperatorUnchanged(address operator, bool enabled);
    error NotPendingOwner(address account);
    error OwnershipTransferNotReady(uint256 readyAt);
    error NoOwnershipTransfer();
    error UseSignedOperation();
    error TransfersDisabled();
    error RenounceDisabled();

    // ---------------------------------------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------------------------------------

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory on a fresh clone. The registry starts without data: the owner
    /// writes the data key's wraps at the first sign-in (review X-02).
    function initialize(string memory name_, string memory symbol_, address owner_) external initializer {
        LSP8IdentifiableDigitalAssetInitAbstract._initialize(
            name_,
            symbol_,
            owner_,
            _LSP4_TOKEN_TYPE_COLLECTION,
            _LSP8_TOKENID_FORMAT_UNIQUE_ID
        );
        __EIP712_init("GasCylinderRegistry", "2");
        factory = msg.sender;
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

    function isDocumentRecorded(bytes32 docId) public view returns (bool) {
        return _documents[docId].recorded != 0;
    }

    function isDocumentPartRecorded(bytes32 docId, uint16 part) external view returns (bool) {
        return _recordedParts[keccak256(abi.encode(docId, part))];
    }

    /// @notice A document's signer, number of parts, parts recorded and manifest (all zero if unknown).
    /// `recorded < parts` is an interrupted document.
    function documentStatus(bytes32 docId) external view returns (DocumentStatus memory) {
        return _documents[docId];
    }

    /// @notice True if `key` signs for `account` as an administrator: `account` itself (a key), or a key
    /// with EDITPERMISSIONS on it, or its direct owner (a Universal Profile owned by a key).
    function isAdministrator(address account, address key) public view returns (bool) {
        if (key == address(0)) return false;
        if (account.code.length == 0) return key == account;
        try IOwnerAccount(account).getData(bytes32(abi.encodePacked(PERMISSIONS_PREFIX, bytes2(0), key))) returns (
            bytes memory permissions
        ) {
            if (permissions.length == 32 && uint256(bytes32(permissions)) & ADMIN_PERMISSION != 0) return true;
        } catch {}
        try IOwnerAccount(account).owner() returns (address direct) {
            return direct == key;
        } catch {
            return false;
        }
    }

    /// @notice The EIP-712 domain separator (name "GasCylinderRegistry", version "2", this chain, this contract).
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
    /// Anyone may submit it; `signer` must be the owner (an administrator key of it) or an operator.
    function recordDocument(
        DocumentPayload calldata payload,
        address signer,
        Validity calldata validity,
        bytes calldata signature
    ) external {
        bool byOwner = signer == owner();
        if (!byOwner && !_registryOperators[signer]) revert NotAuthorized(signer);
        _useSignature(
            signer,
            keccak256(
                abi.encode(
                    RECORD_DOCUMENT_TYPEHASH,
                    signer,
                    hashPayload(payload),
                    validity.nonce,
                    validity.validFrom,
                    validity.deadline
                )
            ),
            validity,
            signature,
            byOwner
        );

        _recordPart(payload, signer);

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
            // A06: a phone registers a cylinder's information once; correcting it is the owner's.
            if (u.dataKey == INFO_KEY && currentHash != EMPTY_HASH && !byOwner) revert InfoAlreadyRegistered(u.tokenId);
            _setDataForTokenId(u.tokenId, u.dataKey, u.newValue);
        }

        emit DocumentRecorded(
            payload.docId,
            payload.part,
            payload.parts,
            signer,
            payload.corrects,
            payload.manifest,
            payload.document
        );
    }

    // ---------------------------------------------------------------------------------------------------
    // Owner operations, signed by an administrator key of the owner
    // ---------------------------------------------------------------------------------------------------

    /// @notice Authorizes or revokes an operator (a driver's phone).
    function setOperatorSigned(
        address operator,
        bool enabled,
        Validity calldata validity,
        bytes calldata signature
    ) external {
        _useSignature(
            owner(),
            keccak256(
                abi.encode(SET_OPERATOR_TYPEHASH, operator, enabled, validity.nonce, validity.validFrom, validity.deadline)
            ),
            validity,
            signature,
            true
        );
        _setOperator(operator, enabled);
    }

    /// @notice Writes ERC725Y data of the registry (the data key's wraps, counterparties, settings, LSP4
    /// metadata). The LSP4 name, symbol and token type and the LSP8 token ID format stay read-only.
    function setDataSigned(
        bytes32[] calldata dataKeys,
        bytes[] calldata dataValues,
        Validity calldata validity,
        bytes calldata signature
    ) external {
        _useSignature(
            owner(),
            keccak256(
                abi.encode(
                    SET_DATA_TYPEHASH,
                    keccak256(abi.encodePacked(dataKeys)),
                    keccak256(abi.encode(dataValues)),
                    validity.nonce,
                    validity.validFrom,
                    validity.deadline
                )
            ),
            validity,
            signature,
            true
        );
        if (dataKeys.length == 0 || dataKeys.length != dataValues.length) revert InvalidDocument();
        for (uint256 i; i < dataKeys.length; ++i) {
            _setData(dataKeys[i], dataValues[i]);
        }
    }

    /// @notice Starts an ownership transfer; `newOwner` may accept it after `OWNERSHIP_DELAY`. Starting
    /// another one replaces it and starts the wait again.
    function transferOwnershipSigned(address newOwner, Validity calldata validity, bytes calldata signature) external {
        _useSignature(
            owner(),
            keccak256(
                abi.encode(TRANSFER_OWNERSHIP_TYPEHASH, newOwner, validity.nonce, validity.validFrom, validity.deadline)
            ),
            validity,
            signature,
            true
        );
        if (newOwner == address(0) || newOwner == owner()) revert NotPendingOwner(newOwner);
        pendingOwner = newOwner;
        ownershipTransferReadyAt = block.timestamp + OWNERSHIP_DELAY;
        emit OwnershipTransferStarted(owner(), newOwner, ownershipTransferReadyAt);
    }

    /// @notice Cancels the pending ownership transfer to `pendingOwner_`.
    function cancelOwnershipTransferSigned(
        address pendingOwner_,
        Validity calldata validity,
        bytes calldata signature
    ) external {
        _useSignature(
            owner(),
            keccak256(
                abi.encode(
                    CANCEL_OWNERSHIP_TRANSFER_TYPEHASH,
                    pendingOwner_,
                    validity.nonce,
                    validity.validFrom,
                    validity.deadline
                )
            ),
            validity,
            signature,
            true
        );
        if (pendingOwner == address(0) || pendingOwner != pendingOwner_) revert NoOwnershipTransfer();
        _clearPendingOwner();
        emit OwnershipTransferCancelled(owner(), pendingOwner_);
    }

    /// @notice Completes an ownership transfer, signed by an administrator key of the pending owner, once
    /// `ownershipTransferReadyAt` has passed.
    function acceptOwnershipSigned(Validity calldata validity, bytes calldata signature) external {
        address newOwner = pendingOwner;
        if (newOwner == address(0)) revert NoOwnershipTransfer();
        if (block.timestamp < ownershipTransferReadyAt) revert OwnershipTransferNotReady(ownershipTransferReadyAt);
        _useSignature(
            newOwner,
            keccak256(
                abi.encode(ACCEPT_OWNERSHIP_TYPEHASH, newOwner, validity.nonce, validity.validFrom, validity.deadline)
            ),
            validity,
            signature,
            true
        );
        _clearPendingOwner();
        _transferOwnership(newOwner);
    }

    /// @notice Cancels unsent signatures of `signer` by their nonces. Signed by `signer` itself (a phone
    /// cancelling its own), or by the owner for any signer.
    function cancelNoncesSigned(
        address signer,
        uint256[] calldata nonces,
        address by,
        Validity calldata validity,
        bytes calldata signature
    ) external {
        bool byOwner = by == owner();
        if (by != signer && !byOwner) revert NotAuthorized(by);
        _useSignature(
            by,
            keccak256(
                abi.encode(
                    CANCEL_NONCES_TYPEHASH,
                    signer,
                    keccak256(abi.encodePacked(nonces)),
                    validity.nonce,
                    validity.validFrom,
                    validity.deadline
                )
            ),
            validity,
            signature,
            byOwner
        );
        for (uint256 i; i < nonces.length; ++i) {
            _nonceBitmap[signer][nonces[i] >> 8] |= 1 << (nonces[i] & 0xff);
        }
        emit NoncesCancelled(signer, by, nonces);
    }

    // ---------------------------------------------------------------------------------------------------
    // Direct owner paths: closed (every owner operation is signed and checked, review A01)
    // ---------------------------------------------------------------------------------------------------

    function setData(bytes32, bytes memory) public payable virtual override {
        revert UseSignedOperation();
    }

    function setDataBatch(bytes32[] memory, bytes[] memory) public payable virtual override {
        revert UseSignedOperation();
    }

    function setDataForTokenId(bytes32, bytes32, bytes memory) public virtual override {
        revert UseSignedOperation();
    }

    function setDataBatchForTokenIds(bytes32[] memory, bytes32[] memory, bytes[] memory) public virtual override {
        revert UseSignedOperation();
    }

    function transferOwnership(address) public virtual override {
        revert UseSignedOperation();
    }

    /// @notice Disabled: a registry without an owner could never be administered again.
    function renounceOwnership() public virtual override {
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
        if (from != address(0) && (!_syncing || to != owner())) revert TransfersDisabled();
        super._beforeTokenTransfer(from, to, tokenId, force, data);
    }

    // ---------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------

    /// @dev Checks the validity window, uses the nonce and checks the signature (ERC-1271 for contract
    /// accounts); `admin`: for a contract account, the key that signed must be an administrator of it.
    function _useSignature(
        address signer,
        bytes32 structHash,
        Validity calldata validity,
        bytes calldata signature,
        bool admin
    ) internal {
        if (block.timestamp > validity.deadline) revert SignatureExpired(validity.deadline);
        if (validity.validFrom > block.timestamp + MAX_CLOCK_SKEW) revert SignatureNotYetValid(validity.validFrom);
        if (validity.deadline > validity.validFrom + MAX_VALIDITY) {
            revert ValidityTooLong(validity.validFrom, validity.deadline);
        }
        uint256 word = validity.nonce >> 8;
        uint256 bit = 1 << (validity.nonce & 0xff);
        if (_nonceBitmap[signer][word] & bit != 0) revert NonceAlreadyUsed(signer, validity.nonce);
        _nonceBitmap[signer][word] |= bit;
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) revert InvalidSignature(signer);
        if (admin && signer.code.length != 0) {
            (address key, ECDSA.RecoverError err) = ECDSA.tryRecover(digest, signature);
            if (err != ECDSA.RecoverError.NoError || !isAdministrator(signer, key)) revert NotAdministrator(signer, key);
        }
    }

    /// @dev A11: the first recorded part fixes the document's signer, parts and manifest; the others match.
    function _recordPart(DocumentPayload calldata payload, address signer) internal {
        if (
            payload.docId == bytes32(0) ||
            payload.manifest == bytes32(0) ||
            payload.parts == 0 ||
            payload.part >= payload.parts
        ) revert InvalidDocument();
        bytes32 partKey = keccak256(abi.encode(payload.docId, payload.part));
        if (_recordedParts[partKey]) revert DocumentPartAlreadyRecorded(payload.docId, payload.part);
        if (payload.corrects != bytes32(0)) {
            if (payload.corrects == payload.docId || !isDocumentRecorded(payload.corrects)) {
                revert CorrectedDocumentUnknown(payload.corrects);
            }
        }
        DocumentStatus storage d = _documents[payload.docId];
        if (d.recorded == 0) {
            d.signer = signer;
            d.parts = payload.parts;
            d.manifest = payload.manifest;
        } else if (d.signer != signer || d.parts != payload.parts || d.manifest != payload.manifest) {
            revert DocumentMismatch(payload.docId);
        }
        ++d.recorded;
        _recordedParts[partKey] = true;
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

    function _clearPendingOwner() internal {
        pendingOwner = address(0);
        ownershipTransferReadyAt = 0;
    }
}
