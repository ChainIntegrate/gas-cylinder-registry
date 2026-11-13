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
  const txs = new Map(); // hash -> { state, blockNumber, mail }
  const ipHits = new Map(); // ip -> [timestamps]
  const registryDay = new Map(); // registry|day -> count
  let queue = Promise.resolve();
  let lastLowBalanceMail = 0;

  // --- checks ---

  function rateLimit(ip, registry) {
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= limits.perIpPerMinute) throw new Refused("too many requests, wait a minute", 429);
    hits.push(now);
    ipHits.set(ip, hits);
    const key = `${registry}|${new Date().toISOString().slice(0, 10)}`;
    const n = registryDay.get(key) || 0;
    if (n >= limits.perRegistryPerDay) throw new Refused("this registry reached its daily limit of operations", 429);
    registryDay.set(key, n + 1);
    if (registryDay.size > 10000) registryDay.clear();
    if (ipHits.size > 10000) ipHits.clear();
  }

  async function checkRegistry(address) {
    if (!isAddress(address)) throw new Refused("registry: not an address");
    const a = getAddress(address);
    if (knownRegistries.has(a)) return a;
    if (!(await factory.isRegistry(a))) throw new Refused("registry: not created by this service's factory", 403);
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
      const tx = await reg[method](...args, { gasLimit });
      byOperation.set(opKey, tx.hash);
      txs.set(tx.hash, { state: "pending", mail: mail ? "pending" : "none" });
      if (txs.size > 5000) txs.delete(txs.keys().next().value);
      if (byOperation.size > 5000) byOperation.delete(byOperation.keys().next().value);
      log(`sent ${method} to ${registry}: ${tx.hash}`);
      follow(tx, registry, mail);
      return tx.hash;
    });
    queue = send.catch(() => {});
    return { hash: await send };
  }

  async function follow(tx, registry, mail) {
    const entry = txs.get(tx.hash);
    try {
      const receipt = await tx.wait();
      entry.state = receipt.status === 1 ? "confirmed" : "failed";
      entry.blockNumber = receipt.blockNumber;
      log(`${tx.hash} ${entry.state} in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
    } catch (e) {
      entry.state = "failed";
      log(`${tx.hash} failed: ${e.shortMessage || e.message}`);
    }
    if (mail) {
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
          log(`mail for ${tx.hash} failed: ${e.message}`);
        }
      }
      // What was sent is logged, never to whom or what it said.
      log(`mail for ${tx.hash}: ${entry.mail}, ${mail.to.length} recipient(s)`);
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

  async function info() {
    const balance = await provider.getBalance(wallet.address);
    return {
      relayer: wallet.address,
      chainId: Number(config.chainId),
      factory: getAddress(config.factory),
      balance: formatEther(balance),
      mail: Boolean(sendMail),
      limits: { maxMints: limits.maxMints, maxUpdates: limits.maxUpdates, maxDocumentBytes: limits.maxDocumentBytes },
    };
  }

  async function postDocument(body, ip) {
    const registry = await checkRegistry(body.registry);
    rateLimit(ip, registry);
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
    const registry = await checkRegistry(body.registry);
    rateLimit(ip, registry);
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

  return { server, info, checkBalance };
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
    const { chainId } = await provider.getNetwork();
    if (Number(chainId) !== Number(config.chainId)) throw new Error(`the RPC is on chain ${chainId}, not ${config.chainId}`);
    if ((await provider.getCode(config.factory)) === "0x") throw new Error(`no contract at the factory ${config.factory}`);
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

module.exports = { createRelayer, loadConfig, Refused };
