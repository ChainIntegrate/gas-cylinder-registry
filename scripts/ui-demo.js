#!/usr/bin/env node
"use strict";
// The app's interface in Chromium (phone size) against a local chain and the relayer: the demo from the
// phone's setup to a delivery note with its e-mail. Only the phone's native parts are simulated
// (fingerprint key and camera), by window.__GCR_NATIVE__.
//
//   npx hardhat node &                      (in another terminal)
//   node scripts/ui-demo.js [screenshots-dir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { ethers } = require("ethers");
const O = require("./lib/owner");
const S = require("../shared");
const { createRelayer } = require("../relayer/relay");

const RPC = process.env.RPC || "http://127.0.0.1:8545";
const SHOTS = process.argv[2] || null;
const FORBIDDEN = /blockchain|token|wallet|transaz|transaction|LUKSO|\bLYX\b|\bgas fee|smart contract|indirizzo 0x|address/i;
const password = "le bombole di argon tornano vuote";

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, req.url === "/" ? "index.html" : req.url.split("?")[0]);
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// A newer app announced by the relayer: the home shows the notice and its download link.
const NEWER = { version: "9.9.9", url: "https://github.com/ChainIntegrate/gas-cylinder-registry/releases/download/v9.9.9/gastrace-v9.9.9.apk" };

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const accounts = await provider.send("eth_accounts", []);
  const chainIntegrate = await provider.getSigner(accounts[0]);
  const relayerSigner = await provider.getSigner(accounts[1]);
  const owner = ethers.Wallet.createRandom().connect(provider);
  const phone = ethers.Wallet.createRandom();

  // ChainIntegrate and the owner tools prepare the registry.
  const f = await O.deployFactory(chainIntegrate, 2);
  const factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
  const prepared = await O.prepareRegistry({ factory });
  const r = await O.createRegistry({ factory, prepared, owner: owner.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });

  const mails = [];
  const allowedOrigins = []; // the page's origin, added once its server runs
  // No release announced at first: the notice is checked at the end (step 5), when one is.
  const relayerConfig = { chainId: Number((await provider.getNetwork()).chainId), factory: f.address, allowedOrigins, limits: { perIpPerMinute: 1000 } };
  const relayerServer = createRelayer({
    provider,
    wallet: relayerSigner,
    config: relayerConfig,
    sendMail: async (m) => mails.push(m),
    logger: () => {},
  }).server;
  await new Promise((res) => relayerServer.listen(0, "127.0.0.1", res));
  const relayerUrl = `http://127.0.0.1:${relayerServer.address().port}`;

  const ctx = await O.context({ provider, registry: r.address, owner, submit: O.relayerSubmitter(relayerUrl, provider), fromBlock: r.block });
  await O.initializeKeys(ctx, await O.prepareKeys(r.address, password, "it"));
  const { keys } = await O.unlockWithPassword(ctx, password);
  await O.writeSettings(ctx, keys, { company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
  await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: ["demo@example.com"] });
  await O.addCounterparty(ctx, keys, { type: "customer", name: "Cliente Due", emails: [] });
  await O.addCounterparty(ctx, keys, { type: "refill", name: "Centro Ricarica Nord", emails: [] });
  const code = S.setupCode(r.address, r.block);

  // The app, built for the local chain and relayer.
  const cfg = path.join(os.tmpdir(), `gcr-app-config-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ rpc: RPC, chainId: Number((await provider.getNetwork()).chainId), relayer: relayerUrl, factory: f.address }));
  execFileSync("node", [path.join(__dirname, "build-app.js")], { env: { ...process.env, GCR_APP_CONFIG: cfg }, stdio: "inherit" });
  const web = await serve(path.join(__dirname, "..", "app", "www"));
  const appUrl = `http://127.0.0.1:${web.address().port}/`;
  allowedOrigins.push(new URL(appUrl).origin);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: "it-IT" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // The simulated native side: the phone key (a wallet here) and the camera (a queue of codes).
  let created = false;
  let dataKey = null;
  let removed = false;
  const scans = [];
  await page.exposeFunction("__nativeCall", async (name, arg) => {
    if (name === "status") return { exists: created, address: created ? phone.address : null, canAuth: true, hasDataKey: !!dataKey };
    if (name === "create") {
      created = true;
      return { address: phone.address };
    }
    if (name === "signDigests") return arg.map((d) => phone.signingKey.sign(d).serialized);
    if (name === "storeDataKey") return void (dataKey = arg);
    if (name === "loadDataKey") return dataKey;
    if (name === "remove") return void ((created = false), (dataKey = null), (removed = true));
    if (name === "scan") return scans.shift() || null;
    throw new Error("unknown " + name);
  });
  await page.addInitScript(() => {
    const c = (n, a) => window.__nativeCall(n, a);
    window.__GCR_NATIVE__ = {
      deviceKey: {
        status: () => c("status"),
        create: () => c("create"),
        signDigests: (d) => c("signDigests", d),
        storeDataKey: (k) => c("storeDataKey", k),
        loadDataKey: () => c("loadDataKey"),
        remove: () => c("remove"),
      },
      scan: () => c("scan"),
    };
  });

  let n = 0;
  const texts = [];
  async function shot(name) {
    const text = await page.locator("#app").innerText();
    texts.push(text);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true });
  }
  // The screen as the driver sees it (the guide's pictures): no full-page stitching.
  async function screen(name) {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, "0")}-${name}.png`) });
  }
  const click = (name) => page.getByRole("button", { name, exact: true }).click();
  const see = async (text) => {
    try {
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 30000 });
    } catch (e) {
      console.log("PAGE:", await page.locator("#app").innerText(), "\nERRORS:", errors);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "failure.png"), fullPage: true });
      throw e;
    }
  };

  // 1. Setup
  // A clock the test can move forward (the 10-minute lock), otherwise flowing as usual.
  await page.clock.install();
  await page.goto(appUrl);
  await see("Configurazione del telefono");
  await shot("setup");
  await page.getByPlaceholder("GCR1:…").fill(code);
  await click("Conferma");
  await click("Crea la chiave (impronta o PIN)");
  await see("In attesa dell'autorizzazione del titolare");
  await shot("phone-code");
  const shown = await page.locator(".phone-code").innerText();
  const typed = "0x" + shown.replace(/\s+/g, ""); // what the owner tools do with the code as typed
  if (typed.toLowerCase() !== phone.address.toLowerCase()) throw new Error("the page shows another phone code");
  await O.setOperator(ctx, typed, true); // the owner: node scripts/owner.js add-phone <code>
  await see("Telefono autorizzato");
  await page.getByPlaceholder("Password dei dati").fill(password);
  await shot("password");
  await click("Conferma");
  await see("Argonia Gas Tecnici");
  await shot("home");

  // 2. Stock count at the customer: two cylinders, one left out on purpose.
  await click("Giacenze");
  await click("Officina Demo");
  for (const [serial, gas] of [["AR-100", "argon"], ["CO2-200", "co2"]]) {
    await page.getByPlaceholder("Scrivi il codice").fill(serial);
    await click("Aggiungi");
    await see(serial);
    await page.locator(".line").first().locator("select").first().selectOption(gas);
    await page.locator(".line").first().locator('input[type="month"]').fill("2022-05"); // the stamped last test
    await page.locator(".line").first().locator("select").last().selectOption("empty");
  }
  await shot("stock-count");
  await click("Invia");
  await see("Registrato.");
  await shot("stock-count-done");
  await click("Chiudi");

  // 3. The driver arrives: delivery note with two new full cylinders and three collections.
  await click("Consegna / ritiro");
  await click("Officina Demo");
  scans.push("AR-300", "AR-301", "AR-100", "CO2-200", "N2-400");
  for (let i = 0; i < 5; i++) {
    await click("Inquadra bombola");
    await page.waitForFunction((k) => document.querySelectorAll(".line").length === k, i + 1);
  }
  // New cylinders: the gas, who owns it and the periodic test; the one left out of the count is collected.
  // A new line's selects: gas, owner, test (last or expiry), movement, condition.
  const lines = page.locator(".line");
  await lines.nth(0).locator("select").nth(0).selectOption("nitrogen"); // N2-400, the customer's own
  await lines.nth(0).locator("select").nth(1).selectOption({ label: "Del cliente (Officina Demo)" });
  await lines.nth(0).locator("select").nth(2).selectOption("unreadable");
  await lines.nth(0).locator("select").nth(3).selectOption("collection");
  await page.locator(".line").nth(0).locator("select").nth(4).selectOption("empty");
  await lines.nth(3).locator("select").nth(0).selectOption("argon"); // AR-301
  await lines.nth(3).locator("select").nth(2).selectOption("due");
  await lines.nth(3).locator('input[type="month"]').fill("2033-09");
  await lines.nth(4).locator("select").nth(0).selectOption("argon"); // AR-300
  await lines.nth(4).locator('input[type="month"]').fill("2024-01");
  await page.getByLabel("Numero DDT").fill("DDT 2026/118");
  await page.getByPlaceholder("Aggiungi un indirizzo (facoltativo)").first().fill("titolare@example.com");
  await shot("delivery-note");
  await page.evaluate(() => window.scrollTo(0, 0));
  await screen("delivery-note-top");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await screen("delivery-note-bottom");
  await click("Invia");
  await see("Mail inviata");
  await shot("delivery-note-done");
  await click("Chiudi");

  // 3b. A cylinder changes while the driver prepares a document (review A12): another phone records a
  // collection of AR-300; the driver's document is refused, "Make the document again" reopens it from
  // the cylinders' current state, and it is recorded.
  await click("Consegna / ritiro");
  await click("Officina Demo");
  scans.push("AR-300");
  await click("Inquadra bombola");
  await page.waitForFunction(() => document.querySelectorAll(".line").length === 1);
  await page.getByLabel("Numero DDT").fill("DDT 2026/119");
  {
    const L = require("../app/src/logic");
    const other = ethers.Wallet.createRandom();
    await O.setOperator(ctx, other.address, true);
    const reg = new L.Registry({ provider, address: r.address, fromBlock: r.block });
    reg.keys = keys;
    const cp = (await O.listCounterparties(ctx, keys)).find((c) => c.name === "Officina Demo");
    const cyl = await reg.readCylinder("AR-300");
    const now = (await provider.getBlock("latest")).timestamp;
    const built = await L.buildDocument({ registry: reg, operator: other.address, counterparty: cp, kind: "delivery_note", number: "DDT ALTRO", lines: [{ ...cyl, ...L.propose(cyl, cp, "delivery_note", {}), gas: cyl.info.gas }], now });
    const item = await L.signDocument({ registry: reg, operator: other.address, built, mail: null, signDigests: async (ds) => ds.map((d) => other.signingKey.sign(d).serialized), meta: {} });
    const sent = await L.sendItem(item, { relayer: relayerUrl, pollMs: 100 });
    if (!sent.done) throw new Error("the other phone's document was not recorded");
  }
  await click("Invia");
  await see("Una bombola è cambiata nel frattempo");
  await shot("refused");
  await click("Rifai il documento");
  await see("Documento rifatto");
  const redoneText = await page.locator("#app").innerText();
  await click("Invia");
  await see("Registrato.");
  await click("Chiudi");

  // 3c. Refill: AR-100 (at the depot, empty) goes to the refill plant and comes back full and tested.
  for (const [number, tested] of [["R-1", false], ["R-2", true]]) {
    await click("Ricarica");
    await click("Centro Ricarica Nord");
    scans.push("AR-100");
    await click("Inquadra bombola");
    await page.waitForFunction(() => document.querySelectorAll(".line").length === 1);
    if (tested) {
      await page.getByLabel("Collaudata").check();
      await page.locator(".line").first().locator('input[type="month"]').fill("2026-11");
      await shot("refill-tested");
    }
    await page.getByLabel("Numero documento").fill(number);
    await click("Invia");
    await see("Registrato.");
    await click("Chiudi");
  }

  // 4. Check a cylinder.
  await click("Controlla una bombola");
  scans.push("AR-300");
  await click("Inquadra bombola");
  await see("Presso Officina Demo");
  await shot("check");

  // 5. A new release announced by the relayer: the notice when the network returns.
  await click("Indietro");
  relayerConfig.appRelease = NEWER;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await see("È disponibile una nuova versione di GasTrace (9.9.9)");
  const updateLink = await page.getByText("Scarica", { exact: true }).getAttribute("href");
  await shot("update");

  // 6. English.
  await click("EN");
  await see("Check a cylinder");
  await shot("home-en");
  await click("IT");

  // 7. Review A09: nothing readable on the phone; locked after 10 minutes unused; a revoked phone
  // erases its key and its data.
  const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  await page.clock.fastForward("11:00");
  await see("App bloccata");
  const lockedText = await page.locator("#app").innerText();
  await O.setOperator(ctx, phone.address, false); // the owner revokes the phone
  await click("Sblocca con impronta o PIN");
  await see("è stato revocato");
  await shot("revoked");
  const readBack = new (require("../app/src/logic").Registry)({ provider, address: r.address, fromBlock: r.block, keys });
  const testedState = (await readBack.readCylinder("AR-100")).state;
  const n2 = await readBack.readCylinder("N2-400");
  const [n2Info, n2State] = [n2.info, n2.state];
  const ar301State = (await readBack.readCylinder("AR-301")).state;
  const afterWipe = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("gcr.") && k !== "gcr.lang"));

  // Results
  const mail = mails[0]; // the delivery note of step 3
  const checks = [
    ["update notice links the release", updateLink === NEWER.url],
    ["nothing readable stored on the phone (A09)", stored.length > 0 && !/Officina|example\.com|AR-300/.test(stored) && /gcrv1:/.test(stored)],
    ["locked after 10 minutes unused (A09)", /Sblocca/.test(lockedText) && !/Consegna \/ ritiro/.test(lockedText)],
    ["a revoked phone erases its key and data (A09)", removed && afterWipe.length === 0],
    ["one e-mail per document (steps 3, 3b and the two refill notes)", mails.length === 4 && /2026\/119/.test(mails[1].subject) && /R-2/.test(mails[3].subject)],
    ["a cylinder back tested: the new test in its state", testedState && testedState.test && testedState.test.last === "2026-11"],
    ["a new cylinder's owner and test, as chosen", n2Info && n2Info.owner !== "supplier" && n2State && n2State.test && n2State.test.unreadable === true && ar301State && ar301State.test.due === "2033-09"],
    ["a refused document made again from the current state (A12)", /Consegna/.test(redoneText) && /AR-300/.test(redoneText)],
    ["recipients", mail && mail.to === "demo@example.com, ufficio@example.com, titolare@example.com"],
    ["summary in the e-mail", mail && mail.text.includes("Consegna: 2 Argon") && /Ritiro: (?=.*1 Azoto)(?=.*1 Argon)(?=.*1 CO₂)/.test(mail.text)],
    ["subject", mail && mail.subject === "Argonia Gas Tecnici: DDT 2026/118"],
    ["no technical words on screen", texts.every((x) => !FORBIDDEN.test(x))],
    ["no technical words in the e-mail", mail && !FORBIDDEN.test(mail.text) && !/0x/.test(mail.text)],
    // The one 400 is the relayer refusing step 3b's document on purpose; the browser logs it.
    ["no page errors", errors.filter((e) => !/status of 400/.test(e)).length === 0 && errors.filter((e) => /status of 400/.test(e)).length <= 1],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    ok = ok && pass;
  }
  if (!ok) {
    console.log("errors:", errors);
    console.log("mail:", mail);
    console.log("texts with forbidden words:", texts.filter((x) => FORBIDDEN.test(x)).map((x) => x.match(FORBIDDEN)[0]));
  }
  await browser.close();
  web.close();
  relayerServer.close();
  fs.unlinkSync(cfg);
  execFileSync("node", [path.join(__dirname, "build-app.js")], { stdio: "ignore" }); // back to the real config
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
