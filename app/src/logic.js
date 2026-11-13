"use strict";
// The app's logic, without any user interface: reading cylinders and the owner's lists, proposing each
// movement, building and signing a document, the outbox of documents waiting for the network, the
// e-mail. The interface (ui.js) and the tests call these functions.

const { Contract, getAddress, getBytes, hashMessage, keccak256, ZeroHash } = require("ethers");
const S = require("../../shared");
const ABI = require("../../shared/abi/GasCylinderRegistry.json");
const { T } = require("./i18n");

const DEADLINE_SECONDS = 7 * 24 * 3600; // long enough for a document waiting offline
const LIMITS = { maxMints: 25, maxUpdates: 60 };

const MOVES_BY_KIND = {
  delivery_note: ["delivery", "collection"],
  refill_note: ["to_refill", "from_refill"],
  stock_count: ["stock_count"],
};

// ------------------------------------------------------------------------------------------------
// Reading the registry
// ------------------------------------------------------------------------------------------------

class Registry {
  /**
   * @param o.provider  an ethers provider (LUKSO's public RPC in the app)
   * @param o.address   the registry's address (from the setup code)
   * @param o.fromBlock the registry's creation block (from the setup code)
   * @param o.keys      the working keys (S.deriveKeys of the data key), once unlocked
   */
  constructor({ provider, address, fromBlock = 0, keys = null }) {
    this.provider = provider;
    this.address = getAddress(address);
    this.fromBlock = fromBlock;
    this.keys = keys;
    this.contract = new Contract(this.address, ABI, provider);
    this.cache = new Map(); // tokenId -> last cylinder read (used offline)
  }

  async chainId() {
    if (!this._chainId) this._chainId = Number((await this.provider.getNetwork()).chainId);
    return this._chainId;
  }

  isAuthorized(address) {
    return this.contract.isAuthorized(address);
  }

  passwordWrap() {
    return this.contract.getData(S.KEY_WRAP_DATA_KEYS.password);
  }

  async settings() {
    const raw = await this.contract.getData(S.SETTINGS_DATA_KEY);
    return raw === "0x" ? null : S.validateSettings(await S.decryptValue(this.keys, S.SETTINGS_DATA_KEY, "settings", raw));
  }

