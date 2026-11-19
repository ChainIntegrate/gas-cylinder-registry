"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const O = require("../scripts/lib/owner");
const S = require("../shared");

describe("owner tools", function () {
  this.timeout(60000);
  const password = "le bombole di argon tornano vuote";
  let chainIntegrate, ownerWallet, phone, ctx, keys, factory;

  beforeEach(async function () {
    [chainIntegrate] = await ethers.getSigners();
    ownerWallet = ethers.Wallet.createRandom().connect(ethers.provider); // holds no LYX
    phone = ethers.Wallet.createRandom();

    const f = await O.deployFactory(chainIntegrate, 2);
    factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
    const prepared = await O.prepareRegistry({ factory });
    const r = await O.createRegistry({ factory, prepared, owner: ownerWallet.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });
    expect(r.address).to.equal(prepared.address);

    ctx = await O.context({
      provider: ethers.provider,
      registry: r.address,
      owner: ownerWallet,
      submit: O.directSubmitter(chainIntegrate),
      fromBlock: r.block,
    });
    const k = await O.prepareKeys(r.address, password, "it");
    await O.initializeKeys(ctx, k);
    keys = (await O.unlockWithPassword(ctx, password)).keys;
    this.recoveryCode = k.recoveryCode;
  });

  it("creates a register without its data key; the owner makes it once (review X-02)", async function () {
    const prepared = await O.prepareRegistry({ factory });
    expect(Object.keys(prepared)).to.deep.equal(["salt", "address"]);
    const r = await O.createRegistry({ factory, prepared, owner: ownerWallet.address, name: "Argonia Gas Tecnici bis", symbol: "ARGBIS" });
    const c = await O.context({ provider: ethers.provider, registry: r.address, owner: ownerWallet, submit: O.directSubmitter(chainIntegrate), fromBlock: r.block });
    expect(await O.hasDataKey(c)).to.equal(false);
    await expectReject(O.unlockWithPassword(c, password), /no password key wrap/);

    await expectReject(O.prepareKeys(r.address, "argonia"), /password refused/);
    const k = await O.prepareKeys(r.address, password, "it");
    expect(k.recoveryCode.split(" ")).to.have.length(24);
    const opened = await O.initializeKeys(c, k);
    expect(await O.hasDataKey(c)).to.equal(true);
    expect(Buffer.from((await O.unlockWithPassword(c, password)).dek).equals(Buffer.from(opened.dek))).to.equal(true);
    expect(Buffer.from((await O.unlockWithRecoveryCode(c, k.recoveryCode)).dek).equals(Buffer.from(opened.dek))).to.equal(true);
    // Never twice: a second key would make the data written with the first unreadable.
    await expectReject(O.initializeKeys(c, await O.prepareKeys(r.address, password, "it")), /already has its data key/);
  });

  it("shows the registry's status", async function () {
    const s = await O.status(ctx);
    expect(s).to.include({ name: "Argonia Gas Tecnici cylinders", owner: ownerWallet.address, operators: 0, cylinders: 0, passwordKeyWrap: true, recoveryKeyWrap: true, keyEpoch: 0, pendingOwner: null });
  });

  it("authorizes and revokes phones, signed by an owner with no LYX", async function () {
    await O.setOperator(ctx, phone.address, true);
    expect(await O.listOperators(ctx)).to.deep.equal([phone.address]);
    await expectReject(O.setOperator(ctx, phone.address, true), /already an operator/);
    await O.setOperator(ctx, phone.address, false);
    expect(await O.listOperators(ctx)).to.deep.equal([]);
    expect(await ethers.provider.getBalance(ownerWallet.address)).to.equal(0n);
  });

  it("adds, lists, edits and removes counterparties", async function () {
    const a = await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: ["demo@example.com"] });
    const b = await O.addCounterparty(ctx, keys, { type: "refill", name: "Centro Ricarica Nord", emails: [] });
    let list = await O.listCounterparties(ctx, keys);
    expect(list.map((c) => c.name)).to.deep.equal(["Centro Ricarica Nord", "Officina Demo"]);
    expect(list.find((c) => c.id === a)).to.deep.include({ type: "customer", emails: ["demo@example.com"] });

    await O.updateCounterparty(ctx, keys, a, { name: "Officina Demo Srl" });
    expect((await O.readCounterparty(ctx, keys, a)).name).to.equal("Officina Demo Srl");
    expect((await O.readCounterparty(ctx, keys, a)).emails).to.deep.equal(["demo@example.com"]);

    // Removing archives it (review A21): still readable, so that its documents keep its name.
    await O.removeCounterparty(ctx, keys, b);
    list = await O.listCounterparties(ctx, keys);
    expect(list.filter((c) => !c.archived).map((c) => c.id)).to.deep.equal([a]);
    expect(list.find((c) => c.id === b)).to.deep.include({ name: "Centro Ricarica Nord", archived: true });

    // The directory is unreadable without the data key: only ciphertext on-chain.
    const raw = await ctx.registry.getData(S.counterpartyDataKey(a));
    expect(Buffer.from(raw.slice(2), "hex").toString("latin1")).to.not.include("Officina");
  });

  it("keeps the company name and the supplier's e-mails, encrypted", async function () {
    expect(await O.readSettings(ctx, keys)).to.equal(null);
    await O.writeSettings(ctx, keys, { company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
    await O.writeSettings(ctx, keys, { emails: ["ufficio@example.com", "magazzino@example.com"] });
    expect(await O.readSettings(ctx, keys)).to.deep.equal({ v: 1, company: "Argonia Gas Tecnici", emails: ["ufficio@example.com", "magazzino@example.com"] });
    await O.writeSettings(ctx, keys, { testYears: { acetylene: 5 } });
    expect((await O.readSettings(ctx, keys)).testYears).to.deep.equal({ acetylene: 5 });
    const raw = await ctx.registry.getData(S.SETTINGS_DATA_KEY);
    expect(Buffer.from(raw.slice(2), "hex").toString("latin1")).to.not.include("Argonia");
  });

  it("changes the password, and recovers a lost one with the recovery code", async function () {
    const { dek } = await O.unlockWithPassword(ctx, password);
    await O.changePassword(ctx, dek, "una nuova frase per il registro");
    await expectReject(O.unlockWithPassword(ctx, password), /wrong password/);
    expect((await O.unlockWithPassword(ctx, "una nuova frase per il registro")).dek).to.deep.equal(dek);

    const recovered = await O.unlockWithRecoveryCode(ctx, this.recoveryCode);
    await O.changePassword(ctx, recovered.dek, "terza frase dopo aver perso la seconda");
    expect((await O.unlockWithPassword(ctx, "terza frase dopo aver perso la seconda")).dek).to.deep.equal(dek);
  });

  it("notices a change made meanwhile from another computer (several admin computers)", async function () {
    const a = await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: [] });
    const shown = (await O.listCounterparties(ctx, keys)).find((c) => c.id === a);
    await O.updateCounterparty(ctx, keys, a, { name: "Cambiato da un altro computer" }); // the other computer
    const e = await expectReject(O.updateCounterparty(ctx, keys, a, { name: "Il mio nome" }, shown.raw), /another computer/);
    expect(e.code).to.equal("CHANGED");
    expect((await O.readCounterparty(ctx, keys, a)).name).to.equal("Cambiato da un altro computer");
    const settingsSeen = await ctx.registry.getData(S.SETTINGS_DATA_KEY);
    await O.writeSettings(ctx, keys, { company: "Primo" });
    await expectReject(O.writeSettings(ctx, keys, { company: "Secondo" }, settingsSeen), /another computer/);
  });

  it("replaces the data key: new password and recovery code, older data still readable (A05)", async function () {
    const a = await O.addCounterparty(ctx, keys, { type: "customer", name: "Prima della chiave nuova", emails: [] });
    const { dek } = await O.unlockWithPassword(ctx, password);
    const prepared = await S.replaceDataKey(keys, dek, "la chiave nuova dopo un telefono perso", "it");
    const opened = await O.applyDataKey(ctx, prepared);
    await expectReject(O.unlockWithPassword(ctx, password), /wrong password/);
    const again = await O.unlockWithRecoveryCode(ctx, prepared.recoveryCode);
    expect(again.keys.epoch).to.equal(1);
    const b = await O.addCounterparty(ctx, opened.keys, { type: "customer", name: "Dopo la chiave nuova", emails: [] });
    expect((await O.listCounterparties(ctx, again.keys)).map((c) => c.id).sort()).to.deep.equal([a, b].sort());
    // The old key no longer opens the register, nor reads what was written after.
    await expectReject(O.openKeys(ctx, dek), /replaced/);
    await expectReject(O.readCounterparty(ctx, keys, b), /epoch 1/);
    expect((await O.status(ctx)).keyEpoch).to.equal(1);
    await expectReject(O.applyDataKey(ctx, prepared), /changed meanwhile/);
  });

  it("hands the register over after 3 days, cancellable meanwhile", async function () {
    const next = ethers.Wallet.createRandom().connect(ethers.provider);
    const nextCtx = await O.context({ provider: ethers.provider, registry: ctx.address, owner: next, submit: O.directSubmitter(chainIntegrate) });
    await O.transferOwnership(ctx, next.address);
    expect((await O.status(ctx)).pendingOwner).to.equal(next.address);
    await expectReject(O.acceptOwnership(nextCtx), /can be accepted from/);
    await O.cancelOwnershipTransfer(ctx);
    expect((await O.status(ctx)).pendingOwner).to.equal(null);

    await O.transferOwnership(ctx, next.address);
    await ethers.provider.send("evm_increaseTime", [3 * 86400 + 1]);
    await ethers.provider.send("evm_mine", []);
    await O.acceptOwnership(nextCtx);
    expect(await ctx.registry.owner()).to.equal(next.address);
  });

  it("corrects a cylinder's information and test, recorded as a correction with its reason (A06)", async function () {
    // A cylinder registered by the owner itself (as a phone would), then corrected.
    const tokenId = await S.cylinderTokenId(keys, "AR-1");
    const info = { v: 1, serial: "AR-1", gas: "argon", owner: "supplier", registeredAt: 1767225600 };
    const state = { v: 1, location: { type: "depot" }, condition: "full", lifecycle: "active", movement: "register", at: 1767225600, test: { last: "2020-01", due: "2030-01" } };
    const docId = await S.documentId(keys, "0x" + "00".repeat(20), "registration");
    const [payload] = S.withManifest([
      {
        docId,
        part: 0,
        parts: 1,
        corrects: ethers.ZeroHash,
        mints: [tokenId],
        updates: [
          { tokenId, dataKey: S.INFO_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(keys, tokenId, "info", info) },
          { tokenId, dataKey: S.STATE_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(keys, tokenId, "state", state) },
        ],
        document: "0x",
      },
    ]);
    const [v, sig] = await O.signAsOwner(ctx, "RecordDocument", { signer: ownerWallet.address, payloadHash: S.hashPayload(payload) });
    await ctx.submit(ctx.address, "recordDocument", [payload, ownerWallet.address, v, sig]);

    const cp = await O.addCounterparty(ctx, keys, { type: "refill", name: "Centro con bombole proprie", emails: [] });
    const c = await O.correctCylinder(ctx, keys, tokenId, { gas: "argon_co2", owner: cp, test: { due: "2031-06" } }, "gas e proprietario sbagliati");
    const [rawInfo, rawState] = await ctx.registry.getDataBatchForTokenIds([tokenId, tokenId], [S.INFO_KEY, S.STATE_KEY]);
    expect(await S.decryptValue(keys, tokenId, "info", rawInfo)).to.deep.include({ gas: "argon_co2", owner: cp, serial: "AR-1" });
    expect((await S.decryptValue(keys, tokenId, "state", rawState)).test).to.deep.equal({ last: "2021-06", due: "2031-06" });
    const [log] = await ctx.registry.queryFilter(ctx.registry.filters.DocumentRecorded(c.docId));
    const doc = await S.decryptValue(keys, c.docId, "document", log.args.document);
    expect(doc).to.deep.include({ kind: "correction", reason: "gas e proprietario sbagliati" });
    expect(doc.lines[0]).to.deep.include({ movement: "correct", gas: "argon_co2", owner: cp });
    await expectReject(O.correctCylinder(ctx, keys, tokenId, {}, "niente"), /nothing to correct/);
  });

  it("cancels a phone's unsent signature", async function () {
    await O.setOperator(ctx, phone.address, true);
    await O.cancelNonces(ctx, phone.address, [42n]);
    expect(await ctx.registry.isNonceUsed(phone.address, 42n)).to.equal(true);
  });

  it("refuses to write with a key that is not the owner's", async function () {
    const other = await O.context({ provider: ethers.provider, registry: ctx.address, owner: ethers.Wallet.createRandom(), submit: O.directSubmitter(chainIntegrate) });
    await expectReject(O.setOperator(other, phone.address, true), /not the registry's owner/);
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
