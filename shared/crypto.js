"use strict";
// Encryption, key wrapping and identifiers of GasCylinderRegistry (format version 1).
//
// Works wherever WebCrypto is available: Node.js 20+, browsers, the Android WebView of the app.
// Every function that touches keys is async. Byte values are 0x-prefixed hex strings at the edges
// (what the contract stores) and Uint8Array inside.
//
// Keys
//   DEK      32 random bytes per registry (the data key).
//   encKey   HKDF-SHA256(DEK, salt = registry address, info = "GCR v1 enc")  -> AES-256-GCM
//   idKey    HKDF-SHA256(DEK, salt = registry address, info = "GCR v1 id")   -> HMAC-SHA256
//
// Encrypted value  = 0x01 | IV (12) | AES-GCM ciphertext + tag (16)
//   plaintext      = uint16 length (big endian) | UTF-8 JSON | zero padding to a size bucket
//                    (info and state: always 192 bytes; counterparty: at least 512; others: 64, 128, 256,
//                    512, 1024, then multiples of 1024)
//   associated data = "GCR v1|" + registry (lowercase) + "|" + entry id (lowercase hex) + "|" + field
//
// Key wrap         = 0x01 | kind | ...
//   kind 0x01 password:      iterations uint32 | salt (16) | IV (12) | wrapped DEK (32) + tag (16)
//                            KEK = PBKDF2-SHA256(password NFC, salt, iterations)
//   kind 0x02 recovery code: IV (12) | wrapped DEK (32) + tag (16)
//                            KEK = HKDF-SHA256(code entropy (32), salt = registry, info = "GCR v1 recovery")
//   associated data = "GCR v1|keywrap|" + registry (lowercase) + "|" + kind

const { getBytes, hexlify, concat, toUtf8Bytes, toUtf8String, getAddress, keccak256, id, Mnemonic, wordlists } =
  require("ethers");

const VERSION = 1;
const PBKDF2_ITERATIONS = 600000;
const BUCKETS = [64, 128, 256, 512, 1024];
/**
 * Minimum padded size per field. Every info and state value pads to the same size whatever it holds,
 * so that, for example, a cylinder at the depot (no counterparty id) cannot be told apart from one at
 * a customer by the length of its state.
 */
const MIN_SIZE = { info: 192, state: 192, counterparty: 512, settings: 512 };

/** ERC725Y data key of the registry's encrypted settings (company name, the supplier's e-mails); also its entry id. */
const SETTINGS_DATA_KEY = id("GCRSettings");

const KEY_WRAP_PASSWORD = 0x01;
const KEY_WRAP_RECOVERY = 0x02;

/** ERC725Y data keys of the registry where the wrapped DEK is stored. */
const KEY_WRAP_DATA_KEYS = {
  password: id("GCRKeyWrap:0"),
  recovery: id("GCRKeyWrap:1"),
};

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("WebCrypto is not available");
  return s;
};
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const utf8 = (s) => toUtf8Bytes(s);
const lower = (registry) => getAddress(registry).toLowerCase();

// ------------------------------------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------------------------------------

/** A new random data key (DEK). */
function generateDataKey() {
  return randomBytes(32);
}

async function hkdf(ikm, salt, info, usage) {
  const base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) };
  if (usage === "hmac") {
    return subtle().deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  }
  return subtle().deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, usage);
}

/**
 * The working keys of one registry: `encKey` (AES-256-GCM) and `idKey` (HMAC-SHA256), both
 * non-extractable. `registry` is the registry's address.
 */
async function deriveKeys(dek, registry) {
  const ikm = getBytes(dek);
  if (ikm.length !== 32) throw new Error("the data key must be 32 bytes");
  const salt = getBytes(getAddress(registry));
  return {
    registry: getAddress(registry),
    encKey: await hkdf(ikm, salt, "GCR v1 enc", ["encrypt", "decrypt"]),
    idKey: await hkdf(ikm, salt, "GCR v1 id", "hmac"),
  };
}

// ------------------------------------------------------------------------------------------------
// Identifiers
// ------------------------------------------------------------------------------------------------

const DEFAULT_SERIAL_RULES = { minLength: 3, maxLength: 40, allowed: /^[A-Z0-9\-./]+$/ };

/**
 * The canonical form of a scanned or typed serial number: trimmed, internal spaces removed,
 * uppercase. Throws when the result breaks `rules` (length, allowed characters), so that a misread
 * code never becomes a new cylinder. The rules are a per-registry setting until the labels are known.
 */
function normalizeSerial(raw, rules = DEFAULT_SERIAL_RULES) {
  const s = String(raw).normalize("NFKC").trim().replace(/\s+/g, "").toUpperCase();
  if (s.length < rules.minLength || s.length > rules.maxLength) throw new Error(`invalid serial length: "${s}"`);
  if (!rules.allowed.test(s)) throw new Error(`invalid characters in serial: "${s}"`);
  return s;
}

