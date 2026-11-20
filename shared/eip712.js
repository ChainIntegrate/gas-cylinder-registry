"use strict";
// EIP-712 types and payload encoding of GasCylinderRegistryV2's signed operations (DESIGN.md §6).
// Shared by the tests, the owner scripts, the relayer, the pages and the app: they must hash exactly as the
// contract. Every signature carries a Validity { nonce, validFrom, deadline }: deadline - validFrom at most
// seven days, validFrom at most an hour ahead of the chain's clock.

const { AbiCoder, keccak256, id, TypedDataEncoder, ZeroHash } = require("ethers");

const DOMAIN_NAME = "GasCylinderRegistry";
const DOMAIN_VERSION = "2";
const MAX_VALIDITY = 7 * 86400;

const INFO_KEY = id("GCRInfo");
const STATE_KEY = id("GCRState");
const EMPTY_HASH = keccak256("0x");

const VALIDITY = [
  { name: "nonce", type: "uint256" },
  { name: "validFrom", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const TYPES = {
  RecordDocument: [{ name: "signer", type: "address" }, { name: "payloadHash", type: "bytes32" }, ...VALIDITY],
  SetOperator: [{ name: "operator", type: "address" }, { name: "enabled", type: "bool" }, ...VALIDITY],
  SetData: [{ name: "dataKeys", type: "bytes32[]" }, { name: "dataValuesHash", type: "bytes32" }, ...VALIDITY],
  TransferOwnership: [{ name: "newOwner", type: "address" }, ...VALIDITY],
  CancelOwnershipTransfer: [{ name: "pendingOwner", type: "address" }, ...VALIDITY],
  AcceptOwnership: [{ name: "newOwner", type: "address" }, ...VALIDITY],
  CancelNonces: [{ name: "signer", type: "address" }, { name: "nonces", type: "uint256[]" }, ...VALIDITY],
};

const PAYLOAD_TUPLE =
  "tuple(bytes32 docId,uint16 part,uint16 parts,bytes32 manifest,bytes32 corrects,bytes32[] mints," +
  "tuple(bytes32 tokenId,bytes32 dataKey,bytes32 expectedHash,bytes newValue)[] updates,bytes document)";

function domain(registry, chainId) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: registry };
}

/** keccak256(abi.encode(payload)), as GasCylinderRegistryV2.hashPayload. */
function hashPayload(payload) {
  return keccak256(AbiCoder.defaultAbiCoder().encode([PAYLOAD_TUPLE], [payload]));
}

/**
 * A document's manifest (review A11): keccak256(abi.encode(docId, parts, partHashes)), each part's hash
 * being hashPayload of that part with `manifest` zero. Every part carries it; the contract keeps the first.
 */
function documentManifest(docId, payloads) {
  const hashes = payloads.map((p) => hashPayload({ ...p, manifest: ZeroHash }));
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint16", "bytes32[]"], [docId, payloads.length, hashes]));
}

/** Sets the manifest in every part of a document (all parts built, with `manifest` zero or absent). */
function withManifest(payloads) {
  if (!payloads.length) throw new Error("a document has at least one part");
  const docId = payloads[0].docId;
  payloads.forEach((p, i) => {
    if (p.docId !== docId || p.part !== i || p.parts !== payloads.length) throw new Error("the parts do not make one document");
  });
  const manifest = documentManifest(docId, payloads);
  return payloads.map((p) => ({ ...p, manifest }));
}

/**
 * A signature's validity: from `now` (seconds; a minute earlier, for clocks slightly ahead of the chain's)
 * for `seconds` (at most seven days).
 */
function validity(now, seconds, nonce = randomNonce()) {
  const from = Math.max(0, Math.floor(now) - 60);
  const s = Math.min(Math.floor(seconds) + 60, MAX_VALIDITY);
  return { nonce: BigInt(nonce), validFrom: BigInt(from), deadline: BigInt(from + s) };
}

/** The EIP-712 digest a signer signs for one document part. */
function recordDocumentDigest(registry, chainId, signer, payload, v) {
  return TypedDataEncoder.hash(domain(registry, chainId), { RecordDocument: TYPES.RecordDocument }, {
    signer,
    payloadHash: hashPayload(payload),
    nonce: v.nonce,
    validFrom: v.validFrom,
    deadline: v.deadline,
  });
}

/** The EIP-712 digest of a nonce cancellation signed by `by` (the signer itself, or the owner). */
function cancelNoncesDigest(registry, chainId, signer, nonces, v) {
  return TypedDataEncoder.hash(domain(registry, chainId), { CancelNonces: TYPES.CancelNonces }, {
    signer,
    nonces,
    nonce: v.nonce,
    validFrom: v.validFrom,
    deadline: v.deadline,
  });
}

/** keccak256(abi.encode(bytes[])), the dataValuesHash of SetData. */
function hashDataValues(values) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes[]"], [values]));
}

/** A Validity as the contract's tuple, from strings or numbers (JSON) or BigInts. */
function validityTuple(v) {
  if (!v || typeof v !== "object") throw new Error("validity: missing");
  return { nonce: BigInt(v.nonce), validFrom: BigInt(v.validFrom), deadline: BigInt(v.deadline) };
}

/** A Validity for JSON: decimal strings. */
function validityJson(v) {
  return { nonce: v.nonce.toString(), validFrom: v.validFrom.toString(), deadline: v.deadline.toString() };
}

/** A random 256-bit nonce: nonces are unordered, so queued operations need no sequence. */
function randomNonce() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
}

module.exports = {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  MAX_VALIDITY,
  INFO_KEY,
  STATE_KEY,
  EMPTY_HASH,
  TYPES,
  PAYLOAD_TUPLE,
  domain,
  hashPayload,
  documentManifest,
  withManifest,
  validity,
  validityTuple,
  validityJson,
  recordDocumentDigest,
  cancelNoncesDigest,
  hashDataValues,
  randomNonce,
};
