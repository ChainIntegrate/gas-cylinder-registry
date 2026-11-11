"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const S = require("../shared");
const V = require("./vectors/crypto-v1.json");

describe("shared library", function () {
  const registry = ethers.getAddress("0x2222222222222222222222222222222222222222");
  let keys;

  before(async function () {
    keys = await S.deriveKeys(S.generateDataKey(), registry);
  });

  describe("format version 1, against an independent implementation (test/vectors)", function () {
    let vk;
    before(async function () {
      vk = await S.deriveKeys(V.dek, V.registry);
    });

    it("derives the same identifiers", async function () {
      expect(await S.cylinderTokenId(vk, V.serial)).to.equal(V.tokenId);
      expect(await S.counterpartyId(vk, V.counterpartyInternalId)).to.equal(V.counterpartyId);
      expect(S.counterpartyDataKey(V.counterpartyId)).to.equal(V.counterpartyDataKey);
      expect(await S.documentId(vk, V.counterpartyId, V.documentNumber)).to.equal(V.documentId);
    });

    it("encrypts to the same bytes and decrypts them", async function () {
      const enc = await S.encryptValue(vk, V.tokenId, "info", V.info, ethers.getBytes(V.infoIv));
      expect(enc).to.equal(V.infoEncrypted);
      expect(await S.decryptValue(vk, V.tokenId, "info", V.infoEncrypted)).to.deep.equal(V.info);
    });
  });

  describe("identifiers", function () {
    it("give the same token ID for the same cylinder however the code is read", async function () {
      const a = await S.cylinderTokenId(keys, "ar-0012345");
      expect(await S.cylinderTokenId(keys, "  AR-0012345 ")).to.equal(a);
      expect(await S.cylinderTokenId(keys, "AR - 0012345")).to.equal(a);
      expect(a).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("differ between registries for the same serial", async function () {
      const other = await S.deriveKeys(S.generateDataKey(), registry);
      expect(await S.cylinderTokenId(keys, "AR-1")).to.not.equal(await S.cylinderTokenId(other, "AR-1"));
    });

    it("refuse serials that cannot be a label", async function () {
      expect(() => S.normalizeSerial("A")).to.throw(/length/);
      expect(() => S.normalizeSerial("AR#12")).to.throw(/characters/);
      expect(S.normalizeSerial("ab/12.3", { minLength: 1, maxLength: 10, allowed: /^[A-Z0-9/.]+$/ })).to.equal("AB/12.3");
    });

    it("map counterparties to LSP2 Mapping keys under one prefix", async function () {
      const id = await S.counterpartyId(keys, "c1");
      const key = S.counterpartyDataKey(id);
      expect(key.length).to.equal(66);
      expect(key.startsWith(S.COUNTERPARTY_KEY_PREFIX)).to.equal(true);
      expect(key.endsWith(id.slice(2))).to.equal(true);
    });
  });

  describe("values", function () {
    const tokenId = ethers.hexlify(ethers.randomBytes(32));
    const state = {
      v: 1,
      location: { type: "customer", id: "0x" + "ab".repeat(20) },
      condition: "full",
      lifecycle: "active",
      movement: "delivery",
      at: 1767225600,
    };

    it("round-trip", async function () {
      const enc = await S.encryptValue(keys, tokenId, "state", state);
      expect(await S.decryptValue(keys, tokenId, "state", enc)).to.deep.equal(state);
    });

    it("never encrypt the same value to the same bytes", async function () {
      const a = await S.encryptValue(keys, tokenId, "state", state);
      const b = await S.encryptValue(keys, tokenId, "state", state);
      expect(a).to.not.equal(b);
    });

    it("hide the length of their content: every state has the same size", async function () {
      const atDepot = await S.encryptValue(keys, tokenId, "state", { ...state, location: { type: "depot" } });
      const atCustomer = await S.encryptValue(keys, tokenId, "state", state);
      const longest = S.validateState({ ...state, condition: "defective", lifecycle: "retired", movement: "from_refill", at: 4102444800 });
      const sizes = [atDepot, atCustomer, await S.encryptValue(keys, tokenId, "state", longest)].map((v) => ethers.getBytes(v).length);
      expect(sizes).to.deep.equal([221, 221, 221]);
      const bigInfo = S.validateInfo({ v: 1, serial: "X".repeat(40), gas: "acetylene", capacityL: 999.9, owner: "0x" + "ab".repeat(20), registeredAt: 4102444800 });
      expect(ethers.getBytes(await S.encryptValue(keys, tokenId, "info", bigInfo)).length).to.equal(221);
      expect(ethers.getBytes(await S.encryptValue(keys, tokenId, "document", { a: 1 })).length).to.equal(1 + 12 + 64 + 16);
    });

    it("do not decrypt when moved to another cylinder, field or registry, or when altered", async function () {
      const enc = await S.encryptValue(keys, tokenId, "state", state);
      const other = ethers.hexlify(ethers.randomBytes(32));
      await expectReject(S.decryptValue(keys, other, "state", enc));
      await expectReject(S.decryptValue(keys, tokenId, "info", enc));
      const elsewhere = await S.deriveKeys(S.generateDataKey(), registry);
      await expectReject(S.decryptValue(elsewhere, tokenId, "state", enc));
      const b = ethers.getBytes(enc);
      b[20] ^= 1;
      await expectReject(S.decryptValue(keys, tokenId, "state", ethers.hexlify(b)));
    });
  });

  describe("key wraps", function () {
    const dek = S.generateDataKey();

    it("unwrap the data key with the password, and only with it", async function () {
      this.timeout(20000);
      const wrap = await S.wrapWithPassword(dek, "una frase lunga per la demo 2026", registry);
      expect(ethers.getBytes(wrap).length).to.equal(82);
      expect(await S.unwrapWithPassword(wrap, "una frase lunga per la demo 2026", registry)).to.deep.equal(dek);
      await expectReject(S.unwrapWithPassword(wrap, "una frase lunga per la demo 2027", registry), /wrong password/);
      // A wrap copied onto another registry does not open there.
      await expectReject(
        S.unwrapWithPassword(wrap, "una frase lunga per la demo 2026", "0x3333333333333333333333333333333333333333"),
        /wrong password/
      );
    });

    it("refuse a wrap with too few iterations", async function () {
      const wrap = await S.wrapWithPassword(dek, "p", registry, 1000);
      await expectReject(S.unwrapWithPassword(wrap, "p", registry), /iterations/);
    });

    it("unwrap the data key with a 24-word recovery code, in English or Italian", async function () {
      for (const language of ["en", "it"]) {
        const code = S.generateRecoveryCode(language);
        expect(code.split(" ").length).to.equal(24);
        const wrap = await S.wrapWithRecoveryCode(dek, code, registry);
        expect(await S.unwrapWithRecoveryCode(wrap, "  " + code.toUpperCase().replace(/ /g, "   ") + " ", registry)).to.deep.equal(dek);
        await expectReject(S.unwrapWithRecoveryCode(wrap, S.generateRecoveryCode(language), registry), /wrong recovery code/);
      }
    });

    it("reject a recovery code with a wrong word or checksum", async function () {
      const words = S.generateRecoveryCode("en").split(" ");
      words[3] = words[3] === "abandon" ? "ability" : "abandon";
      expect(() => S.recoveryCodeEntropy(words.join(" "))).to.throw(/invalid recovery code/);
      expect(() => S.recoveryCodeEntropy("abandon ".repeat(11) + "about")).to.throw(/24 words/);
    });
  });

  describe("password check", function () {
    it("accepts long phrases and mixed passwords, refuses short or simple ones", function () {
      expect(S.checkPassword("le bombole di argon tornano vuote").ok).to.equal(true);
      expect(S.checkPassword("Argonia-Gas-26!").ok).to.equal(true);
      expect(S.checkPassword("Argonia2026").reason).to.equal("too_short");
      expect(S.checkPassword("argoniagastecnici").reason).to.equal("too_simple");
      expect(S.checkPassword("aaaaaaaaaaaaaaaaaaaaaaaa").reason).to.equal("repetitive");
    });
  });

  describe("plaintext formats", function () {
    const cp = "0x" + "12".repeat(20);

    it("keep known fields only", function () {
      const info = S.validateInfo({ v: 1, serial: "AR-1", gas: "argon", owner: "supplier", registeredAt: 1767225600, extra: "x" });
      expect(info).to.deep.equal({ v: 1, serial: "AR-1", gas: "argon", owner: "supplier", registeredAt: 1767225600 });
      expect(S.validateCounterparty({ v: 1, type: "customer", name: " Officina Demo ", emails: ["a@b.it"], vat: "x" })).to.deep.equal({
        v: 1,
        type: "customer",
        name: "Officina Demo",
        emails: ["a@b.it"],
      });
    });

    it("refuse what does not fit", function () {
      expect(() => S.validateInfo({ v: 1, serial: "AR-1", gas: "propane", owner: "supplier", registeredAt: 1767225600 })).to.throw(/gas/);
      expect(() =>
        S.validateState({ v: 1, location: { type: "customer" }, condition: "full", lifecycle: "active", movement: "delivery", at: 1767225600 })
      ).to.throw(/location.id/);
      expect(() => S.validateCounterparty({ v: 1, type: "customer", name: "X", emails: ["not-an-address"] })).to.throw(/e-mail/);
      expect(() => S.validateDocument({ v: 1, kind: "delivery_note", number: "1", date: 1767225600, counterparty: cp, lines: [] })).to.throw(/lines/);
      expect(() => S.validateInfo({ v: 2 })).to.throw(/version/);
    });

    it("require a number for delivery notes, not for stock counts", function () {
      const line = { tokenId: "0x" + "ab".repeat(32), serial: "AR-1", gas: "argon", movement: "stock_count", condition: "empty" };
      expect(S.validateDocument({ v: 1, kind: "stock_count", date: 1767225600, counterparty: cp, lines: [line] }).number).to.equal(undefined);
      expect(() => S.validateDocument({ v: 1, kind: "delivery_note", date: 1767225600, counterparty: cp, lines: [line] })).to.throw(/number/);
    });
  });
});

async function expectReject(promise, pattern) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, "expected a rejection").to.be.instanceOf(Error);
  if (pattern) expect(error.message).to.match(pattern);
}
