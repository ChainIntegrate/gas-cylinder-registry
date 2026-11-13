#!/usr/bin/env node
"use strict";
// The GasTrace admin page in Chromium against a local chain and the relayer. The owner is a contract account
// that validates signatures with ERC-1271, as a ChainIntegrate Account (a Universal Profile) does; the
// extension is simulated by an EIP-6963 provider with its rdns. When the up-onboarding repository is next
// to this one (or UPONBOARDING_DIR is set), every request is also checked against the extension's own
// catalog, so the page asks only for what the extension accepts.
//
//   npx hardhat node &
//   node scripts/admin-demo.js [screenshots-dir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { ethers } = require("ethers");
const O = require("./lib/owner");
const S = require("../shared");
const A = require("../app/src/logic");
const { createRelayer } = require("../relayer/relay");

const RPC = process.env.RPC || "http://127.0.0.1:8545";
const SHOTS = process.argv[2] || null;
const FORBIDDEN = /blockchain|token|wallet|transaz|transaction|LUKSO|\bLYX\b|smart contract|0x[0-9a-f]{6}/i;
const PASSWORD = "le bombole di argon tornano vuote";
const CATALOG_PATHS = [process.env.UPONBOARDING_DIR, path.join(__dirname, "..", "..", "chainintegrate", "up-onboarding"), path.join(__dirname, "..", "..", "up-onboarding")]
  .filter(Boolean)
  .map((d) => path.resolve(d, "extension", "shared", "catalog.js")); // absolute: require() resolves relative paths from this file

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };
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
  const { chainId } = await provider.getNetwork();

  // The owner: a contract account whose controller key signs (ERC-1271), like a ChainIntegrate Account.
  const controller = ethers.Wallet.createRandom();
  const { abi, bytecode } = require("../artifacts/contracts/test/MockContractAccount.sol/MockContractAccount.json");
  const account = await new ethers.ContractFactory(abi, bytecode, chainIntegrate).deploy(controller.address);
  await account.waitForDeployment();
  const owner = await account.getAddress();

  // ChainIntegrate: factory and the registry, created for the account.
  const f = await O.deployFactory(chainIntegrate);
  const factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
  const prepared = await O.prepareRegistry({ factory, password: PASSWORD, language: "it" });
  const r = await O.createRegistry({ factory, prepared, owner, name: "Argonia Gas Tecnici", symbol: "ARGCYL" });

  // The extension's catalog, configured as it will be for GasTrace.
  let catalog = null;
  const catalogFile = CATALOG_PATHS.find((p) => fs.existsSync(p));
  if (catalogFile) {
    globalThis.ethers = ethers; // the catalog takes ethers from the global scope when it has no node_modules of its own
    catalog = require(catalogFile);
    const p = catalog.projectById("gas-cylinders");
    p.typed.madeBy = { factory: f.address, check: "isRegistry(address)" };
    p.typed.chainIds = [Number(chainId)];
  }

  const mails = [];
  const allowedOrigins = [];
  const relayerServer = createRelayer({
    provider,
    wallet: relayerSigner,
    config: { chainId: Number(chainId), factory: f.address, allowedOrigins, limits: { perIpPerMinute: 1000 } },
    sendMail: async (m) => mails.push(m),
    logger: () => {},
  }).server;
  await new Promise((res) => relayerServer.listen(0, "127.0.0.1", res));
  const relayerUrl = `http://127.0.0.1:${relayerServer.address().port}`;

  const cfg = path.join(os.tmpdir(), `gcr-admin-config-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ rpc: RPC, chainId: Number(chainId), relayer: relayerUrl, factory: f.address, factoryBlock: f.block }));
  execFileSync("node", [path.join(__dirname, "build-admin.js")], { env: { ...process.env, GCR_ADMIN_CONFIG: cfg }, stdio: "inherit" });
  const web = await serve(path.join(__dirname, "..", "admin", "www"));
  const pageUrl = `http://127.0.0.1:${web.address().port}/`;
  allowedOrigins.push(new URL(pageUrl).origin);

  const browser = await chromium.launch();
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: "it-IT" });
  const page = await ctxB.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // The simulated extension: EIP-6963 with ChainIntegrate Account's rdns; typed data checked against the catalog.
  const catalogChecks = [];
  await page.exposeFunction("__ext", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [owner];
    if (method === "eth_chainId") return "0x" + Number(chainId).toString(16);
    if (method === "eth_signTypedData_v4") {
      const typed = JSON.parse(params[1]);
      if (ethers.getAddress(params[0]) !== owner) throw new Error("other account");
      if (catalog) {
        const c = catalog.typedData(catalog.projectById("gas-cylinders"), typed, { account: owner, chainId: Number(chainId) });
        catalogChecks.push(c.ok ? typed.primaryType : `REFUSED ${typed.primaryType}: ${c.error}`);
        if (!c.ok) throw new Error("refused by the catalog: " + c.error);
        if (!(await catalog.verifyNeeds(provider, c.needs))) throw new Error("not a registry of the factory");
      }
      const types = { [typed.primaryType]: typed.types[typed.primaryType] };
      return controller.signingKey.sign(ethers.TypedDataEncoder.hash(typed.domain, types, typed.message)).serialized;
    }
    throw new Error("method not allowed: " + method);
  });
  await page.addInitScript(() => {
    const provider = { request: ({ method, params }) => window.__ext(method, params || []) };
    const info = { uuid: "00000000-0000-4000-8000-000000000001", name: "ChainIntegrate Account", icon: "data:,", rdns: "it.chainintegrate.account" };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } })));
  });

  let n = 0;
  const texts = [];
  async function shot(name, p = page) {
    texts.push(await p.locator("#app").innerText());
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `admin-${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true });
  }
  const click = (name, p = page) => p.getByRole("button", { name, exact: true }).first().click();
  const see = async (text, p = page) => {
    try {
      await p.getByText(text, { exact: false }).first().waitFor({ timeout: 30000 });
    } catch (e) {
      console.log("PAGE:", await p.locator("#app").innerText(), "\nERRORS:", errors, "\nCATALOG:", catalogChecks);
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "admin-failure.png"), fullPage: true });
      throw e;
    }
  };
  // After a click that changes something: the page shows its busy box at once, then "Fatto." once recorded.
  const done = async () => {
    await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
    await see("Fatto.");
  };

  // Sign in and open the data.
  await page.goto(pageUrl);
  await see("Accedi con ChainIntegrate Account");
  await shot("connect");
  await click("Accedi con ChainIntegrate Account");
  await see("Apri i dati");
  await page.locator("input[type=password]").fill(PASSWORD);
  await shot("unlock");
  await click("Apri");
  await see("Panoramica");

  // Settings, customers, a refill plant.
  await click("Impostazioni");
  await see("Nome dell'azienda");
  await page.getByLabel("Nome dell'azienda").fill("Argonia Gas Tecnici");
  await page.getByLabel("Email dell'azienda (separate da virgola)").fill("ufficio@example.com, magazzino@example.com");
  await shot("settings");
  await click("Salva");
  await done();
  await click("Clienti");
  for (const [name, email] of [["Officina Demo", "demo@example.com"], ["Carpenteria Rossi", ""]]) {
    await click("+ Aggiungi cliente");
    await page.getByLabel("Nome", { exact: true }).fill(name);
    await page.getByLabel("Email (separate da virgola)").fill(email);
    await click("Salva");
    await done();
  }
  await click("+ Aggiungi centro di ricarica");
  await page.getByLabel("Nome", { exact: true }).fill("Centro Ricarica Nord");
  await click("Salva");
  await done();
  await shot("customers");

  // A phone: its setup code (QR) and its authorization by the code the app shows.
  const phone = ethers.Wallet.createRandom();
  await click("Telefoni");
  await see("Configura un nuovo telefono");
  await page.getByLabel("Codice del telefono").fill(phone.address.slice(2).match(/.{1,4}/g).join(" "));
  await click("Autorizza");
  await done();
  await see(phone.address.slice(2, 6));
  await shot("phones");

  // The driver's app records a stock count and a delivery note (the app's own logic, signed by the phone).
  const reg = new A.Registry({ provider, address: r.address, fromBlock: r.block });
  reg.keys = (await O.unlockWithPassword(await O.context({ provider, registry: r.address }), PASSWORD)).keys;
  const cps = await reg.counterparties();
  const demo = cps.find((c) => c.name === "Officina Demo");
  const names = Object.fromEntries(cps.map((c) => [c.id, c.name]));
  const now = (await provider.getBlock("latest")).timestamp;
  const signDigests = async (ds) => ds.map((d) => phone.signingKey.sign(d).serialized);
  async function doc(kind, number, codes, edit = () => ({})) {
    const lines = [];
    for (const code of codes) {
      const c = await reg.readCylinder(code);
      const p = A.propose(c, demo, kind, names);
      lines.push({ ...c, gas: c.info ? c.info.gas : code.startsWith("CO2") ? "co2" : code.startsWith("N2") ? "nitrogen" : "argon", ...p, ...edit(code) });
    }
    const built = await A.buildDocument({ registry: reg, operator: phone.address, counterparty: demo, kind, number, lines, now });
    const item = await A.signDocument({ registry: reg, operator: phone.address, built, mail: null, signDigests, meta: {} });
    const out = await A.sendItem(item, { relayer: relayerUrl, pollMs: 50 });
    if (!out.done) throw new Error("document not recorded: " + JSON.stringify(out.failed));
  }
  await doc("stock_count", "", ["AR-100", "CO2-200", "AR-101"], () => ({ condition: "empty" }));
  await doc("delivery_note", "DDT 2026/118", ["AR-300", "AR-301", "N2-400", "AR-100", "CO2-200"]);

  // Overview, cylinders, a cylinder's history, documents.
  await click("Panoramica");
  await click("↻ Aggiorna");
  await done();
  await see("DDT 2026/118");
  await shot("overview");
  const stats = await page.locator(".stat .n").allInnerTexts();
  await click("Bombole");
  await see("AR-300");
  await shot("cylinders");
  await page.getByRole("row", { name: /AR-100/ }).click();
  await see("Storia della bombola AR-100");
  await shot("history");
  const historyText = await page.locator("#app").innerText();
  await click("Documenti");
  await page.locator("details.doc summary").first().click();
  await shot("documents");

  // The data download: the files are made in the page.
  await click("Scarica dati");
  await see("Movimenti");
  await shot("export");
  const downloaded = {};
  for (const [i, k] of [[0, "cylinders"], [1, "movements"]]) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Scarica", exact: true }).nth(i).click()]);
    downloaded[k] = { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), "utf8") };
  }
  const csvRows = (k) => downloaded[k].text.replace(/^\uFEFF/, "").trim().split("\r\n");

  // The password: changed from the page; the old one no longer opens the data.
  await click("Impostazioni");
  await page.getByLabel("Nuova password dei dati").fill("una nuova frase per il registro");
  await page.getByLabel("Ripeti la nuova password").fill("una nuova frase per il registro");
  await click("Cambia password");
  await see("Password cambiata");
  const ctxCheck = await O.context({ provider, registry: r.address });
  let oldRefused = false;
  try {
    await O.unlockWithPassword(ctxCheck, PASSWORD);
  } catch {
    oldRefused = true;
  }

  // Phone width.
  const phonePage = await ctxB.newPage();
  await phonePage.setViewportSize({ width: 390, height: 844 });
  await phonePage.goto(pageUrl);
  await see("Accedi con ChainIntegrate Account", phonePage);
  const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (SHOTS) await phonePage.screenshot({ path: path.join(SHOTS, `admin-${String(++n).padStart(2, "0")}-phone.png`), fullPage: true });

  // English.
  await click("English");
  await see("Settings");
  await shot("settings-en");

  const settings = await O.readSettings(ctxCheck, (await O.unlockWithPassword(ctxCheck, "una nuova frase per il registro")).keys);
  const checks = [
    ["settings written", settings && settings.company === "Argonia Gas Tecnici" && settings.emails.length === 2],
    ["customers written", cps.length === 3],
    ["phone authorized", await new ethers.Contract(r.address, O.REGISTRY_ABI, provider).isOperator(phone.address)],
    ["overview counts (6 cylinders: 4 at the customer, 2 back at the depot)", stats[0] === "6" && stats[1] === "2" && stats[2] === "4"],
    ["data download: 6 cylinders in the file", /^gastrace-bombole-\d{4}-\d\d-\d\d\.csv$/.test(downloaded.cylinders.name) && csvRows("cylinders").length === 7 && csvRows("cylinders")[0].startsWith("Codice;Gas;")],
    ["data download: every movement of the documents", csvRows("movements").length > 6 && csvRows("movements").some((r) => r.includes("DDT;2026/118"))],
    ["history shows stock count then collection", /Giacenza[\s\S]*Ritiro/.test(historyText)],
    ["password changed, old one refused", oldRefused],
    ["no technical words on screen", texts.every((x) => !FORBIDDEN.test(x))],
    ["no horizontal scroll at phone width", !overflow],
    ["every request accepted by the extension's catalog", catalog ? catalogChecks.length > 0 && catalogChecks.every((c) => !c.startsWith("REFUSED")) : true],
    ["no page errors", errors.length === 0],
  ];
  if (!catalog) console.log("note: up-onboarding not found next to this repository: catalog check skipped");
  else console.log(`catalog: ${catalogChecks.length} requests checked (${[...new Set(catalogChecks)].join(", ")})`);
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    ok = ok && pass;
  }
  if (!ok) {
    console.log("stats:", stats, "errors:", errors, "forbidden:", texts.filter((x) => FORBIDDEN.test(x)).map((x) => x.match(FORBIDDEN)[0]));
  }
  await browser.close();
  web.close();
  relayerServer.close();
  fs.unlinkSync(cfg);
  execFileSync("node", [path.join(__dirname, "build-admin.js")], { stdio: "ignore" });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