async function hmac(keys, label) {
  return new Uint8Array(await subtle().sign("HMAC", keys.idKey, utf8(label)));
}

/** The token ID of a cylinder: HMAC(idKey, "cylinder:" + normalized serial), bytes32. */
async function cylinderTokenId(keys, serial, rules) {
  return hexlify(await hmac(keys, "cylinder:" + normalizeSerial(serial, rules)));
}

/** A counterparty's id (bytes20) from its stable internal id (for example a UUID chosen by the owner tools). */
async function counterpartyId(keys, internalId) {
  return hexlify((await hmac(keys, "cp:" + String(internalId))).slice(0, 20));
}

/** The ERC725Y data key of a counterparty: LSP2 Mapping bytes10(keccak256("GCRCounterparty")) + 0x0000 + id. */
function counterpartyDataKey(cpId) {
  const idBytes = getBytes(cpId);
  if (idBytes.length !== 20) throw new Error("a counterparty id is 20 bytes");
  return hexlify(concat([getBytes(keccak256(utf8("GCRCounterparty"))).slice(0, 10), new Uint8Array(2), idBytes]));
}

/** The prefix shared by all counterparty data keys (to find them in `DataChanged` logs). */
const COUNTERPARTY_KEY_PREFIX = hexlify(concat([getBytes(keccak256(utf8("GCRCounterparty"))).slice(0, 10), new Uint8Array(2)]));

/** A document's id: HMAC(idKey, "doc:" + counterparty id + ":" + document number), bytes32. */
async function documentId(keys, cpId, number) {
  const n = String(number).normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  if (!n) throw new Error("empty document number");
  return hexlify(await hmac(keys, "doc:" + hexlify(getBytes(cpId)) + ":" + n));
}

// ------------------------------------------------------------------------------------------------
// Values
// ------------------------------------------------------------------------------------------------

function bucketSize(n, field) {
  const min = MIN_SIZE[field] || 0;
  if (n <= min) return min;
  for (const b of BUCKETS) if (n <= b) return b;
  return Math.ceil(n / 1024) * 1024;
}

function pad(json, field) {
  const body = utf8(json);
  if (body.length > 0xffff) throw new Error("value too large");
  const out = new Uint8Array(bucketSize(body.length + 2, field));
  out[0] = body.length >> 8;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function unpad(bytes) {
  const len = (bytes[0] << 8) | bytes[1];
  if (len + 2 > bytes.length) throw new Error("corrupted value");
  return toUtf8String(bytes.slice(2, 2 + len));
}

function aad(registry, entryId, field) {
  return utf8(`GCR v1|${lower(registry)}|${hexlify(getBytes(entryId)).toLowerCase()}|${field}`);
}

/**
 * Encrypts a JSON-serializable object for one place: `entryId` (a token ID, a counterparty id, a
 * document id) and `field` (for example "info", "state", "counterparty", "document"). A value
 * decrypts only in the place it was written for.
 */
async function encryptValue(keys, entryId, field, obj, iv = randomBytes(12)) {
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: aad(keys.registry, entryId, field) },
    keys.encKey,
    pad(JSON.stringify(obj), field)
  );
  return hexlify(concat([new Uint8Array([VERSION]), iv, new Uint8Array(ct)]));
}

/** Decrypts a value written by `encryptValue` for the same place. Throws if it was altered or moved. */
async function decryptValue(keys, entryId, field, value) {
  const b = getBytes(value);
  if (b.length < 1 + 12 + 16 || b[0] !== VERSION) throw new Error("unknown value format");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: b.slice(1, 13), additionalData: aad(keys.registry, entryId, field) },
    keys.encKey,
    b.slice(13)
  );
  return JSON.parse(unpad(new Uint8Array(pt)));
}

// ------------------------------------------------------------------------------------------------
// Key wraps
// ------------------------------------------------------------------------------------------------

function wrapAad(registry, kind) {
  return utf8(`GCR v1|keywrap|${lower(registry)}|${kind}`);
}

