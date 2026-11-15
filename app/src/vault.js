"use strict";
// What the app keeps on the phone, encrypted (external review A09): the customer list and settings,
// the documents waiting to be sent (with their e-mails) and a document left half-made when the app
// locked. The key is derived from the register's data key (shared/crypto.js deriveKeys: cacheKey), so
// nothing of this can be read before the fingerprint or PIN unlocks the app; it works without network.
//
// Format of a stored value: "gcrv1:" + base64(IV 12 bytes | AES-256-GCM ciphertext and tag), the item's
// name as associated data (a value moved to another name does not open).

const { encodeBase64, decodeBase64, toUtf8Bytes, toUtf8String } = require("ethers");

const PREFIX = "gcrv1:";
const subtle = () => globalThis.crypto.subtle;

async function seal(key, name, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: toUtf8Bytes(name) }, key, toUtf8Bytes(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return PREFIX + encodeBase64(out);
}

async function open(key, name, stored) {
  if (typeof stored !== "string" || !stored.startsWith(PREFIX)) throw new Error("not a sealed value");
  const b = decodeBase64(stored.slice(PREFIX.length));
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: toUtf8Bytes(name) }, key, b.slice(12));
  return toUtf8String(new Uint8Array(pt));
}

/**
 * A localStorage-like store (getItem, setItem, removeItem) kept in memory while the app is unlocked and
 * written, encrypted, to `storage` under "<name>.sealed". `unlock(key)` reads the sealed items back and
 * takes in any plain item left by an older version (then removed); `lock()` forgets the key and the
 * values. Writes are queued in order; `flush()` waits for them.
 */
class Vault {
  constructor(storage, names) {
    this.storage = storage;
    this.names = names;
    this.key = null;
    this.mem = new Map();
    this.queue = Promise.resolve();
  }
  get unlocked() {
    return this.key !== null;
  }
  async unlock(key) {
    this.key = key;
    this.mem.clear();
    for (const name of this.names) {
      const sealed = this.storage.getItem(`${name}.sealed`);
      if (sealed) {
        try {
          this.mem.set(name, await open(key, name, sealed));
        } catch {
          this.storage.removeItem(`${name}.sealed`); // another register's, or damaged: dropped
        }
      }
      const plain = this.storage.getItem(name); // left by a version before 0.2.4
      if (plain !== null) {
        if (!this.mem.has(name)) this.setItem(name, plain);
        this.storage.removeItem(name);
      }
    }
    await this.flush();
  }
  lock() {
    this.key = null;
    this.mem.clear();
  }
  getItem(name) {
    return this.mem.has(name) ? this.mem.get(name) : null;
  }
  setItem(name, value) {
    if (!this.key) throw new Error("the app is locked");
    const key = this.key;
    const text = String(value);
    this.mem.set(name, text);
    this.queue = this.queue.then(async () => this.storage.setItem(`${name}.sealed`, await seal(key, name, text))).catch(() => {});
  }
  removeItem(name) {
    this.mem.delete(name);
    this.queue = this.queue.then(() => this.storage.removeItem(`${name}.sealed`));
  }
  flush() {
    return this.queue;
  }
  /** Removes everything this vault keeps, sealed or plain (a revoked phone). */
  wipe() {
    for (const name of this.names) {
      this.storage.removeItem(name);
      this.storage.removeItem(`${name}.sealed`);
    }
    this.lock();
  }
}

module.exports = { Vault, seal, open };
