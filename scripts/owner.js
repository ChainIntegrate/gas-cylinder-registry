#!/usr/bin/env node
"use strict";
// Owner tools for the demo: a command line around scripts/lib/owner.js.
// Usage: node scripts/owner.js <command> [options]      (node scripts/owner.js help)

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { JsonRpcProvider, Wallet, Contract, getAddress } = require("ethers");
const O = require("./lib/owner");
const S = require("../shared");

const NETWORKS = {
  lukso: { rpc: process.env.LUKSO_RPC_URL || "https://rpc.mainnet.lukso.network", explorer: "https://explorer.execution.mainnet.lukso.network" },
  "lukso-testnet": { rpc: process.env.LUKSO_TESTNET_RPC_URL || "https://rpc.testnet.lukso.network", explorer: "https://explorer.execution.testnet.lukso.network" },
  local: { rpc: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545", explorer: null },
};

const HELP = `Owner tools of gas-cylinder-registry (demo).

  node scripts/owner.js <command> [options]

Keys
  new-key <file>                     Create an encrypted key file (owner or ChainIntegrate) and show its address.

ChainIntegrate (the factory's owner; also sends the owner's signed operations until the relayer exists)
  deploy-factory                     Deploy the factory; writes its address to the config file.
  create-registry --name <name> --symbol <symbol> (--owner <address> | --owner-keystore <file>) [--language en|it]
                                     The owner is an account address (a ChainIntegrate Account, managed from
                                     the GasTrace admin page) or, for an owner using these tools, a key file.
                                     Create a company's registry: asks the data password, shows the
                                     24-word recovery code once, creates the registry with both.

Owner (signs with the owner's key file)
  status                             Registry, owner, phones, cylinders.
  settings [--company <name>] [--email <address>]...
                                     Show, or set, the company name shown by the app and in the e-mails, and
                                     the supplier's own addresses (they receive every document's e-mail).
  phone-setup                        The setup code (and its QR) the app scans at its first start.
  phones                             Authorized phones.
  add-phone <code>                   Authorize a driver's phone (the code the app shows, spaces allowed).
  remove-phone <address>             Revoke a phone (lost, or its driver left).
  counterparties                     Customers and refill plants (needs the data password).
  add-customer --name <name> [--email <address>]...
  add-refill-plant --name <name> [--email <address>]...
  edit-counterparty <id> [--name <name>] [--email <address>]...
  remove-counterparty <id>
  change-password [--recovery]       New data password, opening the data key with the current password
                                     or, with --recovery, with the 24-word recovery code.

Options
  --config <file>                    Default: gcr-registry.json (addresses only; never commit it).
  --network lukso|lukso-testnet|local  Default: the config's, else lukso.
  --chainintegrate-keystore <file>   Default: the config's, else chainintegrate.keystore.json.
  --owner-keystore <file>            Default: the config's.
  --relayer <url>                    Send owner operations through the relayer (default: the config's
                                     "relayer"; without one, ChainIntegrate's key sends and pays).
`;

// ------------------------------------------------------------------------------------------------
// Input
// ------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], email: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? true : (i++, next);
      if (key === "email") out.email.push(value);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else out._.push(a);
  }
  return out;
}

// One readline interface for the whole run, with a queue of lines: answers typed ahead or piped on
// stdin are kept until a prompt asks for them. Hidden prompts echo nothing on a terminal.
let rl;
const lines = [];
const waiting = [];
function ask(question, { hidden = false } = {}) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (!rl.muted) return write(s);
      if (s.includes("\n") || s.includes("\r")) write("\n");
    };
    rl.on("line", (line) => {
      rl.muted = false;
      if (waiting.length) waiting.shift()(line);
      else lines.push(line);
    });
    rl.on("close", () => {
      while (waiting.length) waiting.shift()(null);
    });
  }
  process.stdout.write(question);
  rl.muted = hidden && !!process.stdin.isTTY;
  if (lines.length) {
    rl.muted = false;
    const line = lines.shift();
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return Promise.resolve(line);
  }
  return new Promise((resolve, reject) =>
    waiting.push((line) => {
      if (line === null) return reject(new Error("input ended"));
      if (!process.stdin.isTTY) process.stdout.write("\n");
      resolve(line);
    })
  );
}

async function askNewSecret(label, check) {
  for (;;) {
    const a = await ask(`${label}: `, { hidden: true });
    if (check) {
      const c = check(a);
      if (!c.ok) {
        console.log(
          {
            too_short: "  Too short: at least 14 characters, better a phrase of 20 or more.",
            too_simple: "  Too simple: mix lowercase, uppercase, digits and symbols, or use a phrase of 20 or more characters.",
            repetitive: "  Too repetitive.",
          }[c.reason] || "  Refused."
        );
        continue;
      }
    }
    const b = await ask(`${label} (again): `, { hidden: true });
    if (a === b) return a;
    console.log("  The two do not match.");
  }
}

