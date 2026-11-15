#!/usr/bin/env node
"use strict";
// gas-cylinder-registry relayer: sends the operations signed by phones and owners to their registry,
// pays the gas on LUKSO, and sends a document's e-mail once its transaction is confirmed.
//
//   node relay.js new-key <file>                 create the relayer's key file (prints its address)
//   node relay.js serve --config <config.json>   run the service
//
// See relayer/README.md.

const fs = require("fs");
const http = require("http");
const path = require("path");

// shared/ (outside this folder) requires ethers: resolve it from the relayer's own node_modules, also when
// the script is run by hand (the systemd unit sets NODE_PATH; a plain "node relay.js …" does not).
process.env.NODE_PATH = [path.join(__dirname, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require("module").Module._initPaths();
const { URL } = require("url");
const { Wallet, JsonRpcProvider, Contract, getAddress, isAddress, keccak256, formatEther, parseEther, getBytes, verifyMessage, hashMessage } =
  require("ethers");
const REGISTRY_ABI = require("../shared/abi/GasCylinderRegistry.json");
const FACTORY_ABI = require("../shared/abi/GasCylinderRegistryFactory.json");
const { validateMail, mailDigest } = require("../shared/mail");
const { recordDocumentDigest } = require("../shared/eip712");

const OWNER_METHODS = ["setOperatorSigned", "setDataSigned", "transferOwnershipSigned", "acceptOwnershipSigned"];
const ERC1271_ABI = ["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"];

const DEFAULT_LIMITS = {
  perIpPerMinute: 20,
  perRegistryPerDay: 300,
  maxMints: 25,
  maxUpdates: 60,
  maxDocumentBytes: 16384,
  maxDataBytes: 65536,
  maxBodyBytes: 700 * 1024,
  gasLimitCap: 16000000,
};

class Refused extends Error {
  constructor(message, status = 400, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

let log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------------------------------------
// Configuration and key
// ------------------------------------------------------------------------------------------------

function loadConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  // rpcFile: a file holding the RPC URL (ChainIntegrate's node, whose URL carries an access key), readable
  // only by the service; it takes the place of "rpc".
  if (c.rpcFile) c.rpc = fs.readFileSync(c.rpcFile, "utf8").trim();
  if (!c.rpc || !c.factory || !c.chainId) throw new Error("config: rpc (or rpcFile), chainId and factory are required");
  c.listen = { host: "127.0.0.1", port: 8789, ...(c.listen || {}) };
  c.allowedOrigins = c.allowedOrigins || [];
  c.limits = { ...DEFAULT_LIMITS, ...(c.limits || {}) };
  c.minBalanceWarn = c.minBalanceWarn || "0.5";
  // The journal (review A07): systemd's StateDirectory makes /var/lib/gcr-relayer, writable by the service.
  if (c.stateFile === undefined) c.stateFile = "/var/lib/gcr-relayer/journal.json";
  return c;
}

function loadKey(file) {
  const st = fs.statSync(file);
  if (st.mode & 0o077) throw new Error(`${file} is readable by other users: chmod 600 it`);
  const pk = fs.readFileSync(file, "utf8").trim();
  return new Wallet(pk);
}

// ------------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------------

/**
 * Builds the relayer. `wallet` is connected to `provider`; `sendMail({ to, subject, text, attachments })`
 * sends an e-mail (or is null when SMTP is not configured). `logger` replaces the console log.
 */
function createRelayer({ provider, wallet, config, sendMail = null, logger = null }) {
  if (logger) log = logger;
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const factory = new Contract(config.factory, FACTORY_ABI, provider);
  const knownRegistries = new Set();
  const byOperation = new Map(); // keccak256(signature) -> hash
  const txs = new Map(); // hash -> { state, blockNumber, mail } (what /gcr/status answers)
  const pendingMail = new Map(); // hash -> the e-mail still to send (kept on disk until sent)
  const sentAt = new Map(); // hash -> when it was sent (ms), to forget old entries
  const ipHits = new Map(); // ip -> [timestamps]
  const registryDay = new Map(); // registry|day -> count
  let queue = Promise.resolve();
  let lastLowBalanceMail = 0;

  // --- the journal (external review A07) ---
  // With config.stateFile, what the relayer sent survives a restart: each transaction's state, the
  // operation it carried, the registries' daily counts, and an e-mail until it is sent (its content is
  // then dropped). At start the relayer reads it back, waits for the transactions left pending and sends
  // the e-mails left unsent. An e-mail can leave twice if the relayer stops between the SMTP server's
  // answer and the journal's update: a duplicate rather than a loss. Entries older than seven days go.
  const KEEP_MS = 7 * 24 * 3600 * 1000;
  function saveJournal() {
    if (!config.stateFile) return;
    const now = Date.now();
    const ops = [];
    for (const [opKey, hash] of byOperation) {
      const t = txs.get(hash);
      if (!t || now - (sentAt.get(hash) || now) > KEEP_MS) continue;
      ops.push({ opKey, hash, at: sentAt.get(hash) || now, ...t, ...(pendingMail.has(hash) ? { pendingMail: pendingMail.get(hash) } : {}) });
    }
    const data = JSON.stringify({ v: 1, ops, registryDay: [...registryDay] });
    const tmp = `${config.stateFile}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, config.stateFile);
  }
  function loadJournal() {
    if (!config.stateFile || !fs.existsSync(config.stateFile)) return [];
    let j;
    try {
      j = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    } catch (e) {
      log(`journal ${config.stateFile} unreadable (${e.message}): starting empty`);
      return [];
    }
    const now = Date.now();
    const resume = [];
    for (const o of j.ops || []) {
      if (now - o.at > KEEP_MS) continue;
      byOperation.set(o.opKey, o.hash);
      txs.set(o.hash, { state: o.state, ...(o.blockNumber ? { blockNumber: o.blockNumber } : {}), mail: o.mail });
      sentAt.set(o.hash, o.at);
      if (o.pendingMail) pendingMail.set(o.hash, o.pendingMail);
      if (o.state === "pending" || o.mail === "pending") resume.push(o.hash);
    }
    for (const [k, n] of j.registryDay || []) registryDay.set(k, n);
    return resume;
  }

  // --- checks ---

  // Two limits (external review G-01). Per IP, checked first, before any call to the node: it costs
  // nothing and it bounds what one source can make the relayer do. Per registry per day, the registry's
  // own budget: charged only for an operation that passed every check and the simulation, right before it
  // is sent, so requests that are malformed, badly signed or from unauthorized signers never use it up.
  function ipLimit(ip) {
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= limits.perIpPerMinute) throw new Refused("too many requests, wait a minute", 429);
    hits.push(now);
    ipHits.set(ip, hits);
    if (ipHits.size > 10000) ipHits.clear();
  }

  const dayKey = (registry) => `${registry}|${new Date().toISOString().slice(0, 10)}`;
  function checkQuota(registry) {
    if ((registryDay.get(dayKey(registry)) || 0) >= limits.perRegistryPerDay) {
      throw new Refused("this registry reached its daily limit of operations", 429);
    }
  }
  function chargeQuota(registry) {
    checkQuota(registry);
    const key = dayKey(registry);
    if (registryDay.size > 10000) registryDay.clear();
    registryDay.set(key, (registryDay.get(key) || 0) + 1);
  }

  // A factory's answer: yes is kept for good (a registry stays one), no for ten minutes, so that repeated
  // requests naming a foreign address do not each cost a call to the node.
  const notRegistries = new Map(); // address -> time of the answer
  async function checkRegistry(address) {
    if (!isAddress(address)) throw new Refused("registry: not an address");
    const a = getAddress(address);
    if (knownRegistries.has(a)) return a;
    const no = notRegistries.get(a);
    if (no && Date.now() - no < 600000) throw new Refused("registry: not created by this service's factory", 403);
    if (!(await factory.isRegistry(a))) {
      if (notRegistries.size > 10000) notRegistries.clear();
      notRegistries.set(a, Date.now());
      throw new Refused("registry: not created by this service's factory", 403);
    }
    knownRegistries.add(a);
    return a;
  }

  function hexBytes(what, v, max) {
    if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Refused(`${what}: not hex bytes`);
    if ((v.length - 2) / 2 > max) throw new Refused(`${what}: too large`);
    return v;
  }

  async function checkMailSignature(registry, signer, operationDigest, mail, mailSignature) {
    const digest = getBytes(mailDigest(registry, operationDigest, mail));
    hexBytes("mailSignature", mailSignature, 2048);
    let ok = false;
    try {
      ok = getAddress(verifyMessage(digest, mailSignature)) === getAddress(signer);
    } catch {
      ok = false;
    }
    if (!ok && (await provider.getCode(signer)) !== "0x") {
      try {
        const res = await new Contract(signer, ERC1271_ABI, provider).isValidSignature(hashMessage(digest), mailSignature);
        ok = res === "0x1626ba7e";
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new Refused("mail: not signed by the operation's signer", 403);
  }

  // --- sending ---

  function decodeRevert(e) {
    const data = e && (e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data));
    if (e && e.revert && e.revert.name) return { error: e.revert.name, args: e.revert.args.map(String) };
    try {
      const parsed = new Contract(config.factory, REGISTRY_ABI).interface.parseError(data);
      if (parsed) return { error: parsed.name, args: parsed.args.map(String) };
    } catch {
      /* not a registry error */
    }
    return { error: e && (e.shortMessage || e.message) ? String(e.shortMessage || e.message) : "reverted" };
  }

  async function relay(registry, method, args, opSignature, mail) {
    const opKey = keccak256(opSignature);
    if (byOperation.has(opKey)) return { hash: byOperation.get(opKey), repeated: true };
    checkQuota(registry); // before the simulation: a registry at its limit costs no call to the node

    const reg = new Contract(registry, REGISTRY_ABI, wallet);
    let gas = null;
    try {
      // Simulated within the per-transaction cap, so that an operation too large for one transaction is
      // refused here rather than by the network.
      const cap = { gasLimit: BigInt(limits.gasLimitCap) };
      await reg[method].staticCall(...args, cap);
      try {
        gas = await reg[method].estimateGas(...args, cap);
      } catch {
        // The simulation within the cap succeeded, but some nodes' estimates overshoot large writes
        // (seen on the local test network): use the cap, only the gas actually used is paid.
        gas = null;
      }
    } catch (e) {
      const r = decodeRevert(e);
      throw new Refused(`refused by the registry: ${r.error}`, 400, r);
    }
    const capGas = BigInt(limits.gasLimitCap);
    const gasLimit = gas === null || (gas * 125n) / 100n > capGas ? capGas : (gas * 125n) / 100n;

    // One transaction at a time, so that the relayer's nonces never collide.
    const send = queue.then(async () => {
      if (byOperation.has(opKey)) return byOperation.get(opKey);
      chargeQuota(registry);
      const tx = await reg[method](...args, { gasLimit });
      byOperation.set(opKey, tx.hash);
      txs.set(tx.hash, { state: "pending", mail: mail ? "pending" : "none" });
      sentAt.set(tx.hash, Date.now());
      if (mail) pendingMail.set(tx.hash, mail);
      if (txs.size > 5000) {
        const old = txs.keys().next().value;
        txs.delete(old);
        sentAt.delete(old);
        pendingMail.delete(old);
      }
      if (byOperation.size > 5000) byOperation.delete(byOperation.keys().next().value);
      saveJournal();
      log(`sent ${method} to ${registry}: ${tx.hash}`);
      follow(tx.hash);
      return tx.hash;
    });
    queue = send.catch(() => {});
    return { hash: await send };
  }

  /** Waits for a transaction (sent now, or left pending by a restart), then sends its e-mail. */
  async function follow(hash) {
    const entry = txs.get(hash);
    if (entry.state === "pending") {
      try {
        // The receipt, asked every few seconds for at most 30 minutes (any provider can answer this).
        let receipt = null;
        const poll = config.receiptPollMs || 2000;
        for (const until = Date.now() + 30 * 60 * 1000; !receipt; ) {
          receipt = await provider.getTransactionReceipt(hash);
          if (!receipt) {
            if (Date.now() > until) throw new Error("no receipt after 30 minutes");
            await new Promise((r) => setTimeout(r, poll));
          }
        }
        entry.state = receipt.status === 1 ? "confirmed" : "failed";
        if (receipt) entry.blockNumber = receipt.blockNumber;
        log(`${hash} ${entry.state}${receipt ? ` in block ${receipt.blockNumber}, gas ${receipt.gasUsed}` : ""}`);
      } catch (e) {
        // Still unknown after 30 minutes (or the node failed): left pending, taken up at the next start.
        log(`${hash}: no receipt yet (${e.shortMessage || e.message})`);
        return;
      }
      saveJournal();
    }
    const mail = pendingMail.get(hash);
    if (mail && entry.mail === "pending") {
      if (entry.state !== "confirmed") entry.mail = "not_sent";
      else if (!sendMail) entry.mail = "failed";
      else {
        try {
          await sendMail({
            to: mail.to.join(", "),
            subject: mail.subject,
            text: mail.text,
            attachments: mail.attachment ? [{ filename: mail.attachment.filename, content: Buffer.from(mail.attachment.base64, "base64"), contentType: "application/pdf" }] : undefined,
          });
          entry.mail = "sent";
        } catch (e) {
          entry.mail = "failed";
          log(`mail for ${hash} failed: ${e.message}`);
        }
      }
      pendingMail.delete(hash); // its content leaves the disk with the next save
      saveJournal();
      // What was sent is logged, never to whom or what it said.
      log(`mail for ${hash}: ${entry.mail}, ${mail.to.length} recipient(s)`);
    }
    checkBalance().catch(() => {});
  }

  async function checkBalance() {
    const balance = await provider.getBalance(wallet.address);
    if (balance >= parseEther(String(config.minBalanceWarn))) return;
    log(`WARNING: relayer balance ${formatEther(balance)} LYX, below ${config.minBalanceWarn}`);
    if (sendMail && Date.now() - lastLowBalanceMail > 24 * 3600 * 1000) {
      lastLowBalanceMail = Date.now();
      await sendMail({
        subject: "gas-cylinder-registry relayer: low balance",
        text: `The relayer ${wallet.address} has ${formatEther(balance)} LYX, below ${config.minBalanceWarn}. Top it up on LUKSO.`,
      }).catch((e) => log(`low-balance mail failed: ${e.message}`));
    }
  }

  // --- endpoints ---

  // The latest released app, from a file the operator updates after each release (appReleaseFile), or the
  // config itself (appRelease): { version: "x.y.z", url: the release's APK on GitHub }. Read at every
  // request, so updating the file needs no restart. Anything else is not announced.
  const APK_URL = /^https:\/\/github\.com\/ChainIntegrate\/gas-cylinder-registry\/releases\/download\/v(\d+\.\d+\.\d+)\/[\w.-]+\.apk$/;
  function appRelease() {
    let a = config.appRelease || null;
    if (!a && config.appReleaseFile) {
      try {
        a = JSON.parse(fs.readFileSync(config.appReleaseFile, "utf8"));
      } catch {
        return null;
      }
    }
    if (!a || !/^\d+\.\d+\.\d+$/.test(String(a.version))) return null;
    const m = APK_URL.exec(String(a.url));
    if (!m || m[1] !== a.version) return null;
    return { version: a.version, url: a.url };
  }

  async function info() {
    const balance = await provider.getBalance(wallet.address);
    const app = appRelease();
    return {
      relayer: wallet.address,
      chainId: Number(config.chainId),
      factory: getAddress(config.factory),
      balance: formatEther(balance),
      mail: Boolean(sendMail),
      limits: { maxMints: limits.maxMints, maxUpdates: limits.maxUpdates, maxDocumentBytes: limits.maxDocumentBytes },
      ...(app ? { app } : {}),
    };
  }

  async function postDocument(body, ip) {
    ipLimit(ip);
    const registry = await checkRegistry(body.registry);
    const p = body.payload || {};
    if (!Array.isArray(p.mints) || !Array.isArray(p.updates)) throw new Refused("payload: mints and updates are required");
    if (p.mints.length > limits.maxMints || p.updates.length > limits.maxUpdates) {
      throw new Refused(`payload: at most ${limits.maxMints} new cylinders and ${limits.maxUpdates} updates per operation`);
    }
    hexBytes("payload.document", p.document || "0x", limits.maxDocumentBytes);
    for (const u of p.updates) hexBytes("payload.updates.newValue", u.newValue, 1024);
    if (!isAddress(body.signer)) throw new Refused("signer: not an address");
    const signature = hexBytes("signature", body.signature, 2048);

    const reg = new Contract(registry, REGISTRY_ABI, provider);
    if (!(await reg.isAuthorized(body.signer))) throw new Refused("signer: not the owner nor an authorized phone", 403);

    let mail = null;
    if (body.mail) {
      try {
        mail = validateMail(body.mail);
      } catch (e) {
        throw new Refused(e.message);
      }
    }

    const payload = {
      docId: p.docId,
      part: p.part,
      parts: p.parts,
      corrects: p.corrects,
      mints: p.mints,
      updates: p.updates.map((u) => ({ tokenId: u.tokenId, dataKey: u.dataKey, expectedHash: u.expectedHash, newValue: u.newValue })),
      document: p.document || "0x",
    };
    if (mail) {
      let digest;
      try {
        digest = recordDocumentDigest(registry, config.chainId, getAddress(body.signer), payload, BigInt(body.nonce), BigInt(body.deadline));
      } catch {
        throw new Refused("payload: malformed");
      }
      await checkMailSignature(registry, body.signer, digest, mail, body.mailSignature);
    }
    return relay(registry, "recordDocument", [payload, getAddress(body.signer), BigInt(body.nonce), BigInt(body.deadline), signature], signature, mail);
  }

  async function postOwner(body, ip) {
    ipLimit(ip);
    const registry = await checkRegistry(body.registry);
    if (!OWNER_METHODS.includes(body.method)) throw new Refused(`method: one of ${OWNER_METHODS.join(", ")}`);
    if (!Array.isArray(body.args)) throw new Refused("args: an array");
    if (JSON.stringify(body.args).length > limits.maxDataBytes * 2 + 4096) throw new Refused("args: too large");
    const signature = body.args[body.args.length - 1];
    hexBytes("signature", signature, 2048);
    return relay(registry, body.method, body.args, signature, null);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limits.maxBodyBytes) {
          reject(new Refused("request too large", 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, obj) => {
      const headers = { "content-type": "application/json", "cache-control": "no-store" };
      if (origin && config.allowedOrigins.includes(origin)) {
        headers["access-control-allow-origin"] = origin;
        headers["vary"] = "Origin";
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(obj));
    };
    try {
      if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) throw new Refused("origin not allowed", 403);
      const url = new URL(req.url, "http://localhost");
      // nginx sets X-Real-IP; Apache's mod_proxy appends the client to X-Forwarded-For (the last entry is
      // the one Apache saw, the earlier ones come from the client and are not trusted).
      const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
      const ip = req.headers["x-real-ip"] || xff[xff.length - 1] || req.socket.remoteAddress;
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": origin || "*",
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/gcr/info") return send(200, await info());
      if (req.method === "GET" && url.pathname === "/gcr/status") {
        const t = txs.get(String(url.searchParams.get("hash") || "").toLowerCase()) || txs.get(String(url.searchParams.get("hash") || ""));
        return t ? send(200, t) : send(404, { error: "unknown transaction" });
      }
      if (req.method === "POST" && (url.pathname === "/gcr/document" || url.pathname === "/gcr/owner")) {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof Refused) throw e;
          throw new Refused("body is not JSON");
        }
        const out = url.pathname === "/gcr/document" ? await postDocument(body, ip) : await postOwner(body, ip);
        return send(200, out);
      }
      send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof Refused) {
        log(`refused (${e.status}): ${e.message}`);
        return send(e.status, { error: e.message, ...(e.extra ? { detail: e.extra } : {}) });
      }
      log(`error: ${e.stack || e.message}`);
      send(500, { error: "internal error" });
    }
  });

  // Taken up after a restart: transactions left pending, e-mails left unsent.
  const toResume = loadJournal();
  if (toResume.length) log(`journal: taking up ${toResume.length} operation(s) left pending`);
  const resumed = Promise.all(toResume.map((h) => follow(h).catch((e) => log(`resume ${h}: ${e.message}`))));

  return { server, info, checkBalance, resumed };
}

// ------------------------------------------------------------------------------------------------
// Command line
// ------------------------------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "new-key") {
    const file = rest[0];
    if (!file) throw new Error("usage: node relay.js new-key <file>");
    if (fs.existsSync(file)) throw new Error(`${file} already exists`);
    const w = Wallet.createRandom();
    fs.writeFileSync(file, w.privateKey + "\n", { mode: 0o600 });
    console.log(`Relayer address: ${w.address}\nFund it with LYX on LUKSO.`);
    return;
  }
  if (cmd === "serve") {
    const i = rest.indexOf("--config");
    const config = loadConfig(i >= 0 ? rest[i + 1] : "/etc/gcr-relayer/config.json");
    const provider = new JsonRpcProvider(config.rpc, Number(config.chainId), { staticNetwork: true });
    // The node is asked for its chain (a provider with a static network would only repeat the configured
    // one: review A15), and the factory must answer as GasTrace's factory, with its implementation in place.
    const chainId = Number(await provider.send("eth_chainId", []));
    if (chainId !== Number(config.chainId)) throw new Error(`the RPC is on chain ${chainId}, not ${config.chainId}`);
    const factoryCheck = new Contract(config.factory, FACTORY_ABI, provider);
    let impl;
    try {
      impl = await factoryCheck.implementation();
    } catch {
      throw new Error(`no GasTrace factory at ${config.factory}`);
    }
    if ((await provider.getCode(impl)) === "0x") throw new Error(`the factory's implementation ${impl} has no code`);
    const wallet = loadKey(config.keyFile).connect(provider);
    const mail = require("./mail");
    const relayer = createRelayer({ provider, wallet, config, sendMail: mail.smtpReady() ? mail.sendMail : null });
    await new Promise((r) => relayer.server.listen(config.listen.port, config.listen.host, r));
    const i0 = await relayer.info();
    log(`relayer ${i0.relayer} on chain ${i0.chainId}, balance ${i0.balance} LYX, factory ${i0.factory}, mail ${i0.mail ? "on" : "OFF (no SMTP settings)"}`);
    log(`listening on http://${config.listen.host}:${config.listen.port}`);
    relayer.checkBalance().catch(() => {});
    return;
  }
  console.log("usage: node relay.js new-key <file> | serve --config <file>");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Error: " + (e.shortMessage || e.message));
    process.exit(1);
  });
}

module.exports = { createRelayer, loadConfig, Refused, DEFAULT_LIMITS };
