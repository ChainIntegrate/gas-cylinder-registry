"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = require("../shared/eip712");

const ZERO32 = ethers.ZeroHash;
const rnd32 = () => ethers.hexlify(ethers.randomBytes(32));

describe("GasCylinderRegistry", function () {
  let chainId, chainIntegrate, owner, driver, relayer, stranger, newOwnerKey, factory, registry;

  async function deadline(seconds = 3600) {
    return BigInt(await time.latest()) + BigInt(seconds);
  }

  async function createRegistry(registryOwner, keys = [], values = []) {
    const tx = await factory
      .connect(chainIntegrate)
      .createRegistry(ethers.hexlify(ethers.randomBytes(32)), registryOwner, "Argonia Gas Tecnici cylinders", "ARGCYL", keys, values);
    const receipt = await tx.wait();
    const log = receipt.logs.map((l) => factory.interface.parseLog(l)).find((l) => l && l.name === "RegistryCreated");
    return ethers.getContractAt("GasCylinderRegistry", log.args.registry);
  }

  async function signSetOperator(signer, reg, operator, enabled, opts = {}) {
    const nonce = opts.nonce ?? E.randomNonce();
    const dl = opts.deadline ?? (await deadline());
    const sig = await signer.signTypedData(E.domain(await reg.getAddress(), chainId), { SetOperator: E.TYPES.SetOperator }, {
      operator,
      enabled,
      nonce,
      deadline: dl,
    });
    return [operator, enabled, nonce, dl, sig];
  }

  async function signDocument(signer, reg, payload, opts = {}) {
    const nonce = opts.nonce ?? E.randomNonce();
    const dl = opts.deadline ?? (await deadline());
    const signerAddress = opts.signerAddress ?? signer.address;
    const sig = await signer.signTypedData(
      E.domain(await reg.getAddress(), chainId),
      { RecordDocument: E.TYPES.RecordDocument },
      { signer: signerAddress, payloadHash: E.hashPayload(payload), nonce, deadline: dl }
    );
    return [payload, signerAddress, nonce, dl, sig];
  }

  function payload(fields = {}) {
    return {
      docId: rnd32(),
      part: 0,
      parts: 1,
      corrects: ZERO32,
      mints: [],
      updates: [],
      document: "0x",
      ...fields,
    };
  }

  /** A document registering `tokenIds` with an info and a state value each. */
  function registration(tokenIds, fields = {}) {
    const updates = [];
    for (const t of tokenIds) {
      updates.push({ tokenId: t, dataKey: E.INFO_KEY, expectedHash: E.EMPTY_HASH, newValue: rnd32() });
      updates.push({ tokenId: t, dataKey: E.STATE_KEY, expectedHash: E.EMPTY_HASH, newValue: rnd32() });
    }
    return payload({ mints: tokenIds, updates, ...fields });
  }

  async function enrollDriver(reg = registry, by = owner) {
    await reg.connect(relayer).setOperatorSigned(...(await signSetOperator(by, reg, driver.address, true)));
  }

  beforeEach(async function () {
    [chainIntegrate, owner, driver, relayer, stranger, newOwnerKey] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    factory = await ethers.deployContract("GasCylinderRegistryFactory", [chainIntegrate.address]);
    registry = await createRegistry(owner.address, [ethers.id("GCRKeyWrap:0")], ["0x1234"]);
  });

  describe("factory", function () {
    it("creates a registry owned by the company, with its initial data", async function () {
      expect(await factory.isRegistry(await registry.getAddress())).to.equal(true);
      expect(await factory.registryCount()).to.equal(1n);
      expect(await factory.registries(0, 10)).to.deep.equal([await registry.getAddress()]);
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.factory()).to.equal(await factory.getAddress());
      expect(await registry.getData(ethers.id("GCRKeyWrap:0"))).to.equal("0x1234");
      // LSP8 token ID format: unique id (3); LSP4 token type: collection (2)
      const format = await registry.getData("0xf675e9361af1c1664c1868cfa3eb97672d6b1a513aa5b81dec34c9ee330e818d");
      expect(BigInt(format)).to.equal(3n);
    });

    it("lets only its owner create registries", async function () {
      await expect(factory.connect(stranger).createRegistry(ethers.ZeroHash, stranger.address, "x", "X", [], [])).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("leaves the implementation and the clones impossible to initialize again", async function () {
      const impl = await ethers.getContractAt("GasCylinderRegistry", await factory.implementation());
      await expect(impl.initialize("x", "X", stranger.address, [], [])).to.be.reverted;
      await expect(registry.initialize("x", "X", stranger.address, [], [])).to.be.reverted;
    });

    it("does not recognise a registry deployed outside the factory", async function () {
      const lookalike = await ethers.deployContract("GasCylinderRegistry");
      expect(await factory.isRegistry(await lookalike.getAddress())).to.equal(false);
    });
  });

  it("creates registries at the predicted address, once per salt", async function () {
    const salt = ethers.id("argonia-1");
    const predicted = await factory.predictRegistryAddress(salt);
    await factory.connect(chainIntegrate).createRegistry(salt, owner.address, "x", "X", [], []);
    expect(await factory.isRegistry(predicted)).to.equal(true);
    await expect(factory.connect(chainIntegrate).createRegistry(salt, owner.address, "x", "X", [], [])).to.be.reverted;
  });

  describe("operators, signed by the owner and sent by the relayer", function () {
    it("authorizes and revokes a driver's phone", async function () {
      await expect(registry.connect(relayer).setOperatorSigned(...(await signSetOperator(owner, registry, driver.address, true))))
        .to.emit(registry, "OperatorChanged")
        .withArgs(driver.address, true);
      expect(await registry.isOperator(driver.address)).to.equal(true);
      expect(await registry.operatorCount()).to.equal(1n);

      await registry.connect(relayer).setOperatorSigned(...(await signSetOperator(owner, registry, driver.address, false)));
      expect(await registry.isOperator(driver.address)).to.equal(false);
      expect(await registry.operatorCount()).to.equal(0n);
    });

    it("refuses a signature that is not the owner's", async function () {
      const args = await signSetOperator(stranger, registry, stranger.address, true);
      await expect(registry.connect(relayer).setOperatorSigned(...args))
        .to.be.revertedWithCustomError(registry, "InvalidSignature")
        .withArgs(owner.address);
    });

    it("refuses a replayed signature", async function () {
      const args = await signSetOperator(owner, registry, driver.address, true);
      await registry.connect(relayer).setOperatorSigned(...args);
      await expect(registry.connect(relayer).setOperatorSigned(...args)).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed");
    });

    it("refuses an expired signature", async function () {
      const args = await signSetOperator(owner, registry, driver.address, true, { deadline: (await deadline(-1)) });
      await expect(registry.connect(relayer).setOperatorSigned(...args)).to.be.revertedWithCustomError(registry, "SignatureExpired");
    });

    it("refuses a signature made for another registry", async function () {
      const other = await createRegistry(owner.address);
      const args = await signSetOperator(owner, other, driver.address, true);
      await expect(registry.connect(relayer).setOperatorSigned(...args)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("lets the owner act directly too", async function () {
      await registry.connect(owner).setOperator(driver.address, true);
      expect(await registry.isOperator(driver.address)).to.equal(true);
      await expect(registry.connect(stranger).setOperator(stranger.address, true)).to.be.reverted;
    });
  });

  describe("documents", function () {
    beforeEach(async function () {
      await enrollDriver();
    });

    it("registers cylinders to the owner and stores their encrypted data, in one transaction", async function () {
      const t1 = rnd32();
      const t2 = rnd32();
      const p = registration([t1, t2], { document: "0xabcdef" });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, p))))
        .to.emit(registry, "DocumentRecorded")
        .withArgs(p.docId, 0, 1, driver.address, ZERO32, "0xabcdef");

      expect(await registry.tokenOwnerOf(t1)).to.equal(owner.address);
      expect(await registry.tokenOwnerOf(t2)).to.equal(owner.address);
      expect(await registry.balanceOf(owner.address)).to.equal(2n);
      expect(await registry.getDataForTokenId(t1, E.INFO_KEY)).to.equal(p.updates[0].newValue);
      expect(await registry.getDataForTokenId(t1, E.STATE_KEY)).to.equal(p.updates[1].newValue);
      expect(await registry.isDocumentRecorded(p.docId)).to.equal(true);
    });

    it("updates a state only if it has not changed since it was read", async function () {
      const t = rnd32();
      const reg = registration([t]);
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, reg)));
      const current = reg.updates[1].newValue;

      const next = rnd32();
      const ok = payload({
        updates: [{ tokenId: t, dataKey: E.STATE_KEY, expectedHash: ethers.keccak256(current), newValue: next }],
      });
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, ok)));
      expect(await registry.getDataForTokenId(t, E.STATE_KEY)).to.equal(next);

      // A second phone (or an offline queue) still expecting the old state is refused, and nothing changes.
      const stale = payload({
        mints: [rnd32()],
        updates: [{ tokenId: t, dataKey: E.STATE_KEY, expectedHash: ethers.keccak256(current), newValue: rnd32() }],
      });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, stale))))
        .to.be.revertedWithCustomError(registry, "StaleValue")
        .withArgs(t, E.STATE_KEY, ethers.keccak256(current), ethers.keccak256(next));
      expect(await registry.getDataForTokenId(t, E.STATE_KEY)).to.equal(next);
      expect(await registry.totalSupply()).to.equal(1n);
    });

    it("refuses a cylinder registered twice", async function () {
      const t = rnd32();
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, registration([t]))));
      await expect(
        registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, payload({ mints: [t] }))))
      ).to.be.revertedWithCustomError(registry, "LSP8TokenIdAlreadyMinted");
    });

    it("refuses updates to unknown cylinders and to other data keys", async function () {
      const unknown = payload({
        updates: [{ tokenId: rnd32(), dataKey: E.STATE_KEY, expectedHash: E.EMPTY_HASH, newValue: "0x01" }],
      });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, unknown)))).to.be.revertedWithCustomError(
        registry,
        "UnknownCylinder"
      );

      const t = rnd32();
      const otherKey = payload({
        mints: [t],
        updates: [{ tokenId: t, dataKey: ethers.id("LSP4Metadata"), expectedHash: E.EMPTY_HASH, newValue: "0x01" }],
      });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, otherKey)))).to.be.revertedWithCustomError(
        registry,
        "DataKeyNotAllowed"
      );
    });

    it("records a document in parts, each once", async function () {
      const docId = rnd32();
      const p0 = registration([rnd32()], { docId, part: 0, parts: 2 });
      const p1 = registration([rnd32()], { docId, part: 1, parts: 2 });
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, p0)));
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, p1)));
      expect(await registry.isDocumentPartRecorded(docId, 1)).to.equal(true);

      const again = registration([rnd32()], { docId, part: 1, parts: 2 });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, again))))
        .to.be.revertedWithCustomError(registry, "DocumentPartAlreadyRecorded")
        .withArgs(docId, 1);

      const badPart = payload({ part: 2, parts: 2 });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, badPart)))).to.be.revertedWithCustomError(
        registry,
        "InvalidDocument"
      );
    });

    it("corrects a recorded document, never an unknown one", async function () {
      const original = registration([rnd32()]);
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, original)));

      const correction = payload({ corrects: original.docId, document: "0x99" });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, correction))))
        .to.emit(registry, "DocumentRecorded")
        .withArgs(correction.docId, 0, 1, driver.address, original.docId, "0x99");

      const wrong = payload({ corrects: rnd32() });
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, wrong)))).to.be.revertedWithCustomError(
        registry,
        "CorrectedDocumentUnknown"
      );
    });

    it("refuses a payload changed after signing", async function () {
      const p = registration([rnd32()]);
      const args = await signDocument(driver, registry, p);
      args[0] = { ...p, document: "0x66" };
      await expect(registry.connect(relayer).recordDocument(...args)).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("refuses signers who are not operators, and revoked phones", async function () {
      await expect(
        registry.connect(relayer).recordDocument(...(await signDocument(stranger, registry, registration([rnd32()]))))
      )
        .to.be.revertedWithCustomError(registry, "NotAuthorized")
        .withArgs(stranger.address);

      await registry.connect(relayer).setOperatorSigned(...(await signSetOperator(owner, registry, driver.address, false)));
      await expect(
        registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, registration([rnd32()]))))
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("accepts operations queued offline in any order", async function () {
      const a = await signDocument(driver, registry, registration([rnd32()]), { nonce: 7n });
      const b = await signDocument(driver, registry, registration([rnd32()]), { nonce: 3n });
      await registry.connect(relayer).recordDocument(...a);
      await registry.connect(relayer).recordDocument(...b);
      expect(await registry.isNonceUsed(driver.address, 3n)).to.equal(true);
      expect(await registry.isNonceUsed(driver.address, 7n)).to.equal(true);
      expect(await registry.isNonceUsed(driver.address, 4n)).to.equal(false);
    });

    it("lets the owner record documents as well", async function () {
      const p = registration([rnd32()]);
      await expect(registry.connect(relayer).recordDocument(...(await signDocument(owner, registry, p)))).to.emit(
        registry,
        "DocumentRecorded"
      );
    });

    it("hashes payloads exactly as the shared library", async function () {
      const p = registration([rnd32(), rnd32()], { document: "0x0102", corrects: ZERO32 });
      expect(await registry.hashPayload(p)).to.equal(E.hashPayload(p));
    });
  });

  describe("tokens", function () {
    it("cannot be transferred, not even by their holder", async function () {
      await enrollDriver();
      const t = rnd32();
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, registration([t]))));
      await expect(registry.connect(owner).transfer(owner.address, stranger.address, t, true, "0x")).to.be.revertedWithCustomError(
        registry,
        "TransfersDisabled"
      );
    });
  });

  describe("registry data, signed by the owner", function () {
    it("writes counterparties and key wraps", async function () {
      const keys = [ethers.id("GCRKeyWrap:1"), rnd32()];
      const values = ["0xaa", "0xbbbb"];
      const nonce = E.randomNonce();
      const dl = await deadline();
      const sig = await owner.signTypedData(
        E.domain(await registry.getAddress(), chainId),
        { SetData: E.TYPES.SetData },
        { dataKeys: keys, dataValuesHash: E.hashDataValues(values), nonce, deadline: dl }
      );
      await registry.connect(relayer).setDataSigned(keys, values, nonce, dl, sig);
      expect(await registry.getDataBatch(keys)).to.deep.equal(values);

      // Values swapped after signing are refused.
      const nonce2 = E.randomNonce();
      const sig2 = await owner.signTypedData(
        E.domain(await registry.getAddress(), chainId),
        { SetData: E.TYPES.SetData },
        { dataKeys: keys, dataValuesHash: E.hashDataValues(values), nonce: nonce2, deadline: dl }
      );
      await expect(registry.connect(relayer).setDataSigned(keys, ["0x01", "0x02"], nonce2, dl, sig2)).to.be.revertedWithCustomError(
        registry,
        "InvalidSignature"
      );
    });

    it("keeps the LSP4 name read-only", async function () {
      const keys = [ethers.id("LSP4TokenName")];
      const values = [ethers.hexlify(ethers.toUtf8Bytes("Other"))];
      const nonce = E.randomNonce();
      const dl = await deadline();
      const sig = await owner.signTypedData(
        E.domain(await registry.getAddress(), chainId),
        { SetData: E.TYPES.SetData },
        { dataKeys: keys, dataValuesHash: E.hashDataValues(values), nonce, deadline: dl }
      );
      await expect(registry.connect(relayer).setDataSigned(keys, values, nonce, dl, sig)).to.be.reverted;
    });
  });

  describe("ownership", function () {
    it("cannot be renounced", async function () {
      await expect(registry.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(registry, "RenounceDisabled");
    });

    it("moves to the same company's new account in two signed steps, then the tokens follow", async function () {
      await enrollDriver();
      const t1 = rnd32();
      const t2 = rnd32();
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, registration([t1, t2]))));

      const dom = E.domain(await registry.getAddress(), chainId);
      const dl = await deadline();
      const n1 = E.randomNonce();
      const s1 = await owner.signTypedData(dom, { TransferOwnership: E.TYPES.TransferOwnership }, { newOwner: newOwnerKey.address, nonce: n1, deadline: dl });
      await expect(registry.connect(relayer).transferOwnershipSigned(newOwnerKey.address, n1, dl, s1))
        .to.emit(registry, "OwnershipTransferStarted")
        .withArgs(owner.address, newOwnerKey.address);
      expect(await registry.owner()).to.equal(owner.address);

      const n2 = E.randomNonce();
      const forged = await stranger.signTypedData(dom, { AcceptOwnership: E.TYPES.AcceptOwnership }, { newOwner: newOwnerKey.address, nonce: n2, deadline: dl });
      await expect(registry.connect(relayer).acceptOwnershipSigned(n2, dl, forged)).to.be.revertedWithCustomError(registry, "InvalidSignature");

      const s2 = await newOwnerKey.signTypedData(dom, { AcceptOwnership: E.TYPES.AcceptOwnership }, { newOwner: newOwnerKey.address, nonce: n2, deadline: dl });
      await registry.connect(relayer).acceptOwnershipSigned(n2, dl, s2);
      expect(await registry.owner()).to.equal(newOwnerKey.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);

      // Anyone can sync, and tokens only ever go to the owner.
      await registry.connect(stranger).syncHolders([t1, t2]);
      expect(await registry.tokenOwnerOf(t1)).to.equal(newOwnerKey.address);
      expect(await registry.tokenOwnerOf(t2)).to.equal(newOwnerKey.address);

      // New cylinders are minted to the new owner; the driver stays authorized.
      const t3 = rnd32();
      await registry.connect(relayer).recordDocument(...(await signDocument(driver, registry, registration([t3]))));
      expect(await registry.tokenOwnerOf(t3)).to.equal(newOwnerKey.address);
    });
  });

  describe("an owner that is a contract account (Universal Profile, ERC-1271)", function () {
    it("signs through its controller", async function () {
      const controller = ethers.Wallet.createRandom();
      const account = await ethers.deployContract("MockContractAccount", [controller.address]);
      const reg = await createRegistry(await account.getAddress());

      // The controller's signature counts as the account's.
      await reg.connect(relayer).setOperatorSigned(...(await signSetOperator(controller, reg, driver.address, true)));
      expect(await reg.isOperator(driver.address)).to.equal(true);

      // A document signed by the account itself (signer = the account, signature from its controller).
      const t = rnd32();
      const p = registration([t]);
      await reg
        .connect(relayer)
        .recordDocument(...(await signDocument(controller, reg, p, { signerAddress: await account.getAddress() })));
      expect(await reg.tokenOwnerOf(t)).to.equal(await account.getAddress());

      // Someone else's signature is refused.
      await expect(
        reg.connect(relayer).setOperatorSigned(...(await signSetOperator(stranger, reg, stranger.address, true)))
      ).to.be.revertedWithCustomError(reg, "InvalidSignature");
    });
  });
});
