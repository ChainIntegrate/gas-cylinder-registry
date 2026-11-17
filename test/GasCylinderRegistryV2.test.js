"use strict";

// Version 2 of the register (contracts/GasCylinderRegistryV2.sol): the external review's contract points.
// The owner is tested both as a key and as a real LUKSO account (LSP0 Universal Profile with an LSP6 Key
// Manager) with an administrator key and an access key, as the ChainIntegrate Account extension makes them.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO32 = ethers.ZeroHash;
const rnd32 = () => ethers.hexlify(ethers.randomBytes(32));
const randomNonce = () => BigInt(rnd32());
const INFO_KEY = ethers.id("GCRInfo");
const STATE_KEY = ethers.id("GCRState");
const EMPTY_HASH = ethers.keccak256("0x");
const DAY = 86400n;

// The extension's permissions (up-onboarding, extension/shared/relay.js): administrator and access.
const ADMIN_PERMS = 0x7f3f06n;
const ACCESS_PERMS = 0x800n | 0x40000n | 0x200000n | 0x400000n;
const permKey = (a) => "0x4b80742de2bf82acb3630000" + a.slice(2).toLowerCase();
const permValue = (p) => ethers.zeroPadValue(ethers.toBeHex(p), 32);

const V = () => [{ name: "nonce", type: "uint256" }, { name: "validFrom", type: "uint256" }, { name: "deadline", type: "uint256" }];
const TYPES = {
  RecordDocument: [{ name: "signer", type: "address" }, { name: "payloadHash", type: "bytes32" }, ...V()],
  SetOperator: [{ name: "operator", type: "address" }, { name: "enabled", type: "bool" }, ...V()],
  SetData: [{ name: "dataKeys", type: "bytes32[]" }, { name: "dataValuesHash", type: "bytes32" }, ...V()],
  TransferOwnership: [{ name: "newOwner", type: "address" }, ...V()],
  CancelOwnershipTransfer: [{ name: "pendingOwner", type: "address" }, ...V()],
  AcceptOwnership: [{ name: "newOwner", type: "address" }, ...V()],
  CancelNonces: [{ name: "signer", type: "address" }, { name: "nonces", type: "uint256[]" }, ...V()],
};
const PAYLOAD_TUPLE =
  "tuple(bytes32 docId,uint16 part,uint16 parts,bytes32 manifest,bytes32 corrects,bytes32[] mints,tuple(bytes32 tokenId,bytes32 dataKey,bytes32 expectedHash,bytes newValue)[] updates,bytes document)";
const hashPayload = (p) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PAYLOAD_TUPLE], [p]));
const dataValuesHash = (values) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes[]"], [values]));

