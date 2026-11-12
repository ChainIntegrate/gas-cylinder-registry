"use strict";
// EIP-712 types and payload encoding of GasCylinderRegistry's signed operations.
// Shared by the tests, the owner scripts, the relayer and the app: they must hash exactly as the contract.

const { AbiCoder, keccak256, id, TypedDataEncoder } = require("ethers");

const DOMAIN_NAME = "GasCylinderRegistry";
const DOMAIN_VERSION = "1";

const INFO_KEY = id("GCRInfo");
const STATE_KEY = id("GCRState");
const EMPTY_HASH = keccak256("0x");

const TYPES = {
  RecordDocument: [
    { name: "signer", type: "address" },
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetOperator: [
    { name: "operator", type: "address" },
    { name: "enabled", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetData: [
    { name: "dataKeys", type: "bytes32[]" },
    { name: "dataValuesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TransferOwnership: [
    { name: "newOwner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  AcceptOwnership: [
    { name: "newOwner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const PAYLOAD_TUPLE =
  "tuple(bytes32 docId,uint16 part,uint16 parts,bytes32 corrects,bytes32[] mints," +
  "tuple(bytes32 tokenId,bytes32 dataKey,bytes32 expectedHash,bytes newValue)[] updates,bytes document)";

function domain(registry, chainId) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: registry };
}

/** keccak256(abi.encode(payload)), as GasCylinderRegistry.hashPayload. */
function hashPayload(payload) {
  return keccak256(AbiCoder.defaultAbiCoder().encode([PAYLOAD_TUPLE], [payload]));
}

/** The EIP-712 digest a signer signs for one document part. */
function recordDocumentDigest(registry, chainId, signer, payload, nonce, deadline) {
  return TypedDataEncoder.hash(domain(registry, chainId), { RecordDocument: TYPES.RecordDocument }, {
    signer,
    payloadHash: hashPayload(payload),
    nonce,
    deadline,
  });
}

/** keccak256(abi.encode(bytes[])), the dataValuesHash of SetData. */
function hashDataValues(values) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes[]"], [values]));
}

/** A random 256-bit nonce: nonces are unordered, so queued operations need no sequence. */
function randomNonce() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
}

module.exports = {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  INFO_KEY,
  STATE_KEY,
  EMPTY_HASH,
  TYPES,
  PAYLOAD_TUPLE,
  domain,
  hashPayload,
  recordDocumentDigest,
  hashDataValues,
  randomNonce,
};
