"use strict";
// The relayer as an HTTP service on a local port, against the local chain, with a fake SMTP.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { createRelayer } = require("../relayer/relay");
const O = require("../scripts/lib/owner");
const S = require("../shared");

describe("relayer", function () {
  this.timeout(60000);
  const password = "le bombole di argon tornano vuote";
  let relayerSigner, chainIntegrate, owner, phone, factory, ctx, keys, server, base, mails, customer;

  async function post(path, body, headers = {}) {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    return { status: res.status, body: await res.json() };
  }
  async function get(path) {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  }
  async function waitFor(hash) {
    for (let i = 0; i < 100; i++) {
      const s = await get(`/gcr/status?hash=${hash}`);
      if (s.body.state !== "pending" && s.body.mail !== "pending") return s.body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout");
  }

  /** A delivery of `n` new cylinders to the customer, signed by the phone. */
  async function delivery(n, number = "DDT " + Math.random()) {
    const docId = await S.documentId(keys, customer, number);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const mints = [];
    const updates = [];
    const lines = [];
    for (let i = 0; i < n; i++) {
      const serial = `AR-${Math.floor(Math.random() * 1e9)}`;
      const t = await S.cylinderTokenId(keys, serial);
      mints.push(t);
      updates.push({ tokenId: t, dataKey: S.INFO_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(keys, t, "info", S.validateInfo({ v: 1, serial, gas: "argon", owner: "supplier", registeredAt: now })) });
      updates.push({ tokenId: t, dataKey: S.STATE_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(keys, t, "state", S.validateState({ v: 1, location: { type: "customer", id: customer }, condition: "full", lifecycle: "active", movement: "delivery", at: now })) });
      lines.push({ tokenId: t, serial, gas: "argon", movement: "delivery", condition: "full" });
    }
    const document = await S.encryptValue(keys, docId, "document", S.validateDocument({ v: 1, kind: "delivery_note", number, date: now, counterparty: customer, lines }));
    const payload = { docId, part: 0, parts: 1, corrects: ethers.ZeroHash, mints, updates, document };
    const nonce = S.randomNonce();
    const deadline = BigInt(now + 3600);
    const signature = await phone.signTypedData(ctx.domain, { RecordDocument: S.TYPES.RecordDocument }, { signer: phone.address, payloadHash: S.hashPayload(payload), nonce, deadline });
    const digest = S.recordDocumentDigest(ctx.address, ctx.chainId, phone.address, payload, nonce, deadline);
    return { registry: ctx.address, payload, signer: phone.address, nonce, deadline, signature, lines, digest };
  }

  beforeEach(async function () {
    [chainIntegrate, relayerSigner] = await ethers.getSigners();
    owner = ethers.Wallet.createRandom().connect(ethers.provider);
    phone = ethers.Wallet.createRandom();
    const f = await O.deployFactory(chainIntegrate);
    factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
    const prepared = await O.prepareRegistry({ factory, password });
    const r = await O.createRegistry({ factory, prepared, owner: owner.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });

    mails = [];
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: f.address, allowedOrigins: ["https://localhost"], minBalanceWarn: "0.1", limits: { perIpPerMinute: 1000 } },
      sendMail: async (m) => mails.push(m),
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;

    // The owner tools go through the relayer too.
    ctx = await O.context({ provider: ethers.provider, registry: r.address, owner, submit: O.relayerSubmitter(base, ethers.provider), fromBlock: r.block });
    keys = (await O.unlockWithPassword(ctx, password)).keys;
    await O.setOperator(ctx, phone.address, true);
    customer = await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: ["demo@example.com"] });
  });

  afterEach(async function () {
    await new Promise((res) => server.close(res));
  });

  it("answers its info", async function () {
    const { body } = await get("/gcr/info");
    expect(body.relayer).to.equal(relayerSigner.address);
    expect(body.chainId).to.equal(31337);
    expect(body.limits.maxMints).to.equal(25);
  });

  it("relays owner operations: the owner tools never paid gas", async function () {
    expect(await ctx.registry.isOperator(phone.address)).to.equal(true);
    expect(await ethers.provider.getBalance(owner.address)).to.equal(0n);
  });

  it("relays a document and sends its e-mail after the confirmation", async function () {
    const op = await delivery(3, "DDT 2026/118");
    const mail = { to: ["demo@example.com", "Owner@Example.com", "demo@example.com"], subject: "Consegna DDT 2026/118", text: "3 argon consegnate." };
    const mailSignature = await S.signMail(phone, ctx.address, op.digest, mail);
    const { status, body } = await post("/gcr/document", { ...op, mail, mailSignature });
    expect(status, JSON.stringify(body)).to.equal(200);
    const st = await waitFor(body.hash);
    expect(st).to.include({ state: "confirmed", mail: "sent" });
    expect(mails).to.have.length(1);
    expect(mails[0].to).to.equal("demo@example.com, owner@example.com");
    expect(mails[0].subject).to.equal("Consegna DDT 2026/118");
    expect(await ctx.registry.totalSupply()).to.equal(3n);
    expect(await ethers.provider.getBalance(phone.address)).to.equal(0n);

    // The same operation again: the same transaction, no second e-mail.
    const again = await post("/gcr/document", { ...op, mail, mailSignature });
    expect(again.body).to.deep.equal({ hash: body.hash, repeated: true });
    expect(mails).to.have.length(1);
  });

  it("sends a PDF attachment", async function () {
    const op = await delivery(1);
    const pdf = Buffer.from("%PDF-1.4\n% test\n").toString("base64");
    const mail = { to: ["demo@example.com"], subject: "Consegna", text: "Allegato il riepilogo.", attachment: { filename: "consegna.pdf", base64: pdf } };
    const { body } = await post("/gcr/document", { ...op, mail, mailSignature: await S.signMail(phone, ctx.address, op.digest, mail) });
    expect((await waitFor(body.hash)).mail).to.equal("sent");
    expect(mails[0].attachments[0]).to.include({ filename: "consegna.pdf", contentType: "application/pdf" });
  });

  it("refuses an e-mail not signed by the phone, or changed after signing", async function () {
    const op = await delivery(1);
    const mail = { to: ["demo@example.com"], subject: "Consegna", text: "ok" };
    const stranger = ethers.Wallet.createRandom();
    let r = await post("/gcr/document", { ...op, mail, mailSignature: await S.signMail(stranger, ctx.address, op.digest, mail) });
    expect(r.status).to.equal(403);
    const signed = await S.signMail(phone, ctx.address, op.digest, mail);
    r = await post("/gcr/document", { ...op, mail: { ...mail, to: ["someone@else.com"] }, mailSignature: signed });
    expect(r.status).to.equal(403);
    expect(mails).to.have.length(0);
    expect(await ctx.registry.totalSupply()).to.equal(0n);
  });

  it("refuses invalid e-mails before sending anything", async function () {
    const op = await delivery(1);
    for (const mail of [
      { to: [], subject: "x", text: "y" },
      { to: ["not-an-address"], subject: "x", text: "y" },
      { to: ["a@b.it"], subject: "x\nBcc: spam@x.com", text: "y" },
      { to: Array.from({ length: 11 }, (_, i) => `a${i}@b.it`), subject: "x", text: "y" },
      { to: ["a@b.it"], subject: "x", text: "y", attachment: { filename: "x.pdf", base64: Buffer.from("not a pdf").toString("base64") } },
    ]) {
      const r = await post("/gcr/document", { ...op, mail, mailSignature: "0x" });
      expect(r.status, JSON.stringify(mail)).to.equal(400);
    }
  });

  it("explains the registry's refusals and sends nothing", async function () {
    const op = await delivery(1);
    await waitFor((await post("/gcr/document", op)).body.hash);
    // Same document number again: the part is already recorded.
    const dup = await delivery(1);
    dup.payload.docId = op.payload.docId;
    dup.signature = await phone.signTypedData(ctx.domain, { RecordDocument: S.TYPES.RecordDocument }, { signer: phone.address, payloadHash: S.hashPayload(dup.payload), nonce: dup.nonce, deadline: dup.deadline });
    const r = await post("/gcr/document", dup);
    expect(r.status).to.equal(400);
    expect(r.body.detail.error).to.equal("DocumentPartAlreadyRecorded");
  });

  it("refuses unknown registries, unauthorized signers, oversized documents and other origins", async function () {
    const op = await delivery(1);
    const lookalike = await ethers.deployContract("GasCylinderRegistry");
    expect((await post("/gcr/document", { ...op, registry: await lookalike.getAddress() })).status).to.equal(403);

    const stranger = ethers.Wallet.createRandom();
    const signature = await stranger.signTypedData(ctx.domain, { RecordDocument: S.TYPES.RecordDocument }, { signer: stranger.address, payloadHash: S.hashPayload(op.payload), nonce: op.nonce, deadline: op.deadline });
    expect((await post("/gcr/document", { ...op, signer: stranger.address, signature })).status).to.equal(403);

    const big = { ...op, payload: { ...op.payload, mints: Array.from({ length: 26 }, () => ethers.hexlify(ethers.randomBytes(32))) } };
    expect((await post("/gcr/document", big)).status).to.equal(400);

    expect((await post("/gcr/document", op, { origin: "https://evil.example" })).status).to.equal(403);
    expect((await post("/gcr/document", op, { origin: "https://localhost" })).status).to.equal(200);
  });

  it("limits requests per registry per day", async function () {
    await new Promise((res) => server.close(res));
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: await factory.getAddress(), limits: { perRegistryPerDay: 1 } },
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    expect((await post("/gcr/document", await delivery(1))).status).to.equal(200);
    expect((await post("/gcr/document", await delivery(1))).status).to.equal(429);
  });
});
