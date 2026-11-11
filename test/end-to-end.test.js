"use strict";
// The shared library and the contracts together: the demo's flow on a local chain, with real encryption.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const S = require("../shared");

describe("end to end: library and contracts", function () {
  this.timeout(60000);

  it("creates a registry with its keys, registers a customer's cylinders, delivers and collects", async function () {
    const [chainIntegrate, owner, relayer] = await ethers.getSigners();
    const phone = ethers.Wallet.createRandom(); // the driver's key, never funded
    const { chainId } = await ethers.provider.getNetwork();
    const factory = await ethers.deployContract("GasCylinderRegistryFactory", [chainIntegrate.address]);

    // Owner tools: the address first, then the keys bound to it, then the registry.
    const salt = ethers.id("argonia-demo");
    const regAddress = await factory.predictRegistryAddress(salt);
    const dek = S.generateDataKey();
    const password = "le bombole di argon tornano vuote";
    const recoveryCode = S.generateRecoveryCode("it");
    await factory
      .connect(chainIntegrate)
      .createRegistry(
        salt,
        owner.address,
        "Argonia Gas Tecnici cylinders",
        "ARGCYL",
        [S.KEY_WRAP_DATA_KEYS.password, S.KEY_WRAP_DATA_KEYS.recovery],
        [await S.wrapWithPassword(dek, password, regAddress), await S.wrapWithRecoveryCode(dek, recoveryCode, regAddress)]
      );
    const reg = await ethers.getContractAt("GasCylinderRegistry", regAddress);
    const dom = S.domain(regAddress, chainId);
    const deadline = async () => BigInt(await time.latest()) + 3600n;

    // Owner tools: a customer and the phone, both signed by the owner and sent by the relayer.
    const keys = await S.deriveKeys(dek, regAddress);
    const customer = await S.counterpartyId(keys, "customer-1");
    const cpKey = S.counterpartyDataKey(customer);
    const cpValue = await S.encryptValue(keys, customer, "counterparty", S.validateCounterparty({ v: 1, type: "customer", name: "Officina Demo", emails: ["demo@example.com"] }));
    let n = S.randomNonce();
    let dl = await deadline();
    let sig = await owner.signTypedData(dom, { SetData: S.TYPES.SetData }, { dataKeys: [cpKey], dataValuesHash: S.hashDataValues([cpValue]), nonce: n, deadline: dl });
    await reg.connect(relayer).setDataSigned([cpKey], [cpValue], n, dl, sig);
    n = S.randomNonce();
    sig = await owner.signTypedData(dom, { SetOperator: S.TYPES.SetOperator }, { operator: phone.address, enabled: true, nonce: n, deadline: dl });
    await reg.connect(relayer).setOperatorSigned(phone.address, true, n, dl, sig);

    // The phone at enrollment: the owner types the password once, the phone gets the data key.
    const phoneDek = await S.unwrapWithPassword(await reg.getData(S.KEY_WRAP_DATA_KEYS.password), password, regAddress);
    const phoneKeys = await S.deriveKeys(phoneDek, regAddress);
    const dir = await S.decryptValue(phoneKeys, customer, "counterparty", await reg.getData(cpKey));
    expect(dir.name).to.equal("Officina Demo");

    // Helper: one signed document from the phone.
    const now = await time.latest();
    async function send(payload) {
      const nonce = S.randomNonce();
      const d = await deadline();
      const s = await phone.signTypedData(dom, { RecordDocument: S.TYPES.RecordDocument }, { signer: phone.address, payloadHash: S.hashPayload(payload), nonce, deadline: d });
      return reg.connect(relayer).recordDocument(payload, phone.address, nonce, d, s);
    }
    async function readState(tokenId) {
      const raw = await reg.getDataForTokenId(tokenId, S.STATE_KEY);
      return { raw, state: raw === "0x" ? null : await S.decryptValue(phoneKeys, tokenId, "state", raw) };
    }

    // Stock count: an empty cylinder already at the customer.
    const atCustomer = await S.cylinderTokenId(phoneKeys, "AR-0000001");
    const countId = await S.documentId(phoneKeys, customer, "STOCK-1");
    const stateAt = (location, condition, movement) =>
      S.validateState({ v: 1, location, condition, lifecycle: "active", movement, at: now });
    await send({
      docId: countId,
      part: 0,
      parts: 1,
      corrects: ethers.ZeroHash,
      mints: [atCustomer],
      updates: [
        { tokenId: atCustomer, dataKey: S.INFO_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(phoneKeys, atCustomer, "info", S.validateInfo({ v: 1, serial: "AR-0000001", gas: "argon", owner: "supplier", registeredAt: now })) },
        { tokenId: atCustomer, dataKey: S.STATE_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(phoneKeys, atCustomer, "state", stateAt({ type: "customer", id: customer }, "empty", "stock_count")) },
      ],
      document: "0x",
    });

    // The driver arrives: one new full cylinder delivered, the empty one collected, delivery note 118.
    const delivered = await S.cylinderTokenId(phoneKeys, "co2-777");
    const ddt = await S.documentId(phoneKeys, customer, "DDT 2026/118");
    const before = await readState(atCustomer);
    expect(before.state.location).to.deep.equal({ type: "customer", id: customer.toLowerCase() });
    const doc = S.validateDocument({
      v: 1,
      kind: "delivery_note",
      number: "DDT 2026/118",
      date: now,
      counterparty: customer,
      lines: [
        { tokenId: delivered, serial: "CO2-777", gas: "co2", movement: "delivery", condition: "full" },
        { tokenId: atCustomer, serial: "AR-0000001", gas: "argon", movement: "collection", condition: "empty" },
      ],
    });
    await expect(
      send({
        docId: ddt,
        part: 0,
        parts: 1,
        corrects: ethers.ZeroHash,
        mints: [delivered],
        updates: [
          { tokenId: delivered, dataKey: S.INFO_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(phoneKeys, delivered, "info", S.validateInfo({ v: 1, serial: "CO2-777", gas: "co2", owner: "supplier", registeredAt: now })) },
          { tokenId: delivered, dataKey: S.STATE_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(phoneKeys, delivered, "state", stateAt({ type: "customer", id: customer }, "full", "delivery")) },
          { tokenId: atCustomer, dataKey: S.STATE_KEY, expectedHash: ethers.keccak256(before.raw), newValue: await S.encryptValue(phoneKeys, atCustomer, "state", stateAt({ type: "depot" }, "empty", "collection")) },
        ],
        document: await S.encryptValue(phoneKeys, ddt, "document", doc),
      })
    ).to.emit(reg, "DocumentRecorded");

    // Anyone with the key reads the new states from the chain.
    expect((await readState(atCustomer)).state.location).to.deep.equal({ type: "depot" });
    expect((await readState(delivered)).state.condition).to.equal("full");
    expect(await reg.tokenOwnerOf(delivered)).to.equal(owner.address);

    // The document comes back from the event, decrypted.
    const [ev] = await reg.queryFilter(reg.filters.DocumentRecorded(ddt));
    expect(await S.decryptValue(phoneKeys, ddt, "document", ev.args.document)).to.deep.equal(doc);

    // Lost password: the recovery code opens the same data key.
    expect(await S.unwrapWithRecoveryCode(await reg.getData(S.KEY_WRAP_DATA_KEYS.recovery), recoveryCode, regAddress)).to.deep.equal(dek);

    // The phone never needed LYX.
    expect(await ethers.provider.getBalance(phone.address)).to.equal(0n);
  });
});