async function aesKey(raw) {
  return subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function passwordKek(password, salt, iterations) {
  const base = await subtle().importKey("raw", utf8(String(password).normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Wraps the DEK with a password (slot "password"). */
async function wrapWithPassword(dek, password, registry, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await passwordKek(password, salt, iterations);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: wrapAad(registry, KEY_WRAP_PASSWORD) }, kek, getBytes(dek));
  const it = new Uint8Array([(iterations >>> 24) & 0xff, (iterations >>> 16) & 0xff, (iterations >>> 8) & 0xff, iterations & 0xff]);
  return hexlify(concat([new Uint8Array([VERSION, KEY_WRAP_PASSWORD]), it, salt, iv, new Uint8Array(ct)]));
}

/** Unwraps the DEK with the password. Throws "wrong password" when it does not match. */
async function unwrapWithPassword(wrap, password, registry) {
  const b = getBytes(wrap);
  if (b.length !== 2 + 4 + 16 + 12 + 48 || b[0] !== VERSION || b[1] !== KEY_WRAP_PASSWORD) throw new Error("not a password key wrap");
  const iterations = ((b[2] << 24) >>> 0) + (b[3] << 16) + (b[4] << 8) + b[5];
  if (iterations < 100000) throw new Error("key wrap iterations too low");
  const kek = await passwordKek(password, b.slice(6, 22), iterations);
  try {
    const dek = await subtle().decrypt(
      { name: "AES-GCM", iv: b.slice(22, 34), additionalData: wrapAad(registry, KEY_WRAP_PASSWORD) },
      kek,
      b.slice(34)
    );
    return new Uint8Array(dek);
  } catch {
    throw new Error("wrong password");
  }
}

/** A new recovery code: 24 words (256 bits) from the BIP-39 list of `language` ("en" or "it"). */
function generateRecoveryCode(language = "en") {
  const list = wordlists[language];
  if (!list) throw new Error(`no word list for "${language}"`);
  return Mnemonic.fromEntropy(randomBytes(32), null, list).phrase;
}

/** The 32 bytes behind a recovery code, in any supported language. Throws if a word or the checksum is wrong. */
function recoveryCodeEntropy(code) {
  const phrase = String(code).normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
  for (const language of ["en", "it"]) {
    const list = wordlists[language];
    if (Mnemonic.isValidMnemonic(phrase, list)) {
      const entropy = getBytes(Mnemonic.fromPhrase(phrase, null, list).entropy);
      if (entropy.length !== 32) throw new Error("a recovery code has 24 words");
      return entropy;
    }
  }
  throw new Error("invalid recovery code");
}

async function recoveryKek(code, registry) {
  const base = await subtle().importKey("raw", recoveryCodeEntropy(code), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: getBytes(getAddress(registry)), info: utf8("GCR v1 recovery") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Wraps the DEK with a recovery code (slot "recovery"). */
async function wrapWithRecoveryCode(dek, code, registry) {
  const iv = randomBytes(12);
  const kek = await recoveryKek(code, registry);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: wrapAad(registry, KEY_WRAP_RECOVERY) }, kek, getBytes(dek));
  return hexlify(concat([new Uint8Array([VERSION, KEY_WRAP_RECOVERY]), iv, new Uint8Array(ct)]));
}

/** Unwraps the DEK with the recovery code. Throws "wrong recovery code" when it does not match. */
async function unwrapWithRecoveryCode(wrap, code, registry) {
  const b = getBytes(wrap);
  if (b.length !== 2 + 12 + 48 || b[0] !== VERSION || b[1] !== KEY_WRAP_RECOVERY) throw new Error("not a recovery key wrap");
  const kek = await recoveryKek(code, registry);
  try {
    const dek = await subtle().decrypt(
      { name: "AES-GCM", iv: b.slice(2, 14), additionalData: wrapAad(registry, KEY_WRAP_RECOVERY) },
      kek,
      b.slice(14)
    );
    return new Uint8Array(dek);
  } catch {
    throw new Error("wrong recovery code");
  }
}

// ------------------------------------------------------------------------------------------------
// Password strength
// ------------------------------------------------------------------------------------------------

/**
 * A minimal check for the data password, which protects data that anyone can copy and attack
 * offline forever. Accepts a passphrase of 20+ characters, or 14+ characters mixing at least three of
 * lowercase, uppercase, digits and symbols. Returns { ok, reason } with reason "too_short",
 * "too_simple" or "repetitive".
 */
function checkPassword(password) {
  const p = String(password);
  if (p.length < 14) return { ok: false, reason: "too_short" };
  if (new Set(p.toLowerCase()).size < 8) return { ok: false, reason: "repetitive" };
  if (p.length >= 20) return { ok: true };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  return classes >= 3 ? { ok: true } : { ok: false, reason: "too_simple" };
}

module.exports = {
  VERSION,
  PBKDF2_ITERATIONS,
  MIN_SIZE,
  KEY_WRAP_DATA_KEYS,
  SETTINGS_DATA_KEY,
  COUNTERPARTY_KEY_PREFIX,
  DEFAULT_SERIAL_RULES,
  generateDataKey,
  deriveKeys,
  normalizeSerial,
  cylinderTokenId,
  counterpartyId,
  counterpartyDataKey,
  documentId,
  encryptValue,
  decryptValue,
  wrapWithPassword,
  unwrapWithPassword,
  generateRecoveryCode,
  recoveryCodeEntropy,
  wrapWithRecoveryCode,
  unwrapWithRecoveryCode,
  checkPassword,
};
