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
      const longest = S.validateState({
        ...state,
        condition: "defective",
        lifecycle: "retired",
        movement: "from_refill",
        at: 4102444800,
        test: { last: "2099-12", due: "2100-12" },
      });
      const sizes = [atDepot, atCustomer, await S.encryptValue(keys, tokenId, "state", longest)].map((v) => ethers.getBytes(v).length);
      expect(sizes).to.deep.equal([285, 285, 285]);
      const bigInfo = S.validateInfo({ v: 1, serial: "X".repeat(40), gas: "acetylene", capacityL: 999.9, owner: "0x" + "ab".repeat(20), testYears: 30, registeredAt: 4102444800 });
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
      // A fixed valid code and a fixed wrong word: a random one would still pass the 8-bit checksum
      // once in 256 runs (review Q-01).
      const words = ("abandon ".repeat(23) + "art").split(" ");
      expect(() => S.recoveryCodeEntropy(words.join(" "))).to.not.throw();
      words[3] = "ability";
      expect(() => S.recoveryCodeEntropy(words.join(" "))).to.throw(/invalid recovery code/);
      expect(() => S.recoveryCodeEntropy("abandon ".repeat(11) + "about")).to.throw(/24 words/);
    });
  });

  describe("key epochs (review A05)", function () {
    const registry = "0x00000000000000000000000000000000000000A1";
    const tokenId = ethers.hexlify(ethers.randomBytes(32));
    const state = { v: 1, location: { type: "depot" }, condition: "full", lifecycle: "active", movement: "delivery", at: 1767225600 };

    it("replace the data key: old values still read, new values only with the new key, ids unchanged", async function () {
      const dek0 = S.generateDataKey();
      const k0 = await S.deriveKeys(dek0, registry);
      const old = await S.encryptValue(k0, tokenId, "state", state);
      const id0 = await S.cylinderTokenId(k0, "AR-1");

      const r = await S.replaceDataKey(k0, dek0, "una frase nuova per i dati", "it");
      expect(r.dataKeys).to.deep.equal([S.KEY_WRAP_DATA_KEYS.password, S.KEY_WRAP_DATA_KEYS.recovery, S.KEY_EPOCH_DATA_KEY, S.KEY_RING_DATA_KEY]);
      expect(r.recoveryCode.split(" ")).to.have.length(24);
      // What a phone or the page does with the register's values and the new password.
      const dek1 = await S.unwrapWithPassword(r.dataValues[0], "una frase nuova per i dati", registry);
      const k1 = await S.openKeys(dek1, registry, r.dataValues[2], r.dataValues[3]);
      expect(k1.epoch).to.equal(1);
      expect(await S.decryptValue(k1, tokenId, "state", old)).to.deep.equal(state);
      expect(await S.cylinderTokenId(k1, "AR-1")).to.equal(id0);
      const fresh = await S.encryptValue(k1, tokenId, "state", state);
      expect(ethers.getBytes(fresh)[0]).to.equal(2);
      await expectReject(S.decryptValue(k0, tokenId, "state", fresh), /epoch 1/);
      // The old key (a revoked phone's) is refused against the new ring.
      const stale = await expectReject(S.openKeys(dek0, registry, r.dataValues[2], r.dataValues[3]), /replaced/);
      expect(stale.code).to.equal("KEY_REPLACED");

      // A second replacement keeps both older keys.
      const r2 = await S.replaceDataKey(k1, dek1, "ancora una frase diversa", "en");
      const k2 = await S.openKeys(await S.unwrapWithRecoveryCode(r2.dataValues[1], r2.recoveryCode, registry), registry, r2.dataValues[2], r2.dataValues[3]);
      expect(k2.epoch).to.equal(2);
      expect(await S.decryptValue(k2, tokenId, "state", old)).to.deep.equal(state);
      expect(await S.decryptValue(k2, tokenId, "state", fresh)).to.deep.equal(state);
      expect(await S.cylinderTokenId(k2, "AR-1")).to.equal(id0);
    });

    it("an epoch never written is epoch 0", async function () {
      const dek = S.generateDataKey();
      expect((await S.openKeys(dek, registry, "0x", "0x")).epoch).to.equal(0);
    });
  });

  describe("periodic test", function () {
    it("works out the expiry from the last test, or the last test from the expiry", function () {
      expect(S.completeTest({ last: "2024-03" }, 10)).to.deep.equal({ last: "2024-03", due: "2034-03" });
      expect(S.completeTest({ due: "2030-01" }, 5)).to.deep.equal({ last: "2025-01", due: "2030-01" });
      expect(S.completeTest({ last: "2020-11", due: "2031-02" }, 10)).to.deep.equal({ last: "2020-11", due: "2031-02" });
      expect(S.completeTest({ unreadable: true }, 10)).to.deep.equal({ unreadable: true });
      expect(() => S.validateTest({})).to.throw(/neither/);
      expect(() => S.validateTest({ last: "2024-13" })).to.throw(/month/);
      expect(() => S.validateTest({ last: "2030-01", due: "2029-01" })).to.throw(/after/);
    });

    it("tells expired, soon and ok tests", function () {
      const now = Math.floor(new Date(2026, 10, 19).getTime() / 1000);
      expect(S.testStatus({ due: "2026-10" }, now)).to.equal("expired");
      expect(S.testStatus({ due: "2026-11" }, now)).to.equal("soon");
      expect(S.testStatus({ due: "2027-02" }, now)).to.equal("soon");
      expect(S.testStatus({ due: "2027-03" }, now)).to.equal("ok");
      expect(S.testStatus({ unreadable: true }, now)).to.equal("unknown");
      expect(S.testStatus(undefined, now)).to.equal("unknown");
    });

    it("years: the cylinder's, else the gas's in the settings, else 10", function () {
      const settings = S.validateSettings({ v: 1, company: "X", emails: [], testYears: { acetylene: 5 } });
      expect(S.testYearsFor({ gas: "acetylene" }, settings)).to.equal(5);
      expect(S.testYearsFor({ gas: "argon" }, settings)).to.equal(10);
      expect(S.testYearsFor({ gas: "acetylene", testYears: 7 }, settings)).to.equal(7);
      expect(() => S.validateSettings({ v: 1, company: "X", testYears: { propane: 5 } })).to.throw(/testYears/);
    });
  });

  describe("documents of version 2", function () {
    it("bind every part to one manifest", function () {
      const part = (i, n) => ({ docId: ethers.id("doc"), part: i, parts: n, corrects: ethers.ZeroHash, mints: [], updates: [], document: "0x" });
      const parts = S.withManifest([part(0, 2), part(1, 2)]);
      expect(parts[0].manifest).to.equal(parts[1].manifest).and.not.equal(ethers.ZeroHash);
      expect(parts[0].manifest).to.equal(S.documentManifest(ethers.id("doc"), [part(0, 2), part(1, 2)]));
      expect(() => S.withManifest([part(0, 2)])).to.throw(/one document/);
    });

    it("a correction has a reason and no counterparty", function () {
      const line = { tokenId: "0x" + "ab".repeat(32), serial: "AR-1", gas: "argon", movement: "correct", condition: "full", owner: "supplier", test: { last: "2024-01", due: "2034-01" } };
      const d = S.validateDocument({ v: 1, kind: "correction", date: 1767225600, lines: [line], reason: "gas sbagliato" });
      expect(d.counterparty).to.equal(undefined);
      expect(d.lines[0].test).to.deep.equal({ last: "2024-01", due: "2034-01" });
      expect(() => S.validateDocument({ v: 1, kind: "correction", date: 1767225600, lines: [line] })).to.throw(/reason/);
    });

    it("validity: at most seven days, starting a minute early", function () {
      const v = S.validity(1767225600, 30 * 86400, 5n);
      expect(v).to.deep.equal({ nonce: 5n, validFrom: 1767225540n, deadline: 1767225540n + 7n * 86400n });
      expect(S.validityTuple(S.validityJson(v))).to.deep.equal(v);
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
  return error;
}
