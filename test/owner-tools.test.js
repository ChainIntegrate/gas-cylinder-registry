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

    const f = await O.deployFactory(chainIntegrate);
    factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
    const prepared = await O.prepareRegistry({ factory, password, language: "it" });
    const r = await O.createRegistry({ factory, prepared, owner: ownerWallet.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });
    expect(r.address).to.equal(prepared.address);

    ctx = await O.context({
      provider: ethers.provider,
      registry: r.address,
      owner: ownerWallet,
      submit: O.directSubmitter(chainIntegrate),
      fromBlock: r.block,
    });
    keys = (await O.unlockWithPassword(ctx, password)).keys;
    this.recoveryCode = prepared.recoveryCode;
  });

  it("refuses a weak data password when preparing a registry", async function () {
    await expectReject(O.prepareRegistry({ factory, password: "argonia" }), /password refused/);
  });

  it("shows the registry's status", async function () {
    const s = await O.status(ctx);
    expect(s).to.include({ name: "Argonia Gas Tecnici cylinders", owner: ownerWallet.address, operators: 0, cylinders: 0, passwordKeyWrap: true, recoveryKeyWrap: true });
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

    await O.removeCounterparty(ctx, b);
    list = await O.listCounterparties(ctx, keys);
    expect(list.map((c) => c.id)).to.deep.equal([a]);

    // The directory is unreadable without the data key: only ciphertext on-chain.
    const raw = await ctx.registry.getData(S.counterpartyDataKey(a));
    expect(Buffer.from(raw.slice(2), "hex").toString("latin1")).to.not.include("Officina");
  });

  it("keeps the company name and the supplier's e-mails, encrypted", async function () {
    expect(await O.readSettings(ctx, keys)).to.equal(null);
    await O.writeSettings(ctx, keys, { company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
    await O.writeSettings(ctx, keys, { emails: ["ufficio@example.com", "magazzino@example.com"] });
    expect(await O.readSettings(ctx, keys)).to.deep.equal({ v: 1, company: "Argonia Gas Tecnici", emails: ["ufficio@example.com", "magazzino@example.com"] });
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
}
