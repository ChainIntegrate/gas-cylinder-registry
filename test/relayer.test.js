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

  /** The facts of a document's e-mail (review G-03): the relayer writes the text from its template. */
  const facts = (to, extra = {}) => ({ v: 2, to, lang: "it", company: "Argonia Gas Tecnici", who: "Officina Demo", kind: "delivery_note", number: "DDT 2026/118", date: 1790000000, lines: [{ serial: "AR-1", gas: "argon", movement: "delivery", condition: "full" }], ...extra });

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
    const [payload] = S.withManifest([{ docId, part: 0, parts: 1, corrects: ethers.ZeroHash, mints, updates, document }]);
    const v = S.validity(now, 3600);
    const signature = await sign(phone, payload, v);
    const digest = S.recordDocumentDigest(ctx.address, ctx.chainId, phone.address, payload, v);
    return { registry: ctx.address, payload, signer: phone.address, validity: S.validityJson(v), v, signature, lines, digest };
  }

  /** A phone's RecordDocument signature (version 2: with the validity). */
  function sign(wallet, payload, v, signer = wallet.address) {
    return wallet.signTypedData(ctx.domain, { RecordDocument: S.TYPES.RecordDocument }, { signer, payloadHash: S.hashPayload(payload), ...v });
  }

  beforeEach(async function () {
    [chainIntegrate, relayerSigner] = await ethers.getSigners();
    owner = ethers.Wallet.createRandom().connect(ethers.provider);
    phone = ethers.Wallet.createRandom();
    const f = await O.deployFactory(chainIntegrate, 2);
    factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
    const prepared = await O.prepareRegistry({ factory });
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
    await O.initializeKeys(ctx, await O.prepareKeys(r.address, password, "it"));
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
    expect(body.app).to.equal(undefined);
  });

  it("announces the latest released app from its file, and nothing invalid", async function () {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gcr-")), "app-release.json");
    await new Promise((res) => server.close(res));
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: await factory.getAddress(), appReleaseFile: file },
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    const url = "https://github.com/ChainIntegrate/gas-cylinder-registry/releases/download/v0.2.1/gastrace-v0.2.1.apk";

    expect((await get("/gcr/info")).body.app).to.equal(undefined); // no file yet
    fs.writeFileSync(file, JSON.stringify({ version: "0.2.1", url }));
    expect((await get("/gcr/info")).body.app).to.deep.equal({ version: "0.2.1", url }); // read at every request
    fs.writeFileSync(file, JSON.stringify({ version: "0.2.2", url })); // the link is not that version's
    expect((await get("/gcr/info")).body.app).to.equal(undefined);
    fs.writeFileSync(file, JSON.stringify({ version: "0.2.1", url: "https://example.com/v0.2.1/a.apk" }));
    expect((await get("/gcr/info")).body.app).to.equal(undefined);
    fs.writeFileSync(file, "{ not json");
    expect((await get("/gcr/info")).body.app).to.equal(undefined);
  });

  it("relays owner operations: the owner tools never paid gas", async function () {
    expect(await ctx.registry.isOperator(phone.address)).to.equal(true);
    expect(await ethers.provider.getBalance(owner.address)).to.equal(0n);
  });

  it("relays a document and sends its e-mail after the confirmation", async function () {
    const op = await delivery(3, "DDT 2026/118");
    const mail = facts(["demo@example.com", "Owner@Example.com", "demo@example.com"]);
    const mailSignature = await S.signMail(phone, ctx.address, op.digest, mail);
    const { status, body } = await post("/gcr/document", { ...op, mail, mailSignature });
    expect(status, JSON.stringify(body)).to.equal(200);
    const st = await waitFor(body.hash);
    expect(st).to.include({ state: "confirmed", mail: "sent" });
    expect(mails).to.have.length(1);
    expect(mails[0].to).to.equal("demo@example.com, owner@example.com");
    expect(mails[0].subject).to.equal("Argonia Gas Tecnici: DDT 2026/118");
    expect(mails[0].text).to.include("Documento per: Officina Demo").and.include("- AR-1  Argon  Consegna  Piena").and.include("Consegna: 1 Argon");
    expect(mails[0].attachments).to.equal(undefined);
    expect(await ctx.registry.totalSupply()).to.equal(3n);
    expect(await ethers.provider.getBalance(phone.address)).to.equal(0n);

    // The same operation again: the same transaction, no second e-mail.
    const again = await post("/gcr/document", { ...op, mail, mailSignature });
    expect(again.body).to.deep.equal({ hash: body.hash, repeated: true });
    expect(mails).to.have.length(1);
  });

  it("writes the e-mail only from its template: no text, no attachment, at most 8 recipients (review G-03)", async function () {
    const op = await delivery(1);
    for (const mail of [
      { to: ["demo@example.com"], subject: "Fattura scaduta", text: "Paga qui: http://phishing.example" }, // the old free-text form
      { ...facts(["demo@example.com"]), text: "free text" },
      { ...facts(["demo@example.com"]), attachment: { filename: "x.pdf", base64: Buffer.from("%PDF-1.4").toString("base64") } },
      facts(Array.from({ length: 9 }, (_, i) => `a${i}@b.it`)),
      facts(["demo@example.com"], { company: "Argonia\nBcc: spam@x.com" }),
      facts(["demo@example.com"], { lines: [{ serial: "AR-1", gas: "argon", movement: "delivery", condition: "full", anomaly: { code: "click_here" } }] }),
    ]) {
      const r = await post("/gcr/document", { ...op, mail, mailSignature: "0x" });
      expect(r.status, JSON.stringify(mail)).to.equal(400);
    }
    expect(mails).to.have.length(0);
  });

  it("stops a registry's e-mails at its daily limit; the documents are still recorded", async function () {
    await new Promise((res) => server.close(res));
    const relayer = createRelayer({ provider: ethers.provider, wallet: relayerSigner, config: { chainId: 31337, factory: await factory.getAddress(), limits: { mailsPerRegistryPerDay: 1 } }, sendMail: async (m) => mails.push(m), logger: () => {} });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    const states = [];
    for (let i = 0; i < 2; i++) {
      const op = await delivery(1);
      const mail = facts(["demo@example.com"]);
      const { body } = await post("/gcr/document", { ...op, mail, mailSignature: await S.signMail(phone, ctx.address, op.digest, mail) });
      states.push(await waitFor(body.hash));
    }
    expect(states.map((x) => [x.state, x.mail])).to.deep.equal([["confirmed", "sent"], ["confirmed", "failed"]]);
    expect(mails).to.have.length(1);
  });

  it("refuses an e-mail not signed by the phone, or changed after signing", async function () {
    const op = await delivery(1);
    const mail = facts(["demo@example.com"]);
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
      facts([]),
      facts(["not-an-address"]),
      facts(["a(b)@c.it"]),
      facts(["a@b.it"], { lang: "fr" }),
      facts(["a@b.it"], { lines: [] }),
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
    [dup.payload] = S.withManifest([{ ...dup.payload, docId: op.payload.docId }]);
    dup.signature = await sign(phone, dup.payload, dup.v);
    const r = await post("/gcr/document", dup);
    expect(r.status).to.equal(400);
    expect(r.body.detail.error).to.equal("DocumentPartAlreadyRecorded");
  });

  it("refuses unknown registries, unauthorized signers, oversized documents and other origins", async function () {
    const op = await delivery(1);
    const lookalike = await ethers.deployContract("GasCylinderRegistry");
    expect((await post("/gcr/document", { ...op, registry: await lookalike.getAddress() })).status).to.equal(403);

    const stranger = ethers.Wallet.createRandom();
    const signature = await sign(stranger, op.payload, op.v);
    expect((await post("/gcr/document", { ...op, signer: stranger.address, signature })).status).to.equal(403);

    const big = { ...op, payload: { ...op.payload, mints: Array.from({ length: 26 }, () => ethers.hexlify(ethers.randomBytes(32))) } };
    expect((await post("/gcr/document", big)).status).to.equal(400);

    expect((await post("/gcr/document", op, { origin: "https://evil.example" })).status).to.equal(403);
    expect((await post("/gcr/document", op, { origin: "https://localhost" })).status).to.equal(200);
  });

  it("keeps its work on disk: after a restart it sends the e-mail left unsent (review A07)", async function () {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gcr-")), "journal.json");
    await new Promise((res) => server.close(res));
    const factoryAddress = await factory.getAddress();
    // First run: the SMTP server never answers, then the relayer "stops".
    let first = createRelayer({ provider: ethers.provider, wallet: relayerSigner, config: { chainId: 31337, factory: factoryAddress, stateFile, receiptPollMs: 50 }, sendMail: () => new Promise(() => {}), logger: () => {} });
    server = first.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    const d = await delivery(1);
    const mail = facts(["demo@example.com"], { number: "DDT 7" });
    const mailSignature = await phone.signMessage(ethers.getBytes(S.mailDigest(ctx.address, d.digest, mail)));
    const r = await post("/gcr/document", { ...d, mail, mailSignature });
    expect(r.status).to.equal(200);
    while (!(await ethers.provider.getTransactionReceipt(r.body.hash))) await new Promise((res) => setTimeout(res, 50));
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(saved.ops.find((o) => o.hash === r.body.hash).pendingMail.number).to.equal("DDT 7");
    await new Promise((res) => server.close(res));

    // Second run, same journal: the e-mail leaves, its content leaves the disk, the status is known.
    const sent = [];
    const second = createRelayer({ provider: ethers.provider, wallet: relayerSigner, config: { chainId: 31337, factory: factoryAddress, stateFile, receiptPollMs: 50 }, sendMail: async (m) => sent.push(m), logger: () => {} });
    await second.resumed;
    server = second.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    expect(sent.map((m) => m.subject)).to.deep.equal(["Argonia Gas Tecnici: DDT 7"]);
    expect((await get(`/gcr/status?hash=${r.body.hash}`)).body).to.include({ state: "confirmed", mail: "sent" });
    expect(fs.readFileSync(stateFile, "utf8")).to.not.include("DDT 7");
    // The same operation again is recognized after the restart: same transaction, no second e-mail.
    expect((await post("/gcr/document", { ...d, mail, mailSignature })).body.hash).to.equal(r.body.hash);
    expect(sent).to.have.length(1);
    first = null;
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

  it("charges a registry's daily limit only for operations it sends (review G-01)", async function () {
    await new Promise((res) => server.close(res));
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: await factory.getAddress(), limits: { perRegistryPerDay: 2, perIpPerMinute: 1000 } },
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    const stranger = ethers.Wallet.createRandom();
    for (let i = 0; i < 20; i++) {
      // junk owner requests, documents signed by an unknown key, and badly signed documents
      expect((await post("/gcr/owner", { registry: ctx.address, method: "nothing", args: [] })).status).to.equal(400);
      const d = await delivery(1);
      expect((await post("/gcr/document", { ...d, signer: stranger.address })).status).to.equal(403);
      expect((await post("/gcr/document", { ...d, signature: "0x" + "11".repeat(65) })).status).to.equal(400);
    }
    expect((await post("/gcr/document", await delivery(1))).status).to.equal(200);
    const resent = await delivery(1);
    expect((await post("/gcr/document", resent)).status).to.equal(200);
    expect((await post("/gcr/document", resent)).status).to.equal(200); // the same operation again: not charged twice
    expect((await post("/gcr/document", await delivery(1))).status).to.equal(429);
  });

  it("limits each source before asking the node anything", async function () {
    await new Promise((res) => server.close(res));
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: await factory.getAddress(), limits: { perIpPerMinute: 3 } },
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    const foreign = ethers.Wallet.createRandom().address;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post("/gcr/owner", { registry: foreign, method: "nothing", args: [] }, { "x-real-ip": "198.51.100.7" })).status);
    expect(codes).to.deep.equal([403, 403, 403, 429, 429]);
    expect((await post("/gcr/owner", { registry: foreign, method: "nothing", args: [] }, { "x-real-ip": "198.51.100.8" })).status).to.equal(403);
  });

  it("e-mails the register's alert addresses and ChainIntegrate when a handover starts, however it was sent", async function () {
    await new Promise((res) => server.close(res));
    const sent = [];
    const relayer = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: await factory.getAddress(), handoverAlerts: { [ctx.address]: ["ufficio@example.com"] }, limits: { perIpPerMinute: 1000 } },
      sendMail: async (m) => sent.push(m),
      logger: () => {},
    });
    server = relayer.server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    await relayer.watchHandovers(); // the starting point: nothing before now
    // Started with the owner's own LYX, not through the relayer: the relayer sees it on the chain anyway.
    const direct = await O.context({ provider: ethers.provider, registry: ctx.address, owner, submit: O.directSubmitter(chainIntegrate) });
    await O.transferOwnership(direct, ethers.Wallet.createRandom().address);
    await relayer.watchHandovers();
    expect(sent.map((m) => m.to || "operator")).to.deep.equal(["ufficio@example.com", "operator"]);
    expect(sent[0].subject).to.match(/cessione del registro/);
    expect(sent[0].text).to.include("Annulla la cessione");
    await relayer.watchHandovers();
    expect(sent).to.have.length(2); // once
  });

  it("sends the owner's corrections and a phone's cancellations, and nobody else's", async function () {
    const op = await delivery(1);
    await waitFor((await post("/gcr/document", op)).body.hash);
    // A phone's document sent to /gcr/owner is refused: the owner's only there.
    const other = await delivery(1);
    const r = await post("/gcr/owner", { registry: ctx.address, method: "recordDocument", args: [other.payload, phone.address, other.validity, other.signature] });
    expect(r.status).to.equal(403);
    // A phone cancels its own unsent signature.
    const nonce = 7n;
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const v = S.validity(now, 3600);
    const sig = await phone.signTypedData(ctx.domain, { CancelNonces: S.TYPES.CancelNonces }, { signer: phone.address, nonces: [nonce], ...v });
    const c = await post("/gcr/owner", { registry: ctx.address, method: "cancelNoncesSigned", args: [phone.address, ["7"], phone.address, S.validityJson(v), sig] });
    expect(c.status).to.equal(200);
    await waitFor(c.body.hash);
    expect(await ctx.registry.isNonceUsed(phone.address, nonce)).to.equal(true);
    const stranger = ethers.Wallet.createRandom();
    const x = await post("/gcr/owner", { registry: ctx.address, method: "cancelNoncesSigned", args: [stranger.address, ["7"], stranger.address, S.validityJson(v), sig] });
    expect(x.status).to.equal(403);
  });
});
