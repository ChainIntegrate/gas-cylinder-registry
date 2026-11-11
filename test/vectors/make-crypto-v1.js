"use strict";
// Writes crypto-v1.json with Node's own crypto module, independently of shared/crypto.js,
// so that the library is checked against a second implementation of the format.
// Run: node test/vectors/make-crypto-v1.js
const c = require("crypto");
const fs = require("fs");
const path = require("path");
const { getAddress, keccak256, toUtf8Bytes } = require("ethers");

const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const registry = getAddress("0x1111111111111111111111111111111111111111");
const regBytes = Buffer.from(registry.slice(2), "hex");
const dek = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const hkdf = (info) => Buffer.from(c.hkdfSync("sha256", dek, regBytes, Buffer.from(info), 32));
const encKey = hkdf("GCR v1 enc");
const idKey = hkdf("GCR v1 id");
const hmac = (s) => c.createHmac("sha256", idKey).update(s).digest();

const serial = "AR-0012345";
const tokenId = hex(hmac("cylinder:" + serial));
const cpId = hex(hmac("cp:demo-customer-1").subarray(0, 20));
const docId = hex(hmac("doc:" + cpId + ":DDT 2026/118"));
const prefix = Buffer.from(keccak256(toUtf8Bytes("GCRCounterparty")).slice(2), "hex").subarray(0, 10);
const cpDataKey = hex(Buffer.concat([prefix, Buffer.alloc(2), Buffer.from(cpId.slice(2), "hex")]));

const info = { v: 1, serial, gas: "argon", capacityL: 40, owner: "supplier", registeredAt: 1767225600 };
const json = Buffer.from(JSON.stringify(info));
const padded = Buffer.alloc(192); // info values always pad to 192 bytes
padded.writeUInt16BE(json.length, 0);
json.copy(padded, 2);
const iv = Buffer.from("a0a1a2a3a4a5a6a7a8a9aaab", "hex");
const cipher = c.createCipheriv("aes-256-gcm", encKey, iv);
cipher.setAAD(Buffer.from(`GCR v1|${registry.toLowerCase()}|${tokenId}|info`));
const ct = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

const out = {
  registry,
  dek: hex(dek),
  serial,
  tokenId,
  counterpartyInternalId: "demo-customer-1",
  counterpartyId: cpId,
  counterpartyDataKey: cpDataKey,
  documentNumber: "DDT 2026/118",
  documentId: docId,
  info,
  infoIv: hex(iv),
  infoEncrypted: hex(Buffer.concat([Buffer.from([1]), iv, ct])),
};
fs.writeFileSync(path.join(__dirname, "crypto-v1.json"), JSON.stringify(out, null, 2) + "\n");
console.log(out);