describe("GasCylinderRegistryV2", function () {
  let chainId, chainIntegrate, ownerKey, driver, driver2, relayer, stranger, factory, registry;

  async function now() {
    return BigInt(await time.latest());
  }

  /** Validity of a signature: valid from now for an hour, unless given. */
  async function validity(opts = {}) {
    const from = opts.validFrom ?? (await now());
    return { nonce: opts.nonce ?? randomNonce(), validFrom: from, deadline: opts.deadline ?? from + 3600n };
  }

  async function createRegistry(registryOwner) {
    const tx = await factory.connect(chainIntegrate).createRegistry(rnd32(), registryOwner, "Argonia Gas Tecnici cylinders", "ARGCYL");
    const receipt = await tx.wait();
    const log = receipt.logs.map((l) => factory.interface.parseLog(l)).find((l) => l && l.name === "RegistryCreated");
    return ethers.getContractAt("GasCylinderRegistryV2", log.args.registry);
  }

  /** Signs `type` with `key` for `reg`; returns the validity and the signature. */
  async function sign(key, reg, type, message, opts = {}) {
    const v = await validity(opts);
    const domain = { name: "GasCylinderRegistry", version: opts.version ?? "2", chainId, verifyingContract: await reg.getAddress() };
    const sig = await key.signTypedData(domain, { [type]: TYPES[type] }, { ...message, ...v });
    return [v, sig];
  }

  const setOperator = async (key, reg, operator, enabled = true, opts) =>
    reg.connect(relayer).setOperatorSigned(operator, enabled, ...(await sign(key, reg, "SetOperator", { operator, enabled }, opts)));

  const setData = async (key, reg, keys, values, opts) =>
    reg.connect(relayer).setDataSigned(keys, values, ...(await sign(key, reg, "SetData", { dataKeys: keys, dataValuesHash: dataValuesHash(values) }, opts)));

  /** Records `p` signed by `key` for `signer` (the key's address, or the account it signs for). */
  const record = async (key, reg, p, signer = key.address, opts) =>
    reg.connect(relayer).recordDocument(p, signer, ...(await sign(key, reg, "RecordDocument", { signer, payloadHash: hashPayload(p) }, opts)));

  function payload(fields = {}) {
    return { docId: rnd32(), part: 0, parts: 1, manifest: rnd32(), corrects: ZERO32, mints: [], updates: [], document: "0x", ...fields };
  }

  /** A document registering `tokenIds` with an info and a state value each. */
  function registration(tokenIds, fields = {}) {
    const updates = [];
    for (const t of tokenIds) {
      updates.push({ tokenId: t, dataKey: INFO_KEY, expectedHash: EMPTY_HASH, newValue: rnd32() });
      updates.push({ tokenId: t, dataKey: STATE_KEY, expectedHash: EMPTY_HASH, newValue: rnd32() });
    }
    return payload({ mints: tokenIds, updates, ...fields });
  }

  /** A Universal Profile with a Key Manager: `admin` and `access` keys with the extension's permissions. */
  async function luksoAccount(adminWallet, access) {
    const admin = adminWallet.connect(ethers.provider);
    await chainIntegrate.sendTransaction({ to: admin.address, value: ethers.parseEther("1") });
    const up = await ethers.deployContract("LSP0ERC725Account", [admin.address]);
    const km = await ethers.deployContract("LSP6KeyManager", [await up.getAddress()]);
    const keys = [permKey(admin.address)];
    const values = [permValue(ADMIN_PERMS | 0x1n)]; // CHANGEOWNER too: only to take the account over below
    if (access) {
      keys.push(permKey(access.address));
      values.push(permValue(ACCESS_PERMS));
    }
    await up.connect(admin).setDataBatch(keys, values);
    await up.connect(admin).transferOwnership(await km.getAddress());
    await km.connect(admin).execute(up.interface.encodeFunctionData("acceptOwnership"));
    // The administrator as the extension makes it (no CHANGEOWNER).
    await km.connect(admin).execute(up.interface.encodeFunctionData("setData", [permKey(admin.address), permValue(ADMIN_PERMS)]));
    expect(await up.owner()).to.equal(await km.getAddress());
    return { up, km, address: await up.getAddress() };
  }

  beforeEach(async function () {
    [chainIntegrate, ownerKey, driver, driver2, relayer, stranger] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    factory = await ethers.deployContract("GasCylinderRegistryFactoryV2", [chainIntegrate.address]);
    registry = await createRegistry(ownerKey.address);
  });

  describe("factory", function () {
    it("creates a registry without data, owned by the company, at the predicted address", async function () {
      const salt = ethers.id("argonia-v2");
      const predicted = await factory.predictRegistryAddress(salt);
      await factory.connect(chainIntegrate).createRegistry(salt, ownerKey.address, "x", "X");
      const reg = await ethers.getContractAt("GasCylinderRegistryV2", predicted);
      expect(await factory.isRegistry(predicted)).to.equal(true);
      expect(await factory.registryCount()).to.equal(2n);
      expect(await factory.VERSION()).to.equal(2n);
      expect(await reg.VERSION()).to.equal(2n);
      expect(await reg.owner()).to.equal(ownerKey.address);
      expect(await reg.factory()).to.equal(await factory.getAddress());
      expect(await reg.getData(ethers.id("GCRKeyWrap:0"))).to.equal("0x");
      await expect(factory.connect(chainIntegrate).createRegistry(salt, ownerKey.address, "x", "X")).to.be.reverted;
    });

    it("lets only its owner create registries, and nobody initialize one again", async function () {
      await expect(factory.connect(stranger).createRegistry(ZERO32, stranger.address, "x", "X")).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(factory.connect(chainIntegrate).createRegistry(rnd32(), ethers.ZeroAddress, "x", "X")).to.be.revertedWithCustomError(factory, "InvalidOwner");
      const impl = await ethers.getContractAt("GasCylinderRegistryV2", await factory.implementation());
      await expect(impl.initialize("x", "X", stranger.address)).to.be.reverted;
      await expect(registry.initialize("x", "X", stranger.address)).to.be.reverted;
    });

    it("is deployed by the owner tools' deploy-factory --version 2, with the compiled bytecode", async function () {
      const O = require("../scripts/lib/owner");
      const f = await O.deployFactory(chainIntegrate, 2);
      const deployed = await ethers.getContractAt("GasCylinderRegistryFactoryV2", f.address);
      expect(await deployed.VERSION()).to.equal(2n);
      expect(await deployed.owner()).to.equal(chainIntegrate.address);
      const impl = await ethers.getContractAt("GasCylinderRegistryV2", await deployed.implementation());
      expect(await impl.VERSION()).to.equal(2n);
      const artifact = require("../artifacts/contracts/GasCylinderRegistryFactoryV2.sol/GasCylinderRegistryFactoryV2.json");
      expect(require("../shared/abi/GasCylinderRegistryFactoryV2.bytecode.json").bytecode).to.equal(artifact.bytecode); // export-abi run
    });

    it("hashes a payload as the off-chain encoding", async function () {
      const p = registration([rnd32()], { parts: 2, part: 1, document: "0xabcdef" });
      expect(await registry.hashPayload(p)).to.equal(hashPayload(p));
    });
  });

  describe("signatures: validity and cancellation (G-07)", function () {
    it("accepts a signature valid for up to seven days, not more", async function () {
      const from = await now();
      await setOperator(ownerKey, registry, driver.address, true, { validFrom: from, deadline: from + 7n * DAY });
      await expect(setOperator(ownerKey, registry, driver2.address, true, { validFrom: from, deadline: from + 7n * DAY + 1n }))
        .to.be.revertedWithCustomError(registry, "ValidityTooLong");
    });

    it("refuses an expired signature, and one dated more than an hour ahead", async function () {
      const from = await now();
      await expect(setOperator(ownerKey, registry, driver.address, true, { validFrom: from - 7200n, deadline: from - 1n }))
        .to.be.revertedWithCustomError(registry, "SignatureExpired");
      await expect(setOperator(ownerKey, registry, driver.address, true, { validFrom: from + 7200n, deadline: from + DAY }))
        .to.be.revertedWithCustomError(registry, "SignatureNotYetValid");
      await setOperator(ownerKey, registry, driver.address, true, { validFrom: from + 600n, deadline: from + DAY }); // a clock a little ahead
    });

    it("refuses a replay, a signature for version 1, and one for another registry", async function () {
      const args = await sign(ownerKey, registry, "SetOperator", { operator: driver.address, enabled: true });
      await registry.connect(relayer).setOperatorSigned(driver.address, true, ...args);
      await registry.connect(relayer).setOperatorSigned(driver.address, false, ...(await sign(ownerKey, registry, "SetOperator", { operator: driver.address, enabled: false })));
      await expect(registry.connect(relayer).setOperatorSigned(driver.address, true, ...args)).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed");
      await expect(setOperator(ownerKey, registry, driver.address, true, { version: "1" })).to.be.revertedWithCustomError(registry, "InvalidSignature");
      const other = await createRegistry(ownerKey.address);
      const forOther = await sign(ownerKey, other, "SetOperator", { operator: driver.address, enabled: true });
      await expect(registry.connect(relayer).setOperatorSigned(driver.address, true, ...forOther)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("lets a phone cancel its own unsent document, and the owner any phone's", async function () {
      await setOperator(ownerKey, registry, driver.address);
      await setOperator(ownerKey, registry, driver2.address);
      const p = registration([rnd32()]);
      const signed = await sign(driver, registry, "RecordDocument", { signer: driver.address, payloadHash: hashPayload(p) });
      const nonce = signed[0].nonce;
      // The phone cancels it.
      await registry.connect(relayer).cancelNoncesSigned(driver.address, [nonce], driver.address, ...(await sign(driver, registry, "CancelNonces", { signer: driver.address, nonces: [nonce] })));
      expect(await registry.isNonceUsed(driver.address, nonce)).to.equal(true);
      await expect(registry.connect(relayer).recordDocument(p, driver.address, ...signed)).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed");
      // The owner cancels another phone's.
      const p2 = registration([rnd32()]);
      const signed2 = await sign(driver2, registry, "RecordDocument", { signer: driver2.address, payloadHash: hashPayload(p2) });
      const n2 = signed2[0].nonce;
      await expect(registry.connect(relayer).cancelNoncesSigned(driver2.address, [n2], ownerKey.address, ...(await sign(ownerKey, registry, "CancelNonces", { signer: driver2.address, nonces: [n2] }))))
        .to.emit(registry, "NoncesCancelled");
      await expect(registry.connect(relayer).recordDocument(p2, driver2.address, ...signed2)).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed");
    });

    it("does not let a phone or a stranger cancel someone else's signatures", async function () {
      await setOperator(ownerKey, registry, driver.address);
      const n = randomNonce();
      await expect(registry.connect(relayer).cancelNoncesSigned(driver2.address, [n], driver.address, ...(await sign(driver, registry, "CancelNonces", { signer: driver2.address, nonces: [n] }))))
        .to.be.revertedWithCustomError(registry, "NotAuthorized");
      // Claiming to be the owner with another key.
      await expect(registry.connect(relayer).cancelNoncesSigned(driver.address, [n], ownerKey.address, ...(await sign(stranger, registry, "CancelNonces", { signer: driver.address, nonces: [n] }))))
        .to.be.revertedWithCustomError(registry, "InvalidSignature");
      expect(await registry.isNonceUsed(driver.address, n)).to.equal(false);
    });
  });

  describe("an owner that is a LUKSO account: administrator keys only (A01 / X-01)", function () {
    let admin, access, account, reg;
    beforeEach(async function () {
      admin = ethers.Wallet.createRandom();
      access = ethers.Wallet.createRandom();
      account = await luksoAccount(admin, access);
      reg = await createRegistry(account.address);
    });

    it("accepts the administrator key's signatures", async function () {
      const ownerAdmin = { address: account.address, signTypedData: (d, t, m) => admin.signTypedData(d, t, m) };
      await setOperator(ownerAdmin, reg, driver.address);
      expect(await reg.isOperator(driver.address)).to.equal(true);
      await setData(ownerAdmin, reg, [ethers.id("GCRKeyWrap:0")], ["0x1234"]);
      expect(await reg.getData(ethers.id("GCRKeyWrap:0"))).to.equal("0x1234");
      expect(await reg.isAdministrator(account.address, admin.address)).to.equal(true);
    });

    it("refuses the access key, although the account accepts its signature (ERC-1271)", async function () {
      const ownerAccess = { address: account.address, signTypedData: (d, t, m) => access.signTypedData(d, t, m) };
      const [v, sig] = await sign(ownerAccess, reg, "SetOperator", { operator: driver.address, enabled: true });
      const domain = { name: "GasCylinderRegistry", version: "2", chainId, verifyingContract: await reg.getAddress() };
      const digest = ethers.TypedDataEncoder.hash(domain, { SetOperator: TYPES.SetOperator }, { operator: driver.address, enabled: true, ...v });
      expect(await account.up.isValidSignature(digest, sig)).to.equal("0x1626ba7e"); // the account says yes
      await expect(reg.connect(relayer).setOperatorSigned(driver.address, true, v, sig))
        .to.be.revertedWithCustomError(reg, "NotAdministrator")
        .withArgs(account.address, access.address);
      await expect(setData(ownerAccess, reg, [ethers.id("GCRKeyWrap:0")], ["0x1234"])).to.be.revertedWithCustomError(reg, "NotAdministrator");
      await expect(record(ownerAccess, reg, registration([rnd32()]), account.address)).to.be.revertedWithCustomError(reg, "NotAdministrator");
      await expect(reg.connect(relayer).transferOwnershipSigned(stranger.address, ...(await sign(ownerAccess, reg, "TransferOwnership", { newOwner: stranger.address }))))
        .to.be.revertedWithCustomError(reg, "NotAdministrator");
      expect(await reg.isAdministrator(account.address, access.address)).to.equal(false);
    });

    it("refuses a key that is not on the account at all", async function () {
      const outsider = ethers.Wallet.createRandom();
      const ownerOutsider = { address: account.address, signTypedData: (d, t, m) => outsider.signTypedData(d, t, m) };
      await expect(setOperator(ownerOutsider, reg, driver.address)).to.be.revertedWithCustomError(reg, "InvalidSignature");
    });

    it("stops accepting a key whose administrator permission is removed", async function () {
      const ownerAdmin = { address: account.address, signTypedData: (d, t, m) => admin.signTypedData(d, t, m) };
      const signed = await sign(ownerAdmin, reg, "SetOperator", { operator: driver.address, enabled: true });
      // The account makes the administrator an access key (EDITPERMISSIONS removed) before the signature is sent.
      const adminSigner = admin.connect(ethers.provider);
      await account.km.connect(adminSigner).execute(account.up.interface.encodeFunctionData("setData", [permKey(admin.address), permValue(ACCESS_PERMS | 0x40000n)]));
      await expect(reg.connect(relayer).setOperatorSigned(driver.address, true, ...signed))
        .to.be.revertedWithCustomError(reg, "NotAdministrator")
        .withArgs(account.address, admin.address);
    });
  });

  describe("direct owner paths are closed", function () {
    it("refuses setData, token data, ownership transfer and renounce from the owner itself", async function () {
      const r = registry.connect(ownerKey);
      await expect(r.setData(ethers.id("x"), "0x01")).to.be.revertedWithCustomError(registry, "UseSignedOperation");
      await expect(r.setDataBatch([ethers.id("x")], ["0x01"])).to.be.revertedWithCustomError(registry, "UseSignedOperation");
      await expect(r.setDataForTokenId(rnd32(), INFO_KEY, "0x01")).to.be.revertedWithCustomError(registry, "UseSignedOperation");
      await expect(r.setDataBatchForTokenIds([rnd32()], [INFO_KEY], ["0x01"])).to.be.revertedWithCustomError(registry, "UseSignedOperation");
      await expect(r.transferOwnership(stranger.address)).to.be.revertedWithCustomError(registry, "UseSignedOperation");
      await expect(r.renounceOwnership()).to.be.revertedWithCustomError(registry, "RenounceDisabled");
    });

    it("keeps the LSP4 name read-only through the signed path too", async function () {
      const LSP4_NAME = "0xdeba1e292f8ba88238e10ab3c7f88bd4be4fac56cad5194b6ecceaf653468af1";
      await expect(setData(ownerKey, registry, [LSP4_NAME], [ethers.toUtf8Bytes("other")])).to.be.reverted;
    });
  });

  describe("documents", function () {
    beforeEach(async function () {
      await setOperator(ownerKey, registry, driver.address);
      await setOperator(ownerKey, registry, driver2.address);
    });

    it("registers cylinders to the owner with their encrypted data", async function () {
      const t = rnd32();
      const p = registration([t]);
      await expect(record(driver, registry, p)).to.emit(registry, "DocumentRecorded");
      expect(await registry.tokenOwnerOf(t)).to.equal(ownerKey.address);
      expect(await registry.getDataForTokenId(t, INFO_KEY)).to.equal(p.updates[0].newValue);
      const s = await registry.documentStatus(p.docId);
      expect([s.signer, s.parts, s.recorded, s.manifest]).to.deep.equal([driver.address, 1n, 1n, p.manifest]);
    });

    it("refuses signers who are not operators, and revoked phones", async function () {
      await expect(record(stranger, registry, registration([rnd32()]))).to.be.revertedWithCustomError(registry, "NotAuthorized");
      await setOperator(ownerKey, registry, driver.address, false);
      await expect(record(driver, registry, registration([rnd32()]))).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("lets a phone write a cylinder's information only when registering it; corrections are the owner's (A06)", async function () {
      const t = rnd32();
      const p = registration([t]);
      await record(driver, registry, p);
      const info = p.updates[0].newValue;
      const state = p.updates[1].newValue;
      // A phone: the state of a registered cylinder yes, its information no.
      await record(driver2, registry, payload({ updates: [{ tokenId: t, dataKey: STATE_KEY, expectedHash: ethers.keccak256(state), newValue: rnd32() }] }));
      await expect(record(driver2, registry, payload({ updates: [{ tokenId: t, dataKey: INFO_KEY, expectedHash: ethers.keccak256(info), newValue: rnd32() }] })))
        .to.be.revertedWithCustomError(registry, "InfoAlreadyRegistered")
        .withArgs(t);
      // The owner corrects it, with a document that stays in the history and names the corrected one.
      const fixed = rnd32();
      await expect(record(ownerKey, registry, payload({ corrects: p.docId, updates: [{ tokenId: t, dataKey: INFO_KEY, expectedHash: ethers.keccak256(info), newValue: fixed }] })))
        .to.emit(registry, "DocumentRecorded");
      expect(await registry.getDataForTokenId(t, INFO_KEY)).to.equal(fixed);
    });

    it("lets a phone add the information of a cylinder registered without it", async function () {
      const t = rnd32();
      await record(driver, registry, payload({ mints: [t] }));
      await record(driver2, registry, payload({ updates: [{ tokenId: t, dataKey: INFO_KEY, expectedHash: EMPTY_HASH, newValue: rnd32() }] }));
    });

    it("updates a value only if it has not changed since it was read", async function () {
      const t = rnd32();
      const p = registration([t]);
      await record(driver, registry, p);
      const stale = { tokenId: t, dataKey: STATE_KEY, expectedHash: EMPTY_HASH, newValue: rnd32() };
      await expect(record(driver2, registry, payload({ updates: [stale] }))).to.be.revertedWithCustomError(registry, "StaleValue");
    });

    it("refuses a cylinder registered twice, unknown cylinders and other data keys", async function () {
      const t = rnd32();
      await record(driver, registry, registration([t]));
      await expect(record(driver, registry, registration([t]))).to.be.reverted;
      await expect(record(driver, registry, payload({ updates: [{ tokenId: rnd32(), dataKey: STATE_KEY, expectedHash: EMPTY_HASH, newValue: "0x01" }] })))
        .to.be.revertedWithCustomError(registry, "UnknownCylinder");
      await expect(record(driver, registry, payload({ updates: [{ tokenId: t, dataKey: ethers.id("Other"), expectedHash: EMPTY_HASH, newValue: "0x01" }] })))
        .to.be.revertedWithCustomError(registry, "DataKeyNotAllowed");
    });

    it("binds a document's parts to one signer, one number of parts and one manifest (A11)", async function () {
      const docId = rnd32();
      const manifest = rnd32();
      await record(driver, registry, registration([rnd32()], { docId, manifest, parts: 3, part: 0 }));
      let s = await registry.documentStatus(docId);
      expect([s.parts, s.recorded]).to.deep.equal([3n, 1n]); // interrupted so far
      await expect(record(driver, registry, registration([rnd32()], { docId, manifest: rnd32(), parts: 3, part: 1 }))).to.be.revertedWithCustomError(registry, "DocumentMismatch");
      await expect(record(driver, registry, registration([rnd32()], { docId, manifest, parts: 4, part: 1 }))).to.be.revertedWithCustomError(registry, "DocumentMismatch");
      await expect(record(driver2, registry, registration([rnd32()], { docId, manifest, parts: 3, part: 1 }))).to.be.revertedWithCustomError(registry, "DocumentMismatch");
      await record(driver, registry, registration([rnd32()], { docId, manifest, parts: 3, part: 2 }));
      await expect(record(driver, registry, registration([rnd32()], { docId, manifest, parts: 3, part: 2 }))).to.be.revertedWithCustomError(registry, "DocumentPartAlreadyRecorded");
      await record(driver, registry, registration([rnd32()], { docId, manifest, parts: 3, part: 1 }));
      s = await registry.documentStatus(docId);
      expect([s.signer, s.parts, s.recorded]).to.deep.equal([driver.address, 3n, 3n]); // complete
      expect(await registry.isDocumentPartRecorded(docId, 1)).to.equal(true);
    });

    it("refuses a document without manifest or with a wrong part number", async function () {
      await expect(record(driver, registry, registration([rnd32()], { manifest: ZERO32 }))).to.be.revertedWithCustomError(registry, "InvalidDocument");
      await expect(record(driver, registry, registration([rnd32()], { parts: 2, part: 2 }))).to.be.revertedWithCustomError(registry, "InvalidDocument");
      await expect(record(driver, registry, registration([rnd32()], { docId: ZERO32 }))).to.be.revertedWithCustomError(registry, "InvalidDocument");
    });

    it("corrects a recorded document, never an unknown one", async function () {
      const p = registration([rnd32()]);
      await expect(record(driver, registry, payload({ corrects: p.docId }))).to.be.revertedWithCustomError(registry, "CorrectedDocumentUnknown");
      await record(driver, registry, p);
      await record(driver, registry, payload({ corrects: p.docId }));
    });

    it("refuses a payload changed after signing, and accepts documents queued offline in any order", async function () {
      const p = registration([rnd32()]);
      const signed = await sign(driver, registry, "RecordDocument", { signer: driver.address, payloadHash: hashPayload(p) });
      await expect(registry.connect(relayer).recordDocument({ ...p, document: "0x01" }, driver.address, ...signed)).to.be.revertedWithCustomError(registry, "InvalidSignature");
      const a = registration([rnd32()]);
      const b = registration([rnd32()]);
      const sa = await sign(driver, registry, "RecordDocument", { signer: driver.address, payloadHash: hashPayload(a) });
      const sb = await sign(driver, registry, "RecordDocument", { signer: driver.address, payloadHash: hashPayload(b) });
      await registry.connect(relayer).recordDocument(b, driver.address, ...sb);
      await registry.connect(relayer).recordDocument(a, driver.address, ...sa);
    });

    it("keeps the cylinders impossible to transfer", async function () {
      const t = rnd32();
      await record(driver, registry, registration([t]));
      await expect(registry.connect(ownerKey).transfer(ownerKey.address, stranger.address, t, true, "0x")).to.be.revertedWithCustomError(registry, "TransfersDisabled");
    });
  });

  describe("ownership: a transfer waits three days and can be cancelled", function () {
    async function start(newOwner, key = ownerKey) {
      return registry.connect(relayer).transferOwnershipSigned(newOwner, ...(await sign(key, registry, "TransferOwnership", { newOwner })));
    }
    async function accept(key, newOwner = key.address) {
      return registry.connect(relayer).acceptOwnershipSigned(...(await sign(key, registry, "AcceptOwnership", { newOwner })));
    }

    it("is accepted only after three days, then the cylinders follow", async function () {
      const t = rnd32();
      await setOperator(ownerKey, registry, driver.address);
      await record(driver, registry, registration([t]));
      await expect(start(stranger.address)).to.emit(registry, "OwnershipTransferStarted");
      const readyAt = await registry.ownershipTransferReadyAt();
      expect(readyAt).to.equal((await now()) + 3n * DAY);
      await expect(accept(stranger)).to.be.revertedWithCustomError(registry, "OwnershipTransferNotReady");
      await time.increaseTo(readyAt);
      await accept(stranger);
      expect(await registry.owner()).to.equal(stranger.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
      await registry.syncHolders([t]);
      expect(await registry.tokenOwnerOf(t)).to.equal(stranger.address);
      // The old owner no longer signs.
      await expect(setOperator(ownerKey, registry, driver2.address)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("can be cancelled by the owner during the wait", async function () {
      await start(stranger.address);
      await registry.connect(relayer).cancelOwnershipTransferSigned(stranger.address, ...(await sign(ownerKey, registry, "CancelOwnershipTransfer", { pendingOwner: stranger.address })));
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
      await time.increase(4n * DAY);
      await expect(accept(stranger)).to.be.revertedWithCustomError(registry, "NoOwnershipTransfer");
    });

    it("accepts only the pending owner's signature, and restarts the wait when replaced", async function () {
      await start(stranger.address);
      await time.increase(3n * DAY);
      await expect(registry.connect(relayer).acceptOwnershipSigned(...(await sign(driver, registry, "AcceptOwnership", { newOwner: stranger.address }))))
        .to.be.revertedWithCustomError(registry, "InvalidSignature");
      await start(driver.address);
      await expect(accept(driver)).to.be.revertedWithCustomError(registry, "OwnershipTransferNotReady");
    });

    it("to a LUKSO account: accepted with an administrator key of it, not an access key", async function () {
      const admin = ethers.Wallet.createRandom();
      const access = ethers.Wallet.createRandom();
      const account = await luksoAccount(admin, access);
      await start(account.address);
      await time.increase(3n * DAY);
      const asAccess = { address: account.address, signTypedData: (d, t, m) => access.signTypedData(d, t, m) };
      const asAdmin = { address: account.address, signTypedData: (d, t, m) => admin.signTypedData(d, t, m) };
      await expect(accept(asAccess)).to.be.revertedWithCustomError(registry, "NotAdministrator");
      await accept(asAdmin);
      expect(await registry.owner()).to.equal(account.address);
    });
  });
});
