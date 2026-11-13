"use strict";
// The app's logic against the local chain and the relayer: the demo, step by step.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { createRelayer } = require("../relayer/relay");
const O = require("../scripts/lib/owner");
const S = require("../shared");
const A = require("../app/src/logic");

class MemoryStorage {
  constructor() {
    this.m = {};
  }
  getItem(k) {
    return k in this.m ? this.m[k] : null;
  }
  setItem(k, v) {
    this.m[k] = String(v);
  }
}

describe("app logic", function () {
  this.timeout(120000);
  const password = "le bombole di argon tornano vuote";
  let ctx, server, base, mails, phone, reg, customerA, customerB, refill, names, now;

  const signDigests = (wallet) => async (digests) => digests.map((d) => wallet.signingKey.sign(d).serialized);

  async function scan(code, counterparty, kind) {
    const c = await reg.readCylinder(code);
    const p = A.propose(c, counterparty, kind, names);
    return { ...c, gas: c.info ? c.info.gas : "argon", ...p };
  }

  async function record({ counterparty, kind, number, lines, mailTo, wallet = phone, registry = reg, outbox = new A.Outbox(new MemoryStorage()) }) {
    const built = await A.buildDocument({ registry, operator: wallet.address, counterparty, kind, number, lines, now });
    const mail = mailTo ? A.buildMail({ lang: "it", company: "Argonia Gas Tecnici", counterparty, kind, number: built.number, lines, now, recipients: mailTo }) : null;
    const item = await A.signDocument({ registry, operator: wallet.address, built, mail, signDigests: signDigests(wallet), meta: { kind, number: built.number } });
    outbox.add(item);
    const sent = await A.sendItem(item, { relayer: base, pollMs: 20, onUpdate: (i) => outbox.update(i) });
    return { built, mail, item: sent, outbox };
  }

  before(async function () {
    const [chainIntegrate, relayerSigner] = await ethers.getSigners();
    const owner = ethers.Wallet.createRandom().connect(ethers.provider);
    phone = ethers.Wallet.createRandom();
    const f = await O.deployFactory(chainIntegrate);
    const factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
    const prepared = await O.prepareRegistry({ factory, password, language: "it" });
    const r = await O.createRegistry({ factory, prepared, owner: owner.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });

    mails = [];
    server = createRelayer({
      provider: ethers.provider,
      wallet: relayerSigner,
      config: { chainId: 31337, factory: f.address, limits: { perIpPerMinute: 1000 } },
      sendMail: async (m) => mails.push(m),
      logger: () => {},
    }).server;
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;

    // The owner tools prepare the demo.
    ctx = await O.context({ provider: ethers.provider, registry: r.address, owner, submit: O.relayerSubmitter(base, ethers.provider), fromBlock: r.block });
    const { keys } = await O.unlockWithPassword(ctx, password);
    await O.writeSettings(ctx, keys, { company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
    await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: ["demo@example.com"] });
    await O.addCounterparty(ctx, keys, { type: "customer", name: "Cliente Due", emails: [] });
    await O.addCounterparty(ctx, keys, { type: "refill", name: "Centro Ricarica Nord", emails: [] });
    await O.setOperator(ctx, phone.address, true);

    // The phone: setup code, password typed once, data key unwrapped.
    const setup = S.parseSetupCode(S.setupCode(r.address, r.block));
    reg = new A.Registry({ provider: ethers.provider, address: setup.registry, fromBlock: setup.fromBlock });
    expect(await reg.isAuthorized(phone.address)).to.equal(true);
    const dek = await S.unwrapWithPassword(await reg.passwordWrap(), password, reg.address);
    reg.keys = await S.deriveKeys(dek, reg.address);

    const list = await reg.counterparties();
    [customerB, refill, customerA] = [list.find((c) => c.name === "Cliente Due"), list.find((c) => c.type === "refill"), list.find((c) => c.name === "Officina Demo")];
    names = Object.fromEntries(list.map((c) => [c.id, c.name]));
    now = (await ethers.provider.getBlock("latest")).timestamp;
  });

  after(async function () {
    await new Promise((res) => server.close(res));
  });

  it("reads the owner's settings and lists", async function () {
    expect(await reg.settings()).to.deep.equal({ v: 1, company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
    expect([customerA.name, customerB.name, refill.name]).to.deep.equal(["Officina Demo", "Cliente Due", "Centro Ricarica Nord"]);
  });

  it("runs the demo: stock count at the customer, then a delivery note with deliveries and collections", async function () {
    // Stock count: two empty cylinders already at the customer (one more is left out on purpose).
    const counted = [];
    for (const code of ["AR-100", "co2-200"]) {
      const l = await scan(code, customerA, "stock_count");
      expect(l.known).to.equal(false);
      counted.push({ ...l, gas: code.startsWith("AR") ? "argon" : "co2", condition: "empty" });
    }
    const sc = await record({ counterparty: customerA, kind: "stock_count", lines: counted });
    expect(sc.item.done).to.equal(true);

    // The driver arrives: two new full cylinders delivered, the counted ones and the one left out collected.
    const lines = [];
    for (const code of ["AR-300", "AR-301"]) {
      const l = await scan(code, customerA, "delivery_note");
      expect(l).to.include({ known: false, movement: "delivery", condition: "full" });
      lines.push(l);
    }
    for (const code of ["AR-100", "CO2-200"]) {
      const l = await scan(code, customerA, "delivery_note");
      expect(l).to.include({ known: true, movement: "collection", condition: "empty", gas: code.startsWith("AR") ? "argon" : "co2" });
      expect(l.anomaly).to.equal(null);
      lines.push(l);
    }
    const leftOut = await scan("N2-400", customerA, "delivery_note");
    lines.push({ ...leftOut, gas: "nitrogen", movement: "collection", condition: "empty" });

    const settings = await reg.settings();
    const to = [...customerA.emails, ...settings.emails, "extra@example.com"];
    const { item, mail } = await record({ counterparty: customerA, kind: "delivery_note", number: "DDT 2026/118", lines, mailTo: to });
    expect(item.done).to.equal(true);
    expect(item.mail).to.equal("sent");

    // The e-mail, in plain words.
    const sent = mails.at(-1);
    expect(sent.to).to.equal("demo@example.com, ufficio@example.com, extra@example.com");
    expect(sent.subject).to.equal("Argonia Gas Tecnici: DDT 2026/118");
    expect(sent.text).to.include("Consegna: 2 Argon");
    expect(sent.text).to.include("Ritiro: 1 Argon, 1 CO₂, 1 Azoto");
    expect(sent.text).to.include("- AR-300  Argon  Consegna  Piena");
    expect(mail.text).to.equal(sent.text);
    for (const word of ["blockchain", "token", "transazione", "LUKSO", "gas fee", "wallet", "0x"]) expect(sent.text).to.not.include(word);

    // Scanning again shows the new states.
    expect((await reg.readCylinder("AR-300")).state.location).to.deep.equal({ type: "customer", id: customerA.id });
    expect((await reg.readCylinder("AR-100")).state).to.deep.include({ location: { type: "depot" }, condition: "empty", movement: "collection" });
    expect((await reg.readCylinder("N2-400")).info.gas).to.equal("nitrogen");
  });

  it("warns when a cylinder does not fit: at another customer, being refilled, owned elsewhere", async function () {
    // AR-300 is at customer A: scanned at customer B it is proposed as a collection, with a warning.
    const l = await scan("AR-300", customerB, "delivery_note");
    expect(l.movement).to.equal("collection");
    expect(l.anomaly).to.deep.equal({ code: "at_other", name: "Officina Demo" });
    expect(A.anomalyText(require("../app/src/i18n").T.it, l.anomaly)).to.equal("Risulta presso Officina Demo");

    // At the depot: a refill note proposes sending it to refill.
    const atDepot = await scan("AR-100", refill, "refill_note");
    expect(atDepot).to.include({ movement: "to_refill", condition: "empty" });
    expect(atDepot.anomaly).to.equal(null);
  });

  it("sends cylinders to refill and back", async function () {
    const out = await record({ counterparty: refill, kind: "refill_note", number: "R-1", lines: [await scan("AR-100", refill, "refill_note")] });
    expect(out.item.done).to.equal(true);
    const back = await scan("AR-100", refill, "refill_note");
    expect(back).to.include({ movement: "from_refill", condition: "full" });
    // While at the refill plant, a delivery warns.
    const atRefill = await scan("AR-100", customerB, "delivery_note");
    expect(atRefill.anomaly).to.deep.equal({ code: "at_refill", name: "Centro Ricarica Nord" });
    await record({ counterparty: refill, kind: "refill_note", number: "R-2", lines: [back] });
    expect((await reg.readCylinder("AR-100")).state).to.deep.include({ location: { type: "depot" }, condition: "full" });
  });

  it("splits a large document into parts, the e-mail with the last one", async function () {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(await scan(`BIG-${i}`, customerB, "delivery_note"));
    const { built, item } = await record({ counterparty: customerB, kind: "delivery_note", number: "DDT 2026/200", lines, mailTo: ["ufficio@example.com"] });
    expect(built.parts.length).to.equal(2);
    expect(built.parts[0].payload.mints.length).to.equal(25); // 25 new cylinders per part (50 updates)
    expect(built.parts[1].payload.document).to.not.equal("0x");
    expect(item.done, JSON.stringify({ failed: item.failed, parts: item.parts.map((p) => p.state) })).to.equal(true);
    expect(item.mail).to.equal("sent");
    expect(await reg.contract.isDocumentPartRecorded(built.docId, 1)).to.equal(true);
  });

  it("keeps a document signed offline and sends it later", async function () {
    const outbox = new A.Outbox(new MemoryStorage());
    const lines = [await scan("OFF-1", customerB, "delivery_note")];
    const built = await A.buildDocument({ registry: reg, operator: phone.address, counterparty: customerB, kind: "delivery_note", number: "DDT OFF", lines, now });
    const item = await A.signDocument({ registry: reg, operator: phone.address, built, mail: null, signDigests: signDigests(phone), meta: {} });
    outbox.add(item);
    const failing = async () => {
      throw new TypeError("Failed to fetch");
    };
    const r1 = await A.sendItem(item, { relayer: base, fetchFn: failing, onUpdate: (i) => outbox.update(i) });
    expect(r1.offline).to.equal(true);
    expect(outbox.pending()).to.have.length(1);

    const again = outbox.list()[0];
    const r2 = await A.sendItem(again, { relayer: base, pollMs: 20, onUpdate: (i) => outbox.update(i) });
    expect(r2.done).to.equal(true);
    expect(outbox.pending()).to.have.length(0);
  });

  it("finds a document on the network when the relayer forgot it (restarted)", async function () {
    const lines = [await scan("RST-1", customerB, "delivery_note")];
    const built = await A.buildDocument({ registry: reg, operator: phone.address, counterparty: customerB, kind: "delivery_note", number: "DDT RST", lines, now });
    const mail = A.buildMail({ lang: "it", company: "Argonia Gas Tecnici", counterparty: customerB, kind: "delivery_note", number: built.number, lines, now, recipients: ["ufficio@example.com"] });
    const item = await A.signDocument({ registry: reg, operator: phone.address, built, mail, signDigests: signDigests(phone), meta: {} });
    // Sent, then the relayer "restarts": every status answer is 404.
    const forgetful = async (url, opts) => (String(url).includes("/gcr/status") ? new Response(JSON.stringify({ error: "unknown transaction" }), { status: 404 }) : fetch(url, opts));
    const out = await A.sendItem(item, { relayer: base, provider: ethers.provider, fetchFn: forgetful, pollMs: 20 });
    expect(out.done).to.equal(true);
    expect(out.mail).to.equal("unknown");
  });

  it("refuses a document built on an old state, and says why in plain words", async function () {
    // Two phones read the same cylinder; the second one sends after the first.
    const other = ethers.Wallet.createRandom();
    await O.setOperator(ctx, other.address, true);
    const l1 = await scan("AR-301", customerA, "delivery_note");
    const l2 = await scan("AR-301", customerA, "delivery_note");
    await record({ counterparty: customerA, kind: "delivery_note", number: "DDT P1", lines: [l1] });
    const { item } = await record({ counterparty: customerA, kind: "delivery_note", number: "DDT P2", lines: [l2], wallet: other });
    expect(item.failed.error).to.equal("StaleValue");
    expect(A.errorText("it", item.failed)).to.equal("Una bombola è cambiata nel frattempo: rifai il documento.");
  });

  it("refuses the same document number twice for the same customer", async function () {
    const { item } = await record({ counterparty: customerA, kind: "delivery_note", number: "DDT 2026/118", lines: [await scan("NEW-9", customerA, "delivery_note")] });
    expect(item.failed.error).to.equal("DocumentPartAlreadyRecorded");
  });

  it("refuses codes that cannot be a label", async function () {
    let err;
    try {
      await reg.readCylinder("#");
    } catch (e) {
      err = e;
    }
    expect(err.message).to.match(/invalid serial/);
  });
});
