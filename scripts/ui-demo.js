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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const accounts = await provider.send("eth_accounts", []);
  const chainIntegrate = await provider.getSigner(accounts[0]);
  const relayerSigner = await provider.getSigner(accounts[1]);
  const owner = ethers.Wallet.createRandom().connect(provider);
  const phone = ethers.Wallet.createRandom();

  // ChainIntegrate and the owner tools prepare the registry.
  const f = await O.deployFactory(chainIntegrate);
  const factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
  const prepared = await O.prepareRegistry({ factory, password, language: "it" });
  const r = await O.createRegistry({ factory, prepared, owner: owner.address, name: "Argonia Gas Tecnici cylinders", symbol: "ARGCYL" });

  const mails = [];
  const allowedOrigins = []; // the page's origin, added once its server runs
  const relayerServer = createRelayer({
    provider,
    wallet: relayerSigner,
    config: { chainId: Number((await provider.getNetwork()).chainId), factory: f.address, allowedOrigins, limits: { perIpPerMinute: 1000 } },
    sendMail: async (m) => mails.push(m),
    logger: () => {},
  }).server;
  await new Promise((res) => relayerServer.listen(0, "127.0.0.1", res));
  const relayerUrl = `http://127.0.0.1:${relayerServer.address().port}`;

  const ctx = await O.context({ provider, registry: r.address, owner, submit: O.relayerSubmitter(relayerUrl, provider), fromBlock: r.block });
  const { keys } = await O.unlockWithPassword(ctx, password);
  await O.writeSettings(ctx, keys, { company: "Argonia Gas Tecnici", emails: ["ufficio@example.com"] });
  await O.addCounterparty(ctx, keys, { type: "customer", name: "Officina Demo", emails: ["demo@example.com"] });
  await O.addCounterparty(ctx, keys, { type: "customer", name: "Cliente Due", emails: [] });
  const code = S.setupCode(r.address, r.block);

  // The app, built for the local chain and relayer.
  const cfg = path.join(os.tmpdir(), `gcr-app-config-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ rpc: RPC, chainId: Number((await provider.getNetwork()).chainId), relayer: relayerUrl }));
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
        remove: () => null,
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
  // New cylinders: choose the gas; the one left out of the count is collected.
  const lines = page.locator(".line");
  await lines.nth(0).locator("select").nth(0).selectOption("nitrogen"); // N2-400
  await lines.nth(0).locator("select").nth(1).selectOption("collection");
  await page.locator(".line").nth(0).locator("select").nth(2).selectOption("empty");
  await lines.nth(3).locator("select").nth(0).selectOption("argon"); // AR-301
  await lines.nth(4).locator("select").nth(0).selectOption("argon"); // AR-300
  await page.getByLabel("Numero DDT").fill("DDT 2026/118");
  await page.getByPlaceholder("Aggiungi un indirizzo (facoltativo)").first().fill("titolare@example.com");
  await shot("delivery-note");
  await click("Invia");
  await see("Mail inviata");
  await shot("delivery-note-done");
  await click("Chiudi");

  // 4. Check a cylinder.
  await click("Controlla una bombola");
  scans.push("AR-300");
  await click("Inquadra bombola");
  await see("Presso Officina Demo");
  await shot("check");

  // 5. English.
  await click("EN");
  await see("Check a cylinder");
  await shot("check-en");

  // Results
  const mail = mails.at(-1);
  const checks = [
    ["one e-mail", mails.length === 1],
    ["recipients", mail && mail.to === "demo@example.com, ufficio@example.com, titolare@example.com"],
    ["summary in the e-mail", mail && mail.text.includes("Consegna: 2 Argon") && /Ritiro: (?=.*1 Azoto)(?=.*1 Argon)(?=.*1 CO₂)/.test(mail.text)],
    ["subject", mail && mail.subject === "Argonia Gas Tecnici: DDT 2026/118"],
    ["no technical words on screen", texts.every((x) => !FORBIDDEN.test(x))],
    ["no technical words in the e-mail", mail && !FORBIDDEN.test(mail.text) && !/0x/.test(mail.text)],
    ["no page errors", errors.length === 0],
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
