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
  const f = await O.deployFactory(chainIntegrate, 2);
  const factory = new ethers.Contract(f.address, O.FACTORY_ABI, chainIntegrate);
  const prepared = await O.prepareRegistry({ factory }); // no data key: the owner prepares it in the page (review X-02)
  const r = await O.createRegistry({ factory, prepared, owner, name: "Argonia Gas Tecnici", symbol: "ARGCYL" });

  // The extension's catalog, configured as it will be for GasTrace.
  let catalog = null;
  const catalogFile = CATALOG_PATHS.find((p) => fs.existsSync(p));
  if (catalogFile) {
    globalThis.ethers = ethers; // the catalog takes ethers from the global scope when it has no node_modules of its own
    catalog = require(catalogFile);
    const p = catalog.projectById("gas-cylinders");
    if (!p || !p.typed || !p.typed.domain || p.typed.domain.version !== "2") {
      // The extension's catalog still describes version 1: its check waits for the catalog's update.
      console.log("note: the extension's catalog is for version 1 of the contracts: catalog check skipped");
      catalog = null;
    } else {
      p.typed.madeBy = { factory: f.address, check: "isRegistry(address)" };
      p.typed.chainIds = [Number(chainId)];
    }
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
  let tampered = null; // the catalog's answer to a SetData whose values do not match its hash
  let fromAccessComputer = false; // the next request comes from an "access" computer: refused (extension 0.6.0)
  const signers = new Set(); // the catalog's signer for GasTrace's requests ("admin" from extension 0.6.0)
  let activeAccount = ethers.Wallet.createRandom().address; // first an account without a register: GasTrace not active yet
  await page.exposeFunction("__ext", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [activeAccount];
    if (method === "eth_chainId") return "0x" + Number(chainId).toString(16);
    if (method === "eth_signTypedData_v4") {
      const typed = JSON.parse(params[1]);
      if (ethers.getAddress(params[0]) !== owner) throw new Error("other account");
      if (fromAccessComputer) {
        fromAccessComputer = false;
        return { __error: { code: 4100, message: "Not allowed by ChainIntegrate Account (admin_only)." } };
      }
      if (catalog) {
        // As the extension does: a first look names the registry values it needs, then the precise
        // description with the current values (UPCatalog.readCurrent), from extension-v0.5.1.
        const project = catalog.projectById("gas-cylinders");
        let c = catalog.typedData(project, typed, { account: owner, chainId: Number(chainId) });
        if (c.ok && c.reads && c.reads.length && catalog.readCurrent) {
          c = catalog.typedData(project, typed, { account: owner, chainId: Number(chainId), current: await catalog.readCurrent(provider, c.reads) });
        }
        catalogChecks.push(c.ok ? `${typed.primaryType}: ${c.lines.map((l) => (typeof l === "string" ? l : l.it)).join(" | ")}` : `REFUSED ${typed.primaryType}: ${c.error}`);
        if (!c.ok) throw new Error("refused by the catalog: " + c.error);
        signers.add(c.signer);
        if (typed.primaryType === "SetData" && !tampered) {
          // The same request with one value changed after the hash: the catalog must refuse it.
          const bad = JSON.parse(JSON.stringify(typed));
          bad.dataValues[0] = bad.dataValues[0].slice(0, -2) + (bad.dataValues[0].endsWith("00") ? "01" : "00");
          tampered = catalog.typedData(project, bad, { account: owner, chainId: Number(chainId) });
        }
        if (!(await catalog.verifyNeeds(provider, c.needs))) throw new Error("not a registry of the factory");
      }
      const types = { [typed.primaryType]: typed.types[typed.primaryType] };
      return controller.signingKey.sign(ethers.TypedDataEncoder.hash(typed.domain, types, typed.message)).serialized;
    }
    throw new Error("method not allowed: " + method);
  });
  await page.addInitScript(() => {
    const provider = {
      request: async ({ method, params }) => {
        const r = await window.__ext(method, params || []);
        if (r && r.__error) throw Object.assign(new Error(r.__error.message), { code: r.__error.code });
        return r;
      },
    };
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

  // Sign in and open the data (a clock the test can move forward: the 30-minute lock).
  await page.clock.install();
  await page.goto(pageUrl);
  await see("Accedi con ChainIntegrate Account");
  await shot("connect");
  // An account without a register: the page offers the activation request, with the account's address.
  await click("Accedi con ChainIntegrate Account");
  await see("GasTrace non è ancora attivo per questo account");
  await shot("not-active");
  const request = decodeURIComponent((await page.getByRole("link", { name: "Richiedi l'attivazione" }).getAttribute("href")) || "");
  const activationRequest = request.startsWith("mailto:info@chainintegrate.it?") && request.includes(activeAccount);
  await click("Esci");
  activeAccount = owner;
  await click("Accedi con ChainIntegrate Account");
  // First sign-in: the owner prepares the data key, the password and the 24 words in the page.
  await see("Prepara i dati del registro");
  await page.getByLabel("Nuova password dei dati").fill(PASSWORD);
  await page.getByLabel("Ripeti la nuova password").fill(PASSWORD);
  await shot("setup-keys");
  await click("Continua");
  await page.locator(".words li").first().waitFor({ timeout: 30000 });
  await shot("recovery-code");
  const words = await page.locator(".words li").allInnerTexts();
  const nums = (await page.locator("label").allInnerTexts()).map((l) => /parola numero (\d+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  await page.getByLabel(`Controllo: parola numero ${nums[0]}`, { exact: true }).fill(words[nums[0] - 1]);
  await page.getByLabel(`Controllo: parola numero ${nums[1]}`, { exact: true }).fill("sbagliata");
  await click("Salva e apri i dati");
  await see("Le parole di controllo non coincidono");
  await page.getByLabel(`Controllo: parola numero ${nums[1]}`, { exact: true }).fill(words[nums[1] - 1]);
  await click("Salva e apri i dati");
  await see("Spunta le due conferme");
  await page.getByLabel("Ho conservato la password dei dati").check();
  await page.getByLabel("Ho scritto o stampato le 24 parole").check();
  await click("Salva e apri i dati");
  await see("Dati preparati");
  const setupCtx = await O.context({ provider, registry: r.address });
  const byWords = await O.unlockWithRecoveryCode(setupCtx, words.join(" "));
  const byPassword = await O.unlockWithPassword(setupCtx, PASSWORD);

  // The next sign-in asks the password.
  await page.reload();
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
  // From an "access" computer of the account the extension refuses the owner's requests (A01 / X-01).
  fromAccessComputer = true;
  await click("Salva");
  await see("Questa operazione si conferma da un computer amministratore del tuo account.");
  const adminOnlyShown = true;
  await page.getByLabel("Nome dell'azienda").fill("Argonia Gas Tecnici"); // as on the administrator computer
  await page.getByLabel("Email dell'azienda (separate da virgola)").fill("ufficio@example.com, magazzino@example.com");
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
  // AR-300's stamp says it was last tested in January 2016: its test has expired.
  await doc("delivery_note", "DDT 2026/118", ["AR-300", "AR-301", "N2-400", "AR-100", "CO2-200"], (code) =>
    code === "AR-300" ? { test: S.completeTest({ last: "2016-01" }, 10) } : code === "AR-301" ? { test: S.completeTest({ due: "2035-06" }, 10) } : {}
  );

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

  // The owner corrects AR-100 (review A06): owned by the customer, tested in May 2024, with a reason.
  await click("Correggi");
  await page.locator(".form select").nth(1).selectOption({ label: "Officina Demo" });
  await page.locator(".form select").nth(2).selectOption("last");
  await page.locator('.form input[type="month"]').fill("2024-05");
  await page.getByLabel("Motivo").fill("bombola del cliente, collaudo letto male");
  await shot("correct");
  await click("Salva");
  await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
  await see("Correzione registrata");
  await see("bombola del cliente, collaudo letto male");
  const corrected = await reg.readCylinder("AR-100");
  const correctedOk = corrected.info.owner === demo.id && corrected.state.test.last === "2024-05" && corrected.state.test.due === "2034-05";
  await shot("history-corrected");

  // The periodic test filter: only AR-300 has an expired test.
  await click("Bombole");
  await page.locator("select.filter").selectOption("expired");
  const expiredRows = await page.locator("tbody tr").allInnerTexts();
  await page.locator("select.filter").selectOption("all");
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

  // Several admin computers: a customer changed from another computer while this page edits it.
  page.on("dialog", (d) => d.accept());
  await click("Clienti");
  await page.getByRole("button", { name: "Modifica", exact: true }).first().click();
  {
    const other = await O.context({ provider, registry: r.address, owner: { address: owner, signTypedData: (dm, ty, v) => controller.signTypedData(dm, ty, v) }, submit: O.relayerSubmitter(relayerUrl, provider), fromBlock: r.block });
    const k = (await O.unlockWithPassword(other, "una nuova frase per il registro")).keys;
    const first = (await O.listCounterparties(other, k)).find((c) => !c.archived && c.type === "customer");
    await O.updateCounterparty(other, k, first.id, { name: first.name + " (altro computer)" });
  }
  await page.getByLabel("Nome", { exact: true }).fill("Nome da questo computer");
  await click("Salva");
  await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
  await see("Un'altra postazione ha modificato questo dato");
  const conflictText = await page.locator("#app").innerText();

  // Handing the register over: started, then cancelled.
  await click("Impostazioni");
  await page.locator("summary", { hasText: "Cedere il registro" }).click();
  await page.getByLabel("Indirizzo del nuovo account").fill(ethers.Wallet.createRandom().address);
  await click("Cedi il registro");
  await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
  await see("Cessione in corso");
  await shot("handover");
  const pendingSeen = (await O.status(ctxCheck)).pendingOwner !== null;
  await click("Annulla la cessione");
  await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
  await see("Cessione annullata");
  const handoverOk = pendingSeen && (await O.status(ctxCheck)).pendingOwner === null;

  // Rare cases: a new data key, a new password and new 24 words; the old password no longer opens it.
  await page.locator("summary", { hasText: "cambiare la chiave dei dati" }).click();
  await page.getByLabel("Password della chiave nuova", { exact: true }).fill("frase della chiave nuova dopo il telefono");
  await page.getByLabel("Ripeti la password della chiave nuova").fill("frase della chiave nuova dopo il telefono");
  await click("Continua");
  await page.locator(".words li").first().waitFor();
  const newWords = await page.locator(".words li").allInnerTexts();
  const nums2 = (await page.locator("label").allInnerTexts()).map((l) => /parola numero (\d+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  for (const k of nums2) await page.getByLabel(`Controllo: parola numero ${k}`, { exact: true }).fill(newWords[k - 1]);
  await page.getByLabel("Ho conservato la password dei dati").check();
  await page.getByLabel("Ho scritto o stampato le 24 parole").check();
  await click("Salva la nuova chiave");
  await page.locator(".busy").waitFor({ state: "detached", timeout: 60000 });
  await see("Chiave dei dati cambiata");
  let oldKeyRefused = false;
  try {
    await O.unlockWithPassword(ctxCheck, "una nuova frase per il registro");
  } catch {
    oldKeyRefused = true;
  }
  const rekeyed = await O.unlockWithRecoveryCode(ctxCheck, newWords.join(" "));
  const rekeyOk = oldKeyRefused && rekeyed.keys.epoch === 1 && (await O.listCounterparties(ctxCheck, rekeyed.keys)).length >= 3;
  await click("Bombole");
  await see("AR-300"); // the page reads everything with the new key

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

  // Review A09: after 30 minutes unused the page forgets the data and asks the password again.
  await page.clock.fastForward("31:00");
  await see("30 minutes unused");
  const lockedPage = await page.locator("#app").innerText();

  const settings = await O.readSettings(ctxCheck, (await O.unlockWithPassword(ctxCheck, "frase della chiave nuova dopo il telefono")).keys);
  const checks = [
    ["an account without a register: the activation request carries its address", activationRequest],
    ["first sign-in: the page made the data key; the password and the 24 words open it", Buffer.from(byWords.dek).equals(Buffer.from(byPassword.dek))],
    ["locked after 30 minutes unused (A09)", /Open the data/i.test(lockedPage) && !/Overview/.test(lockedPage)],
    ["settings written", settings && settings.company === "Argonia Gas Tecnici" && settings.emails.length === 2],
    ["customers written", cps.length === 3],
    ["phone authorized", await new ethers.Contract(r.address, O.REGISTRY_ABI, provider).isOperator(phone.address)],
    ["overview counts (6 cylinders: 4 at the customer, 2 back at the depot)", stats[0] === "6" && stats[1] === "2" && stats[2] === "4"],
    ["data download: 6 cylinders in the file", /^gastrace-bombole-\d{4}-\d\d-\d\d\.csv$/.test(downloaded.cylinders.name) && csvRows("cylinders").length === 7 && csvRows("cylinders")[0].startsWith("Codice;Gas;")],
    ["data download: every movement of the documents", csvRows("movements").length > 6 && csvRows("movements").some((r) => r.includes("DDT;2026/118"))],
    ["history shows stock count then collection", /Giacenza[\s\S]*Ritiro/.test(historyText)],
    ["the owner corrects a cylinder: owner and test, the reason in its history (A06)", correctedOk],
    ["the periodic test filter shows the expired cylinder only", expiredRows.length === 1 && /AR-300/.test(expiredRows[0])],
    ["a change made meanwhile from another computer is noticed, not overwritten", /altro computer/.test(conflictText) && !/Nome da questo computer/.test(conflictText)],
    ["a handover started and cancelled from the page", handoverOk],
    ["the data key replaced from the page: new password and 24 words, old password refused (A05)", rekeyOk],
    ["password changed, old one refused", oldRefused],
    ["no technical words on screen", texts.every((x) => !FORBIDDEN.test(x))],
    ["no horizontal scroll at phone width", !overflow],
    ["the extension sees the values and names each change (A02/G-04)", catalog && catalog.readCurrent
      ? catalogChecks.some((c) => /^SetData: Preparare la cifratura/.test(c)) &&
        catalogChecks.some((c) => /^SetData: Cambiare la password dei dati/.test(c)) &&
        catalogChecks.some((c) => /^SetData: Aggiungere 1 cliente/.test(c)) &&
        catalogChecks.some((c) => /^SetData: Impostazioni dell'azienda/.test(c)) &&
        !catalogChecks.some((c) => /non verificabile/.test(c))
      : true],
    ["values changed after the hash are refused (data_values_mismatch)", catalog && catalog.readCurrent ? tampered && tampered.error === "data_values_mismatch" : true],
    ["from an access computer: the page says to use an administrator computer (A01)", adminOnlyShown],
    ["the catalog's signer for GasTrace is the administrator (extension 0.6.0)", !catalog || [...signers].every((x) => x === "admin" || x == null)],
    ["every request accepted by the extension's catalog", catalog ? catalogChecks.length > 0 && catalogChecks.every((c) => !c.startsWith("REFUSED")) : true],
    ["no page errors", errors.length === 0],
  ];
  if (!catalog) console.log("note: up-onboarding not found next to this repository: catalog check skipped");
  else console.log(`catalog: ${catalogChecks.length} requests checked:\n  ${catalogChecks.join("\n  ")}`);
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
