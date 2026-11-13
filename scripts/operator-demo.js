#!/usr/bin/env node
"use strict";
// The GasTrace operator page in Chromium against a local chain: ChainIntegrate's wallet (simulated through
// EIP-6963, the factory's owner) creates a register for a supplier's account; the register then opens with
// the data password typed in the page and with the 24 words shown there.
//
//   npx hardhat node &
//   node scripts/operator-demo.js [screenshots-dir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { ethers } = require("ethers");
const O = require("./lib/owner");
const S = require("../shared");

const RPC = process.env.RPC || "http://127.0.0.1:8545";
const SHOTS = process.argv[2] || null;
const PASSWORD = "le bombole di argon tornano vuote";

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
  const ci = await provider.getSigner(accounts[0]);
  const { chainId } = await provider.getNetwork();
  const f = await O.deployFactory(ci);

  // The supplier's account (answers as a Universal Profile).
  const { abi, bytecode } = require("../artifacts/contracts/test/MockContractAccount.sol/MockContractAccount.json");
  const account = await new ethers.ContractFactory(abi, bytecode, ci).deploy(ethers.Wallet.createRandom().address);
  await account.waitForDeployment();
  const supplier = await account.getAddress();

  const cfg = path.join(os.tmpdir(), `gcr-operator-config-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ rpc: RPC, chainId: Number(chainId), relayer: RPC, factory: f.address, factoryBlock: f.block }));
  execFileSync("node", [path.join(__dirname, "build-admin.js")], { env: { ...process.env, GCR_ADMIN_CONFIG: cfg }, stdio: "inherit" });
  const web = await serve(path.join(__dirname, "..", "admin", "www"));
  const url = `http://127.0.0.1:${web.address().port}/operator.html`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: "it-IT" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // ChainIntegrate's wallet: EIP-6963, the factory's owner; the ChainIntegrate Account extension is announced
  // too and must be left out (it never signs ChainIntegrate's administration).
  await page.exposeFunction("__wallet", async (method, params) => {
    if (method === "eth_requestAccounts") return [accounts[0]];
    if (method === "eth_chainId") return "0x" + Number(chainId).toString(16);
    if (method === "eth_sendTransaction") {
      const tx = await ci.sendTransaction({ to: params[0].to, data: params[0].data });
      return tx.hash;
    }
    throw new Error("method " + method);
  });
  await page.addInitScript(() => {
    const announce = (info, provider) => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
    const wallet = { request: ({ method, params }) => window.__wallet(method, params || []) };
    const clients = { request: () => Promise.reject(new Error("the clients' extension must not be used here")) };
    window.addEventListener("eip6963:requestProvider", () => {
      announce({ uuid: "u1", name: "Universal Profiles", icon: "data:,", rdns: "io.lukso.up" }, wallet);
      announce({ uuid: "u2", name: "ChainIntegrate Account", icon: "data:,", rdns: "it.chainintegrate.account" }, clients);
    });
  });

  let n = 0;
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `operator-${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true });
  const click = (name) => page.getByRole("button", { name, exact: true }).first().click();
  const see = async (text) => {
    try {
      await page.getByText(text, { exact: false }).first().waitFor({ timeout: 30000 });
    } catch (e) {
      console.log("PAGE:", await page.locator("#app").innerText(), "\nERRORS:", errors);
      throw e;
    }
  };

  await page.goto(url);
  await see("Collega il wallet della UP di ChainIntegrate");
  await shot("connect");
  await click("Collega il wallet della UP di ChainIntegrate");
  await see("proprietario della Factory");
  await see("Nessun registro.");

  // A weak password and a non-profile owner are refused first.
  await page.getByLabel("Nome dell'azienda (nome della collezione)").fill("Argonia Gas Tecnici");
  await page.getByLabel("Sigla (maiuscole, 3-8 caratteri)").fill("argcyl");
  await page.getByLabel("Account ChainIntegrate del fornitore (indirizzo 0x…)").fill(accounts[1]);
  await page.locator("input[type=password]").nth(0).fill("argonia");
  await page.locator("input[type=password]").nth(1).fill("argonia");
  await click("Prepara");
  await see("Password troppo corta");
  await page.locator("input[type=password]").nth(0).fill(PASSWORD);
  await page.locator("input[type=password]").nth(1).fill(PASSWORD);
  await click("Prepara");
  await see("non è una Universal Profile");
  await page.getByLabel("Account ChainIntegrate del fornitore (indirizzo 0x…)").fill(supplier);
  await shot("form");
  await click("Prepara");
  await see("CODICE DI RECUPERO");
  await shot("code");

  const words = await page.locator(".words li").allInnerTexts();
  const labels = await page.locator("label").allInnerTexts();
  const nums = labels.map((l) => /parola numero (\d+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  await page.getByLabel(`Controllo: parola numero ${nums[0]}`, { exact: true }).fill(words[nums[0] - 1]);
  await page.getByLabel(`Controllo: parola numero ${nums[1]}`, { exact: true }).fill("sbagliata");
  await click("Crea il registro");
  await see("Le parole di controllo non coincidono");
  await page.getByLabel(`Controllo: parola numero ${nums[1]}`, { exact: true }).fill(words[nums[1] - 1]);
  await click("Crea il registro");
  await see("Registro creato.");
  await shot("created");

  // The register: the factory's, owned by the supplier, opened by the password and by the 24 words.
  const address = (await page.locator("a.mono").first().innerText()).trim();
  const ctx = await O.context({ provider, registry: address });
  const byPassword = await O.unlockWithPassword(ctx, PASSWORD);
  const byCode = await O.unlockWithRecoveryCode(ctx, words.join(" "));
  const reg = new ethers.Contract(address, O.REGISTRY_ABI, provider);
  const checks = [
    ["register made by the factory", await new ethers.Contract(f.address, O.FACTORY_ABI, provider).isRegistry(address)],
    ["owned by the supplier's account", (await reg.owner()) === supplier],
    ["symbol upper case", Buffer.from((await reg.getData(ethers.id("LSP4TokenSymbol"))).slice(2), "hex").toString() === "ARGCYL"],
    ["the password opens the data", byPassword.dek.length === 32],
    ["the 24 words open the same data key", Buffer.from(byCode.dek).equals(Buffer.from(byPassword.dek))],
    ["listed on the page", (await page.locator("main").innerText()).includes("Argonia Gas Tecnici")],
    ["no page errors", errors.length === 0],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    ok = ok && pass;
  }
  if (!ok) console.log("errors:", errors);
  await browser.close();
  web.close();
  fs.unlinkSync(cfg);
  execFileSync("node", [path.join(__dirname, "build-admin.js")], { stdio: "ignore" });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