  /** Customers and refill plants: [{ id, type, name, emails }], sorted by name. */
  async counterparties() {
    const latest = await this.provider.getBlockNumber();
    const prefix = S.COUNTERPARTY_KEY_PREFIX.toLowerCase();
    const ids = new Set();
    let step = 100000;
    for (let from = this.fromBlock; from <= latest; ) {
      const to = Math.min(from + step - 1, latest);
      let logs;
      try {
        logs = await this.contract.queryFilter(this.contract.filters.DataChanged(), from, to);
      } catch (e) {
        // RPCs limit the range of a log read: halve it and try again.
        if (step <= 1000) throw e;
        step = Math.floor(step / 2);
        continue;
      }
      for (const l of logs) {
        const k = l.args.dataKey.toLowerCase();
        if (k.startsWith(prefix)) ids.add("0x" + k.slice(-40));
      }
      from = to + 1;
    }
    const list = [];
    for (const id of ids) {
      const raw = await this.contract.getData(S.counterpartyDataKey(id));
      if (raw !== "0x") list.push({ id, ...S.validateCounterparty(await S.decryptValue(this.keys, id, "counterparty", raw)) });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A cylinder by its scanned or typed code: { serial, tokenId, known, info, state, rawState, offline }.
   * Throws "invalid serial" for a code that cannot be a label. Offline, the last read is used.
   */
  async readCylinder(code) {
    const serial = S.normalizeSerial(code);
    const tokenId = await S.cylinderTokenId(this.keys, serial);
    try {
      const [rawInfo, rawState] = await this.contract.getDataBatchForTokenIds([tokenId, tokenId], [S.INFO_KEY, S.STATE_KEY]);
      const c = {
        serial,
        tokenId,
        known: rawInfo !== "0x",
        info: rawInfo === "0x" ? null : S.validateInfo(await S.decryptValue(this.keys, tokenId, "info", rawInfo)),
        state: rawState === "0x" ? null : S.validateState(await S.decryptValue(this.keys, tokenId, "state", rawState)),
        rawState,
        offline: false,
      };
      this.cache.set(tokenId, c);
      return c;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const cached = this.cache.get(tokenId);
      if (cached) return { ...cached, offline: true };
      return { serial, tokenId, known: false, info: null, state: null, rawState: "0x", offline: true, unverified: true };
    }
  }
}

function isNetworkError(e) {
  const m = String((e && (e.code || e.message)) || "");
  return /NETWORK_ERROR|TIMEOUT|SERVER_ERROR|fetch|network|ECONNREFUSED|Failed to fetch/i.test(m);
}

// ------------------------------------------------------------------------------------------------
// Proposing a movement
// ------------------------------------------------------------------------------------------------

/**
 * What to do with a scanned cylinder in a document of `kind` for `counterparty`: the proposed movement
 * and condition, and a warning (anomaly) when its last state does not fit. `names` maps counterparty
 * ids to names, for the warnings.
 * Returns { movement, condition, anomaly: null | { code, name? } }.
 */
function propose(cyl, counterparty, kind, names = {}) {
  const st = cyl.state;
  const here = (type) => st && st.location.type === type && st.location.id === counterparty.id.toLowerCase();
  const nameOf = (id) => names[id] || "?";
  let anomaly = null;
  if (st && st.lifecycle === "retired") anomaly = { code: "retired" };

  if (kind === "stock_count") {
    if (!anomaly && st && !here(counterparty.type === "refill" ? "refill" : "customer")) {
      anomaly = st.location.type === "depot" ? { code: "not_here" } : { code: "at_other", name: nameOf(st.location.id) };
    }
    return { movement: "stock_count", condition: st ? st.condition : "full", anomaly };
  }

  if (kind === "refill_note") {
    if (here("refill")) return { movement: "from_refill", condition: "full", anomaly };
    if (!anomaly && st && st.location.type !== "depot") anomaly = { code: "at_other", name: nameOf(st.location.id) };
    return { movement: "to_refill", condition: st ? st.condition : "empty", anomaly };
  }

  // delivery_note
  if (here("customer")) return { movement: "collection", condition: "empty", anomaly };
  if (st && st.location.type === "customer") {
    // Recorded at another customer: most likely collected there without a record. Propose a collection.
    return { movement: "collection", condition: "empty", anomaly: anomaly || { code: "at_other", name: nameOf(st.location.id) } };
  }
  if (!anomaly && st && st.location.type === "refill") anomaly = { code: "at_refill", name: nameOf(st.location.id) };
  if (!anomaly && cyl.info && cyl.info.owner !== "supplier" && cyl.info.owner !== counterparty.id.toLowerCase()) {
    anomaly = { code: "owned_by_other", name: nameOf(cyl.info.owner) };
  }
  return { movement: "delivery", condition: "full", anomaly };
}

/** The state a line leaves the cylinder in. */
function nextState(line, counterparty, at) {
  const cp = counterparty.id.toLowerCase();
  const location = {
    delivery: { type: "customer", id: cp },
    collection: { type: "depot" },
    to_refill: { type: "refill", id: cp },
    from_refill: { type: "depot" },
    stock_count: { type: counterparty.type === "refill" ? "refill" : "customer", id: cp },
  }[line.movement];
  if (!location) throw new Error(`movement ${line.movement} not allowed here`);
  return S.validateState({ v: 1, location, condition: line.condition, lifecycle: "active", movement: line.movement, at });
}

/** Counts per movement and gas: { delivery: { argon: 2 }, collection: { ... } }. */
function summary(lines) {
  const out = {};
  for (const l of lines) {
    out[l.movement] = out[l.movement] || {};
    out[l.movement][l.gas] = (out[l.movement][l.gas] || 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Building and signing a document
// ------------------------------------------------------------------------------------------------

/**
 * Builds a document's operations, ready to sign.
 * @param o.registry     a Registry (with keys)
 * @param o.operator     this phone's address
 * @param o.counterparty { id, type, name, emails }
 * @param o.kind         "delivery_note" | "refill_note" | "stock_count"
 * @param o.number       the document number (a delivery or refill note); ignored for a stock count
 * @param o.lines        [{ serial, tokenId, known, rawState, gas, capacityL?, movement, condition, anomaly? }]
 * @param o.now          Unix time (seconds) of the document
 * Returns { docId, number, document, parts: [{ payload, nonce, deadline, digest }] }.
 */
async function buildDocument({ registry, operator, counterparty, kind, number, lines, now }) {
  if (!lines.length) throw new Error("no cylinders");
  const allowed = MOVES_BY_KIND[kind];
  if (!allowed) throw new Error(`unknown document kind ${kind}`);
  const docNumber = kind === "stock_count" ? `STOCK-${now}` : String(number || "").trim();
  if (!docNumber) throw new Error("missing document number");
  const keys = registry.keys;
  const docId = await S.documentId(keys, counterparty.id, docNumber);
  const chainId = await registry.chainId();

  // Per line: its mints and updates, kept together in one part.
  const groups = [];
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.tokenId)) throw new Error(`cylinder ${l.serial} twice`);
    seen.add(l.tokenId);
    if (!allowed.includes(l.movement)) throw new Error(`movement ${l.movement} not allowed in ${kind}`);
    const g = { mints: [], updates: [] };
    if (!l.known) {
      g.mints.push(l.tokenId);
      const info = S.validateInfo({ v: 1, serial: l.serial, gas: l.gas, capacityL: l.capacityL, owner: "supplier", registeredAt: now });
      g.updates.push({ tokenId: l.tokenId, dataKey: S.INFO_KEY, expectedHash: S.EMPTY_HASH, newValue: await S.encryptValue(keys, l.tokenId, "info", info) });
    }
    const state = nextState(l, counterparty, now);
    g.updates.push({
      tokenId: l.tokenId,
      dataKey: S.STATE_KEY,
      expectedHash: l.known ? keccak256(l.rawState) : S.EMPTY_HASH,
      newValue: await S.encryptValue(keys, l.tokenId, "state", state),
    });
    groups.push(g);
  }

  const document = S.validateDocument({
    v: 1,
    kind,
    number: kind === "stock_count" ? undefined : docNumber,
    date: now,
    counterparty: counterparty.id,
    lines: lines.map((l) => ({
      tokenId: l.tokenId,
      serial: l.serial,
      gas: l.gas,
      movement: l.movement,
      condition: l.condition,
      anomaly: l.anomaly ? l.anomaly.code + (l.anomaly.name ? `: ${l.anomaly.name}` : "") : undefined,
    })),
  });

  // Split into parts that fit one transaction.
  const chunks = [];
  let cur = { mints: [], updates: [] };
  for (const g of groups) {
    if (cur.mints.length + g.mints.length > LIMITS.maxMints || cur.updates.length + g.updates.length > LIMITS.maxUpdates) {
      chunks.push(cur);
      cur = { mints: [], updates: [] };
    }
    cur.mints.push(...g.mints);
    cur.updates.push(...g.updates);
  }
  chunks.push(cur);

  const encrypted = await S.encryptValue(keys, docId, "document", document);
  const deadline = BigInt(now + DEADLINE_SECONDS);
  const parts = chunks.map((c, i) => {
    const payload = {
      docId,
      part: i,
      parts: chunks.length,
      corrects: ZeroHash,
      mints: c.mints,
      updates: c.updates,
      document: i === chunks.length - 1 ? encrypted : "0x",
    };
    const nonce = S.randomNonce();
    return { payload, nonce, deadline, digest: S.recordDocumentDigest(registry.address, chainId, operator, payload, nonce, deadline) };
  });
  return { docId, number: docNumber, document, parts };
}

/** The e-mail of a document, in the app's language. */
function buildMail({ lang, company, counterparty, kind, number, lines, now, recipients }) {
  const t = T[lang] || T.it;
  const date = new Date(now * 1000).toLocaleString(lang === "en" ? "en-GB" : "it-IT", { dateStyle: "short", timeStyle: "short" });
  const sum = summary(lines);
  const out = [t.mailIntro(company, counterparty.name, date), ""];
  for (const [movement, byGas] of Object.entries(sum)) {
    const parts = Object.entries(byGas).map(([gas, n]) => `${n} ${t.gases[gas]}`);
    out.push(`${t.movements[movement]}: ${parts.join(", ")}`);
  }
  out.push("", `${t.mailLines}:`);
  for (const l of lines) out.push(`- ${l.serial}  ${t.gases[l.gas]}  ${t.movements[l.movement]}  ${t.conditions[l.condition]}`);
  const anomalies = lines.filter((l) => l.anomaly);
  if (anomalies.length) {
    out.push("", `${t.mailAnomalies}:`);
    for (const l of anomalies) out.push(`- ${l.serial}: ${anomalyText(t, l.anomaly)}`);
  }
  out.push("", t.mailFooter);
  return {
    to: recipients,
    subject: t.mailSubject(kind, kind === "stock_count" ? "" : number, company),
    text: out.join("\n"),
  };
}

function anomalyText(t, a) {
  const f = t.anomalies[a.code];
  return typeof f === "function" ? f(a.name || "?") : f || a.code;
}

/**
 * Signs the document's parts and its e-mail with one call to `signDigests` (one fingerprint).
 * `signDigests(digests)` returns 65-byte signatures (hex) of the raw 32-byte digests, in order.
 * Returns the outbox item: the bodies for the relayer, the e-mail on the last part.
 */
async function signDocument({ registry, operator, built, mail, signDigests, meta }) {
  const last = built.parts[built.parts.length - 1];
  const mailHash = mail ? hashMessage(getBytes(S.mailDigest(registry.address, last.digest, mail))) : null;
  const digests = built.parts.map((p) => p.digest).concat(mailHash ? [mailHash] : []);
  const sigs = await signDigests(digests);
  if (sigs.length !== digests.length) throw new Error("signatures missing");
  const parts = built.parts.map((p, i) => ({
    state: "new",
    body: {
      registry: registry.address,
      payload: p.payload,
      signer: operator,
      nonce: p.nonce.toString(),
      deadline: p.deadline.toString(),
      signature: sigs[i],
      ...(mail && i === built.parts.length - 1 ? { mail: S.validateMail(mail), mailSignature: sigs[sigs.length - 1] } : {}),
    },
  }));
  return { id: built.docId, createdAt: Date.now(), parts, mail: mail ? "pending" : "none", ...meta };
}

// ------------------------------------------------------------------------------------------------
// Outbox: documents signed, waiting to be sent
// ------------------------------------------------------------------------------------------------

class Outbox {
  /** `storage` is localStorage-like (getItem/setItem). */
  constructor(storage, key = "gcr.outbox.v1") {
    this.storage = storage;
    this.key = key;
  }
  list() {
    try {
      return JSON.parse(this.storage.getItem(this.key) || "[]");
    } catch {
      return [];
    }
  }
  save(items) {
    this.storage.setItem(this.key, JSON.stringify(items));
  }
  add(item) {
    this.save(this.list().filter((i) => i.id !== item.id).concat([item]));
  }
  update(item) {
    this.save(this.list().map((i) => (i.id === item.id ? item : i)));
  }
  remove(id) {
    this.save(this.list().filter((i) => i.id !== id));
  }
  pending() {
    return this.list().filter((i) => i.parts.some((p) => p.state !== "confirmed") || i.mail === "pending");
  }
}

/**
 * Sends an outbox item's parts in order, through the relayer, and waits for each to be recorded.
 * Updates the item in place (parts' state and hash, mail) and returns it. A network failure keeps the
 * item for later (`offline: true`); a refusal marks it `failed` with the relayer's reason.
 * With `provider`, a transaction the relayer no longer knows (it restarted) is looked up on the network;
 * its e-mail is then "unknown" (it may or may not have left).
 */
async function sendItem(item, { relayer, provider = null, fetchFn = fetch, pollMs = 1500, timeoutMs = 120000, onUpdate = () => {} }) {
  const base = relayer.replace(/\/+$/, "");
  for (const part of item.parts) {
    if (part.state === "confirmed") continue;
    if (!part.hash) {
      let res;
      try {
        res = await fetchFn(`${base}/gcr/document`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part.body) });
      } catch {
        item.offline = true;
        onUpdate(item);
        return item;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        item.failed = { status: res.status, error: (body.detail && body.detail.error) || (res.status === 429 ? "limit" : "generic"), message: body.error };
        onUpdate(item);
        return item;
      }
      part.hash = body.hash;
      part.state = "sent";
      item.offline = false;
      onUpdate(item);
    }
    // Wait until the relayer reports it recorded.
    const started = Date.now();
    for (;;) {
      let st;
      try {
        const r = await fetchFn(`${base}/gcr/status?hash=${part.hash}`);
        st = r.ok ? await r.json() : null;
        if (r.status === 404 && provider) {
          // The relayer restarted and forgot it: the network says whether it was recorded.
          const receipt = await provider.getTransactionReceipt(part.hash);
          if (receipt) st = { state: receipt.status === 1 ? "confirmed" : "failed", mail: part.body.mail ? "unknown" : "none" };
        }
      } catch {
        item.offline = true;
        onUpdate(item);
        return item;
      }
      if (st && st.state === "confirmed" && (!part.body.mail || st.mail !== "pending")) {
        part.state = "confirmed";
        if (part.body.mail) item.mail = st.mail;
        break;
      }
      if (st && st.state === "failed") {
        item.failed = { error: "generic" };
        onUpdate(item);
        return item;
      }
      if (Date.now() - started > timeoutMs) {
        onUpdate(item);
        return item;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    onUpdate(item);
  }
  item.done = true;
  onUpdate(item);
  return item;
}

/** True when version `a` (x.y.z) is newer than `b`. */
function isNewer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** The release the relayer announces, when it is newer than `current`: { version, url } or null. */
async function newerRelease(relayer, current, fetchFn = fetch) {
  try {
    const r = await fetchFn(`${relayer.replace(/\/+$/, "")}/gcr/info`);
    if (!r.ok) return null;
    const { app } = await r.json();
    if (!app || !/^\d+\.\d+\.\d+$/.test(app.version) || !/^https:\/\/github\.com\/ChainIntegrate\//.test(app.url)) return null;
    return isNewer(app.version, current) ? { version: app.version, url: app.url } : null;
  } catch {
    return null;
  }
}

/** The driver's message for a refusal or a network problem. */
function errorText(lang, failed) {
  const t = T[lang] || T.it;
  if (!failed) return "";
  return t.errors[failed.error] || t.errors.generic;
}

module.exports = {
  LIMITS,
  MOVES_BY_KIND,
  Registry,
  propose,
  nextState,
  summary,
  buildDocument,
  buildMail,
  anomalyText,
  signDocument,
  Outbox,
  sendItem,
  errorText,
  isNetworkError,
  isNewer,
  newerRelease,
};