// ------------------------------------------------------------------------------------------------
// Configuration and keys
// ------------------------------------------------------------------------------------------------

function loadConfig(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
function saveConfig(file, config) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

function keystoreAddress(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`key file not found: ${file}`);
  return getAddress(JSON.parse(fs.readFileSync(file, "utf8")).address);
}

async function openKeystore(file, label, provider) {
  keystoreAddress(file);
  const password = await ask(`Password of ${label} key file (${path.basename(file)}): `, { hidden: true });
  const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(file, "utf8"), password);
  return provider ? wallet.connect(provider) : wallet;
}

function explorerTx(network, receipt) {
  const base = NETWORKS[network] && NETWORKS[network].explorer;
  return base ? `${base}/tx/${receipt.hash}` : receipt.hash;
}

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help") return console.log(HELP);

  const configFile = args.config || "gcr-registry.json";
  const config = loadConfig(configFile);
  const network = args.network || config.network || "lukso";
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}`);
  const provider = new JsonRpcProvider(NETWORKS[network].rpc);
  const ciKeystore = args.chainintegrateKeystore || config.chainintegrateKeystore || "chainintegrate.keystore.json";
  const ownerKeystore = args.ownerKeystore || config.ownerKeystore;

  if (command === "new-key") {
    const file = args._[1];
    if (!file) throw new Error("usage: new-key <file>");
    if (fs.existsSync(file)) throw new Error(`${file} already exists`);
    const wallet = Wallet.createRandom();
    const password = await askNewSecret("Password for the key file", (p) => (p.length >= 12 ? { ok: true } : { ok: false, reason: "too_short" }));
    fs.writeFileSync(file, await wallet.encrypt(password), { mode: 0o600 });
    console.log(`Created ${file}\nAddress: ${wallet.address}\nKeep a copy of the file and its password: a lost key cannot be recovered.`);
    return;
  }

  if (command === "deploy-factory") {
    const deployer = await openKeystore(ciKeystore, "ChainIntegrate", provider);
    console.log(`Deploying the factory on ${network} from ${deployer.address}...`);
    const f = await O.deployFactory(deployer);
    saveConfig(configFile, { ...config, network, chainintegrateKeystore: ciKeystore, factory: f.address, factoryBlock: f.block });
    console.log(`Factory: ${f.address} (block ${f.block}), saved to ${configFile}`);
    return;
  }

  if (command === "create-registry") {
    if (!config.factory) throw new Error("no factory in the config: run deploy-factory first");
    if (config.registry) throw new Error(`the config already has a registry (${config.registry}); use another --config`);
    if (typeof args.name !== "string" || typeof args.symbol !== "string") throw new Error("--name and --symbol are required");
    // The owner: a ChainIntegrate Account (then managed from the admin page) or a key file used with these tools.
    const owner = typeof args.owner === "string" ? getAddress(args.owner) : keystoreAddress(ownerKeystore);
    const ci = await openKeystore(ciKeystore, "ChainIntegrate", provider);
    const factory = new Contract(config.factory, O.FACTORY_ABI, ci);

    console.log(`\nThe data password protects the registry's data. It is typed in these tools and once on each phone.`);
    const password = await askNewSecret("Data password", S.checkPassword);
    const prepared = await O.prepareRegistry({ factory, password, language: args.language || "en" });

    const words = prepared.recoveryCode.split(" ");
    console.log("\nRECOVERY CODE: write it down on paper and keep it in a safe place. It is shown only now.");
    console.log("With it you can set a new data password if you lose the current one.\n");
    for (let i = 0; i < 24; i += 4) {
      console.log("  " + words.slice(i, i + 4).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(12)}`).join(" "));
    }
    console.log("");
    for (const n of [3, 17]) {
      for (;;) {
        const w = (await ask(`To check: word number ${n}? `)).trim().toLowerCase();
        if (w === words[n - 1]) break;
        console.log("  Not that one: check what you wrote.");
      }
    }
    console.clear();

    console.log(`Creating "${args.name}" (${args.symbol}) for owner ${owner} at ${prepared.address}...`);
    const r = await O.createRegistry({ factory, prepared, owner, name: args.name, symbol: args.symbol });
    saveConfig(configFile, { ...config, network, registry: r.address, registryBlock: r.block, ...(typeof args.owner === "string" ? { owner } : { ownerKeystore }) });
    console.log(`Registry: ${r.address} (block ${r.block}), saved to ${configFile}`);
    return;
  }

  // The commands below work on the config's registry.
  if (!config.registry) throw new Error("no registry in the config: run create-registry first");
  const readCtx = () => O.context({ provider, registry: config.registry, fromBlock: config.registryBlock || 0 });
  const relayerUrl = args.relayer || config.relayer;
  const writeCtx = async () => {
    const owner = await openKeystore(ownerKeystore, "the owner's", provider);
    // Through the relayer when one is configured; otherwise ChainIntegrate's key sends and pays.
    const submit = relayerUrl
      ? O.relayerSubmitter(relayerUrl, provider)
      : O.directSubmitter(await openKeystore(ciKeystore, "ChainIntegrate (sender)", provider));
    return O.context({ provider, registry: config.registry, owner, submit, fromBlock: config.registryBlock || 0 });
  };
  const unlock = async (ctx) => (await O.unlockWithPassword(ctx, await ask("Data password: ", { hidden: true }))).keys;
  const done = (receipt) => console.log(`Done: ${explorerTx(network, receipt)}`);

  switch (command) {
    case "settings": {
      if (typeof args.company !== "string" && !args.email.length) {
        const ctx = await readCtx();
        const st = await O.readSettings(ctx, await unlock(ctx));
        console.log(st ? `Company: ${st.company}\nE-mails: ${st.emails.join(", ") || "-"}` : "No settings yet: set them with --company and --email.");
        return;
      }
      const ctx = await writeCtx();
      const fields = {};
      if (typeof args.company === "string") fields.company = args.company;
      if (args.email.length) fields.emails = args.email;
      return done(await O.writeSettings(ctx, await unlock(ctx), fields));
    }
    case "phone-setup": {
      const code = S.setupCode(config.registry, config.registryBlock || 0);
      const qr = require("qrcode-generator")(0, "M");
      qr.addData(code);
      qr.make();
      const n = qr.getModuleCount();
      const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
      const out = [];
      for (let r = -2; r < n + 2; r += 2) {
        let line = "";
        for (let c = -2; c < n + 2; c++) {
          const top = dark(r, c);
          const bottom = dark(r + 1, c);
          line += top && bottom ? " " : top ? "\u2584" : bottom ? "\u2580" : "\u2588";
        }
        out.push("  " + line);
      }
      console.log(`\nScan this with the app at its first start (or type the code):\n\n${out.join("\n")}\n\n  ${code}\n`);
      return;
    }
    case "status": {
      const s = await O.status(await readCtx());
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    case "phones": {
      const list = await O.listOperators(await readCtx());
      console.log(list.length ? list.join("\n") : "No phones authorized.");
      return;
    }
    case "add-phone":
    case "remove-phone": {
      // The app shows the phone's code in groups of four, without 0x: accept it as typed.
      const raw = args._.slice(1).join("").replace(/\s+/g, "");
      if (!raw) throw new Error(`usage: ${command} <phone code>`);
      const address = raw.startsWith("0x") ? raw : "0x" + raw;
      return done(await O.setOperator(await writeCtx(), address, command === "add-phone"));
    }
    case "counterparties": {
      const ctx = await readCtx();
      const list = await O.listCounterparties(ctx, await unlock(ctx));
      if (!list.length) return console.log("No customers or refill plants yet.");
      for (const c of list) console.log(`${c.id}  ${c.type.padEnd(8)}  ${c.name}${c.emails.length ? "  <" + c.emails.join(", ") + ">" : ""}`);
      return;
    }
    case "add-customer":
    case "add-refill-plant": {
      if (typeof args.name !== "string") throw new Error("--name is required");
      const ctx = await writeCtx();
      const keys = await unlock(ctx);
      const type = command === "add-customer" ? "customer" : "refill";
      const id = await O.addCounterparty(ctx, keys, { type, name: args.name, emails: args.email });
      console.log(`Added ${args.name}: ${id}`);
      return;
    }
    case "edit-counterparty": {
      const cpId = args._[1];
      if (!cpId) throw new Error("usage: edit-counterparty <id> [--name <name>] [--email <address>]...");
      const ctx = await writeCtx();
      const fields = {};
      if (typeof args.name === "string") fields.name = args.name;
      if (args.email.length) fields.emails = args.email;
      return done(await O.updateCounterparty(ctx, await unlock(ctx), cpId, fields));
    }
    case "remove-counterparty": {
      const cpId = args._[1];
      if (!cpId) throw new Error("usage: remove-counterparty <id>");
      return done(await O.removeCounterparty(await writeCtx(), cpId));
    }
    case "change-password": {
      const ctx = await writeCtx();
      const { dek } = args.recovery
        ? await O.unlockWithRecoveryCode(ctx, await ask("Recovery code (24 words): ", { hidden: true }))
        : await O.unlockWithPassword(ctx, await ask("Current data password: ", { hidden: true }));
      const password = await askNewSecret("New data password", S.checkPassword);
      done(await O.changePassword(ctx, dek, password));
      console.log("Phones already set up keep working. The old password stays in the chain's history.");
      return;
    }
    default:
      throw new Error(`unknown command "${command}" (node scripts/owner.js help)`);
  }
}

main()
  .then(() => rl && rl.close())
  .catch((e) => {
    console.error("Error: " + (e.shortMessage || e.message));
    process.exit(1);
  });
