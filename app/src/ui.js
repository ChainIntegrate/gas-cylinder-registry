"use strict";
// The app's interface: one page, Italian and English, plain words only.

const { JsonRpcProvider, Contract, hexlify, getBytes } = require("ethers");
const S = require("../../shared");
const L = require("./logic");
const { T } = require("./i18n");
const { loadNative } = require("./native");
const { Vault } = require("./vault");
const CONFIG = require("../app-config.json");
// The app's version, from android/app/build.gradle (versionName), set by scripts/build-app.js.
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

// ------------------------------------------------------------------------------------------------
// State and storage
// ------------------------------------------------------------------------------------------------

const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    localStorage.setItem(k, JSON.stringify(v));
  },
  del(k) {
    localStorage.removeItem(k);
  },
};

const app = {
  lang: store.get("gcr.lang", (navigator.language || "it").startsWith("en") ? "en" : "it"),
  native: null,
  provider: null,
  reg: null,
  phone: null, // this phone's address
  settings: null,
  cps: [],
  view: "loading",
  msg: null,
  doc: null,
  check: null,
  result: null,
  // What the app keeps on the phone, encrypted under the data key (review A09): readable only unlocked.
  vault: new Vault(localStorage, ["gcr.outbox.v1", "gcr.lists", "gcr.draft"]),
  outbox: null,
  sending: 0, // sends in progress: the app does not lock in the middle of one
  online: navigator.onLine !== false,
  update: null, // a newer release announced by the relayer: { version, url }
};
app.outbox = new L.Outbox(app.vault);
const t = () => T[app.lang];
const LOCK_AFTER_MS = 10 * 60 * 1000; // locked after 10 minutes unused or in the background (review A09)
const names = () => Object.fromEntries(app.cps.map((c) => [c.id, c.name]));
const types = () => Object.fromEntries(app.cps.map((c) => [c.id, c.type]));
const thisMonth = () => S.monthOf(Math.floor(Date.now() / 1000));

// ------------------------------------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const btn = (label, onclick, cls = "") => h("button", { class: cls, onclick, type: "button" }, label);
const note = (text, cls = "note") => (text ? h("p", { class: cls }, text) : null);

function select(options, value, onchange, attrs = {}) {
  return h(
    "select",
    { ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label))
  );
}

function setView(view, extra = {}) {
  Object.assign(app, { view, msg: null }, extra);
  render();
}

function fail(e) {
  const tx = t();
  if (e && e.code === "CANCELED") app.msg = { text: tx.errors.cancelled, cls: "warn" };
  else if (e && e.code === "NO_AUTH") app.msg = { text: tx.noAuth, cls: "error" };
  else if (e && e.code === "TOO_LARGE") app.msg = { text: tx.errors.tooLarge, cls: "error" };
  else if (L.isNetworkError(e)) app.msg = { text: tx.errors.network, cls: "error" };
  else app.msg = { text: (e && e.message) || tx.errors.generic, cls: "error" };
  render();
}

function prompt(subtitle) {
  return { title: t().appName, subtitle, cancel: t().cancel };
}

// ------------------------------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------------------------------

async function start() {
  app.provider = new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true });
  window.addEventListener("online", () => {
    app.online = true;
    render();
    flushOutbox();
    checkUpdate();
  });
  checkUpdate();
  watchIdle();
  window.addEventListener("offline", () => {
    app.online = false;
    render();
  });
  try {
    app.native = await loadNative();
  } catch (e) {
    return setView("error", { msg: { text: e.message, cls: "error" } });
  }
  const setup = store.get("gcr.setup");
  const st = await app.native.deviceKey.status();
  app.phone = st.address || null;
  if (setup) app.reg = new L.Registry({ provider: app.provider, address: setup.registry, fromBlock: setup.fromBlock });
  if (setup && st.exists && st.hasDataKey) return setView("unlock");
  setView("setup");
}

/** Asks the relayer for the latest released app; a newer one shows a notice with its download link. */
async function checkUpdate() {
  const r = await L.newerRelease(CONFIG.relayer, APP_VERSION);
  if (r && (!app.update || app.update.version !== r.version)) {
    app.update = r;
    render();
  }
}

// ------------------------------------------------------------------------------------------------
// Setup (once, with the owner)
// ------------------------------------------------------------------------------------------------

async function setupCode(code) {
  let s;
  try {
    s = S.parseSetupCode(code);
  } catch {
    app.msg = { text: t().setupCodeInvalid, cls: "error" };
    return render();
  }
  // Before anything else: the network is the expected one (asked, not assumed: review A15) and the
  // register was created by GasTrace's factory (review G-09), so that the owner never types the data
  // password on a phone set up with a foreign code.
  try {
    const chainId = Number(await app.provider.send("eth_chainId", []));
    const factory = new Contract(CONFIG.factory, ["function isRegistry(address) view returns (bool)"], app.provider);
    if (chainId !== Number(CONFIG.chainId) || !(await factory.isRegistry(s.registry))) {
      app.msg = { text: t().setupCodeInvalid, cls: "error" };
      return render();
    }
  } catch (e) {
    return fail(e);
  }
  try {
    store.set("gcr.setup", s);
    app.reg = new L.Registry({ provider: app.provider, address: s.registry, fromBlock: s.fromBlock });
    render();
  } catch {
    app.msg = { text: t().setupCodeInvalid, cls: "error" };
    render();
  }
}

async function createKey() {
  try {
    const st = await app.native.deviceKey.status();
    if (!st.canAuth) throw Object.assign(new Error(t().noAuth), { code: "NO_AUTH" });
    const { address } = await app.native.deviceKey.create(prompt(t().setupStep2));
    app.phone = address;
    render();
    pollAuthorized();
  } catch (e) {
    fail(e);
  }
}

let polling = false;
async function pollAuthorized() {
  if (polling || !app.phone || !app.reg) return;
  polling = true;
  while (app.view === "setup" && !app.authorized) {
    try {
      app.authorized = await app.reg.isAuthorized(app.phone);
      if (app.authorized) render();
    } catch {
      /* no network: try again */
    }
    if (!app.authorized) await new Promise((r) => setTimeout(r, 4000));
  }
  polling = false;
}

async function enterPassword(password) {
  app.msg = { text: t().unlocking, cls: "note" };
  render();
  try {
    const wrap = await app.reg.passwordWrap();
    if (!wrap || wrap === "0x") return fail(new Error(t().noDataKeyYet)); // the owner has not prepared the data yet
    const dek = await S.unwrapWithPassword(wrap, password, app.reg.address);
    if (app.view === "newKey" && app.vault.unlocked) {
      // The owner replaced the data key (review A05): what the phone keeps (documents to send, lists) is
      // sealed again with the new key before the old one is forgotten.
      const keys = await app.reg.openKeys(dek);
      await app.vault.rekey(keys.cacheKey);
    }
    await app.native.deviceKey.storeDataKey(hexlify(dek), prompt(t().setupStep4));
    dek.fill(0);
    app.msg = { text: app.view === "newKey" ? t().newKeyDone : t().setupDone, cls: "ok" };
    await unlock();
  } catch (e) {
    if (/wrong password/.test(String(e.message))) fail(new Error(t().passwordWrong));
    else fail(e);
  }
}

function viewSetup() {
  const tx = t();
  const setup = store.get("gcr.setup");
  const steps = [h("h2", {}, tx.setupTitle), note(tx.setupIntro)];
  // 1. setup code
  const s1 = h("section", { class: setup ? "done" : "" }, h("h3", {}, tx.setupStep1));
  if (!setup) {
    const input = h("input", { type: "text", placeholder: "GCR1:…", autocapitalize: "off", spellcheck: "false" });
    s1.append(
      btn(tx.setupScan, async () => {
        try {
          const code = await app.native.scan("qr");
          if (code) setupCode(code);
        } catch (e) {
          fail(e);
        }
      }, "primary"),
      h("p", { class: "or" }, tx.setupType),
      h("div", { class: "row" }, input, btn(tx.confirm, () => setupCode(input.value)))
    );
  } else s1.append(h("p", { class: "ok" }, "✓"));
  steps.push(s1);
  // 2. the phone's key
  if (setup) {
    const s2 = h("section", { class: app.phone ? "done" : "" }, h("h3", {}, tx.setupStep2));
    if (!app.phone) s2.append(btn(tx.setupCreateKey, createKey, "primary"));
    else s2.append(h("p", { class: "ok" }, "✓"));
    steps.push(s2);
  }
  // 3. authorization by the owner
  if (setup && app.phone) {
    // In groups of four, easier to read aloud or compare; the owner tools accept it with or without spaces.
    const code = h("code", { class: "phone-code" }, app.phone.slice(2).match(/.{1,4}/g).join(" "));
    steps.push(
      h(
        "section",
        { class: app.authorized ? "done" : "" },
        h("h3", {}, tx.setupStep3),
        h("p", { class: "label" }, tx.phoneCode),
        code,
        btn(tx.copy, async (e) => {
          try {
            await navigator.clipboard.writeText(app.phone);
            e.target.textContent = tx.copied;
          } catch {
            /* select it instead */
          }
        }),
        h("p", { class: app.authorized ? "ok" : "note" }, app.authorized ? tx.authorized : tx.waitingAuth)
      )
    );
    pollAuthorized();
  }
  // 4. data password (typed by the owner)
  if (setup && app.phone && app.authorized) {
    const pw = h("input", { type: "password", autocomplete: "off", placeholder: tx.password });
    steps.push(h("section", {}, h("h3", {}, tx.setupStep4), pw, btn(tx.confirm, () => enterPassword(pw.value), "primary")));
  }
  return steps;
}

// ------------------------------------------------------------------------------------------------
// Unlock and home
// ------------------------------------------------------------------------------------------------

async function unlock() {
  try {
    const hex = await app.native.deviceKey.loadDataKey(prompt(t().unlockTitle));
    const dek = getBytes(hex);
    try {
      app.reg.keys = await openKeys(dek);
    } catch (e) {
      if (e.code !== "KEY_REPLACED") throw e;
      // The owner replaced the data key: the old one still opens what the phone keeps, then the owner
      // types the new password here.
      const old = await S.deriveKeys(dek, app.reg.address);
      dek.fill(0);
      app.phone = (await app.native.deviceKey.status()).address;
      await app.vault.unlock(old.cacheKey);
      return setView("newKey");
    }
    dek.fill(0);
    const st = await app.native.deviceKey.status();
    app.phone = st.address;
    await app.vault.unlock(app.reg.keys.cacheKey);
    if (await revoked()) return wipeRevoked();
    await loadLists();
    touch();
    const draft = app.vault.getItem("gcr.draft");
    if (draft) {
      app.vault.removeItem("gcr.draft");
      setView("doc", { doc: JSON.parse(draft), msg: { text: t().draftRestored, cls: "note" } });
    } else setView("home");
    flushOutbox();
  } catch (e) {
    fail(e);
  }
}

/**
 * The working keys from the phone's data key: the key epoch and ring read from the register, or, without
 * network, the last ones read (they are not secret: the ring is encrypted).
 */
async function openKeys(dek) {
  let epoch, ring;
  try {
    [epoch, ring] = await app.reg.contract.getDataBatch([S.KEY_EPOCH_DATA_KEY, S.KEY_RING_DATA_KEY]);
    store.set("gcr.keyring", { epoch, ring });
  } catch (e) {
    if (!L.isNetworkError(e)) throw e;
    const kept = store.get("gcr.keyring") || { epoch: "0x", ring: "0x" };
    [epoch, ring] = [kept.epoch, kept.ring];
  }
  return S.openKeys(dek, app.reg.address, epoch, ring);
}

function viewNewKey() {
  const tx = t();
  const pw = h("input", { type: "password", autocomplete: "off", placeholder: tx.password });
  return [h("h2", {}, tx.newKeyTitle), note(tx.newKeyIntro), pw, btn(tx.confirm, () => enterPassword(pw.value), "primary big")];
}

/** The owner's settings and lists; kept on the phone, encrypted, for when there is no network. */
async function loadLists() {
  try {
    app.settings = await app.reg.settings();
    app.cps = await app.reg.counterparties();
    app.vault.setItem("gcr.lists", JSON.stringify({ settings: app.settings, cps: app.cps }));
  } catch (e) {
    if (!L.isNetworkError(e)) throw e;
    const cached = JSON.parse(app.vault.getItem("gcr.lists") || '{"settings":null,"cps":[]}');
    app.settings = cached.settings;
    app.cps = cached.cps;
  }
}

// ------------------------------------------------------------------------------------------------
// Lock and revocation (review A09)
// ------------------------------------------------------------------------------------------------

let lastActive = Date.now();
let hiddenAt = null;
function touch() {
  lastActive = Date.now();
}

/** Forgets the keys and everything decrypted; a document half-made is kept, encrypted, for the next unlock. */
async function lock() {
  if (!app.reg || !app.reg.keys || app.sending || (app.doc && app.doc.busy)) return;
  if (app.doc && ["doc", "choose"].includes(app.view) && app.doc.cp) {
    app.vault.setItem("gcr.draft", JSON.stringify({ ...app.doc, busy: false }));
  }
  await app.vault.flush();
  app.vault.lock();
  app.reg.keys = null;
  Object.assign(app, { settings: null, cps: [], doc: null, check: null, result: null });
  setView("unlock", { msg: { text: t().locked, cls: "note" } });
}

function watchIdle() {
  for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, touch, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else {
      if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lock();
      hiddenAt = null;
      touch();
    }
  });
  setInterval(() => {
    if (Date.now() - lastActive > LOCK_AFTER_MS) lock();
  }, 30000);
}

/** True when the register says this phone is no longer authorized (unknown without network: false). */
async function revoked() {
  try {
    return !(await app.reg.isAuthorized(app.phone));
  } catch {
    return false;
  }
}

/**
 * A revoked phone erases its keys and everything it kept (review A09): it could no longer write, and now
 * it can no longer read. It can be set up again with the owner.
 */
async function wipeRevoked() {
  try {
    await app.native.deviceKey.remove();
  } finally {
    app.vault.wipe();
    store.del("gcr.setup");
    store.del("gcr.keyring");
    Object.assign(app, { reg: null, phone: null, settings: null, cps: [], doc: null, check: null, result: null, authorized: false });
    setView("setup", { msg: { text: t().revokedWiped, cls: "error" } });
  }
}

function viewUnlock() {
  return [h("h2", {}, t().unlockTitle), btn(t().unlockButton, unlock, "primary big")];
}

function viewHome() {
  const tx = t();
  const pending = app.outbox.pending().length;
  return [
    app.settings ? h("h2", {}, app.settings.company) : note(tx.settingsMissing, "warn"),
    h(
      "div",
      { class: "menu" },
      btn(tx.newDelivery, () => chooseCounterparty("delivery_note"), "primary big"),
      btn(tx.stockCount, () => chooseCounterparty("stock_count"), "big"),
      btn(tx.newRefill, () => chooseCounterparty("refill_note"), "big"),
      btn(tx.checkCylinder, () => setView("check", { check: null }), "big"),
      pending ? btn(tx.outbox(pending), () => setView("outbox"), "big warn") : null
    ),
    h("p", { class: "version" }, `GasTrace ${APP_VERSION}`),
  ];
}

// ------------------------------------------------------------------------------------------------
// Documents
// ------------------------------------------------------------------------------------------------

function chooseCounterparty(kind) {
  setView("choose", { doc: { kind, cp: null, lines: [], number: "", extra: ["", "", ""], confirmed: false, busy: false } });
}

function viewChoose() {
  const tx = t();
  const refill = app.doc.kind === "refill_note";
  const list = app.cps.filter((c) => !c.archived && (refill ? c.type === "refill" : app.doc.kind === "stock_count" ? true : c.type === "customer"));
  return [
    h("h2", {}, refill ? tx.chooseRefill : tx.chooseCustomer),
    list.length ? h("div", { class: "menu" }, list.map((c) => btn(c.name, () => setView("doc", { doc: { ...app.doc, cp: c } }), "big"))) : note(tx.noCounterparties, "warn"),
    btn(tx.back, () => setView("home")),
  ];
}

async function addCylinder(code) {
  const tx = t();
  const d = app.doc;
  if (!code) return;
  let cyl;
  try {
    app.msg = { text: tx.reading, cls: "note" };
    render();
    cyl = await app.reg.readCylinder(code);
  } catch (e) {
    return fail(/invalid/.test(String(e.message)) ? new Error(tx.serialInvalid) : e);
  }
  if (d.lines.some((l) => l.tokenId === cyl.tokenId)) {
    app.msg = { text: tx.duplicate, cls: "warn" };
    return render();
  }
  const p = L.propose(cyl, d.cp, d.kind, names(), types());
  d.lines.unshift({
    ...cyl,
    ...p,
    gas: cyl.info ? cyl.info.gas : "",
    capacityL: cyl.info && cyl.info.capacityL,
    // A new cylinder: who owns it (ours by default) and its periodic test, as stamped.
    owner: "supplier",
    testMode: "last",
    testMonth: "",
    tested: false,
  });
  d.confirmed = false;
  app.msg = null;
  render();
}

/**
 * Makes a refused document again (review A12): the same customer, number and cylinders, each read again
 * from the register and proposed again from its current state; the gas of new cylinders and the
 * conditions the driver chose are kept where the movement is the same. The driver checks and sends it.
 * Offered only when no part of the refused document was recorded.
 */
async function redo(item) {
  const tx = t();
  const dr = item.draft;
  const cp = app.cps.find((c) => c.id === dr.cpId && !c.archived);
  if (!cp) return fail(new Error(tx.noCounterparties));
  app.outbox.remove(item.id);
  app.doc = { kind: item.kind, cp, lines: [], number: dr.number || "", extra: dr.extra || ["", "", ""], confirmed: false, busy: false };
  setView("doc", { doc: app.doc });
  for (const old of [...dr.lines].reverse()) {
    await addCylinder(old.serial);
    const l = app.doc.lines.find((x) => x.serial === old.serial);
    if (!l) continue;
    if (!l.known) {
      l.gas = l.gas || old.gas;
      l.capacityL = l.capacityL || old.capacityL;
    }
    if (l.movement === old.movement) l.condition = old.condition;
    for (const k of ["owner", "testMode", "testMonth", "tested"]) if (old[k] !== undefined) l[k] = old[k];
  }
  app.msg = { text: tx.redone, cls: "warn" };
  render();
}

function recipients() {
  const d = app.doc;
  const preset = d.kind === "stock_count" ? [] : [...d.cp.emails, ...((app.settings && app.settings.emails) || [])];
  const extra = d.extra.map((e) => e.trim()).filter(Boolean);
  return [...new Set([...preset, ...extra].map((e) => e.toLowerCase()))];
}

async function sendDocument() {
  const tx = t();
  const d = app.doc;
  if (!d.lines.length) return;
  if (d.lines.some((l) => !l.known && !l.gas)) return fail(new Error(tx.needGas));
  if (d.lines.some((l) => (!l.known || l.tested) && l.testMode !== "unreadable" && !/^\d{4}-\d{2}$/.test(l.testMonth || ""))) return fail(new Error(tx.needTest));
  if (d.kind !== "stock_count" && !d.number.trim()) return fail(new Error(tx.needNumber));
  if (d.lines.some((l) => l.anomaly) && !d.confirmed) return fail(new Error(tx.anomaliesToConfirm));
  const to = recipients();
  for (const e of to) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(new Error(`${e}?`));
  d.busy = true;
  app.msg = { text: tx.sending, cls: "note" };
  render();
  try {
    const now = Math.floor(Date.now() / 1000);
    const lines = d.lines.map((l) => ({ ...l, capacityL: l.capacityL ? Number(l.capacityL) : undefined, ...lineTest(l) })).reverse();
    const built = await L.buildDocument({ registry: app.reg, operator: app.phone, counterparty: d.cp, kind: d.kind, number: d.number, lines, now });
    const mail = to.length
      ? L.buildMail({ lang: app.lang, company: (app.settings && app.settings.company) || "", counterparty: d.cp, kind: d.kind, number: built.number, lines, now, recipients: to })
      : null;
    const subtitle = `${d.kind === "stock_count" ? tx.stockCount : built.number} · ${d.cp.name}`;
    const item = await L.signDocument({
      registry: app.reg,
      operator: app.phone,
      built,
      mail,
      signDigests: (digests) => app.native.deviceKey.signDigests(digests, prompt(subtitle)),
      meta: {
        kind: d.kind,
        number: d.kind === "stock_count" ? "" : built.number,
        who: d.cp.name,
        // What the driver scanned and chose, to make the document again after a refusal (review A12).
        draft: {
          cpId: d.cp.id,
          number: d.number,
          extra: d.extra,
          lines: d.lines.map((l) => ({ serial: l.serial, gas: l.gas, capacityL: l.capacityL, movement: l.movement, condition: l.condition, owner: l.owner, testMode: l.testMode, testMonth: l.testMonth, tested: l.tested })),
        },
      },
    });
    app.outbox.add(item);
    setView("result", { result: item, doc: null });
    await sendOne(item);
  } catch (e) {
    d.busy = false;
    fail(e);
  }
}

async function sendOne(item) {
  app.sending++;
  try {
    await sendOneInner(item);
  } finally {
    app.sending--;
  }
  if (item.failed && item.failed.error === "NotAuthorized" && (await revoked())) await wipeRevoked();
}

async function sendOneInner(item) {
  await L.sendItem(item, {
    relayer: CONFIG.relayer,
    provider: app.provider,
    onUpdate: (i) => {
      if (i.done && i.mail !== "failed" && i.mail !== "unknown") app.outbox.remove(i.id);
      else app.outbox.update(i);
      if (app.result && app.result.id === i.id) app.result = i;
      render();
    },
  });
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !app.reg || !app.reg.keys) return;
  flushing = true;
  try {
    for (const item of app.outbox.pending()) if (!item.failed && !item.done) await sendOne(item);
  } finally {
    flushing = false;
  }
}

/**
 * The periodic test a line writes: a new cylinder's, or one back tested (`testChanged`); nothing for the
 * others (the last state's is kept). The other month is worked out with the gas's years.
 */
function lineTest(l) {
  if (l.known && !l.tested) return {};
  if (l.testMode === "unreadable") return { test: { unreadable: true }, testChanged: true };
  const years = S.testYearsFor({ gas: l.gas, testYears: l.info && l.info.testYears }, app.settings);
  return { test: S.completeTest({ [l.testMode]: l.testMonth }, years), testChanged: true };
}

/** Who may own a new cylinder in this document: us, the document's counterparty, a refill plant. */
function ownerOptions(d) {
  const tx = t();
  const out = [["supplier", tx.ownerOurs]];
  out.push([d.cp.id, d.cp.type === "refill" ? tx.ownerRefill(d.cp.name) : tx.ownerCustomer(d.cp.name)]);
  for (const c of app.cps) if (c.type === "refill" && !c.archived && c.id !== d.cp.id) out.push([c.id, tx.ownerRefill(c.name)]);
  return out;
}

/** The periodic test's fields: last test or expiry, the month, or unreadable. */
function testFields(l) {
  const tx = t();
  return h("div", { class: "row" },
    h("span", { class: "label" }, tx.testLabel),
    select([["last", tx.testLast], ["due", tx.testDue], ["unreadable", tx.testUnreadable]], l.testMode, (v) => {
      l.testMode = v;
      render();
    }),
    l.testMode === "unreadable" ? null : h("input", { type: "month", value: l.testMonth || "", oninput: (e) => (l.testMonth = e.target.value) }));
}

function lineCard(l, i) {
  const tx = t();
  const d = app.doc;
  const moves = L.MOVES_BY_KIND[d.kind];
  const gasOptions = [["", "—"], ...S.GASES.map((g) => [g, tx.gases[g]])];
  return h(
    "div",
    { class: "line" + (l.anomaly ? " anomaly" : "") },
    h("div", { class: "line-head" }, h("strong", {}, l.serial), btn("✕", () => {
      d.lines.splice(i, 1);
      render();
    }, "small")),
    l.known
      ? h("div", { class: "gas" }, tx.gases[l.gas])
      : h("div", { class: "row" }, h("span", { class: "label" }, tx.newCylinder), select(gasOptions, l.gas, (v) => {
            l.gas = v;
            render();
          }),
          h("input", { type: "number", inputmode: "decimal", placeholder: tx.capacity, value: l.capacityL || "", oninput: (e) => (l.capacityL = e.target.value) })),
    l.known ? null : h("div", { class: "row" }, h("span", { class: "label" }, tx.ownerLabel), select(ownerOptions(d), l.owner, (v) => {
      l.owner = v;
      render();
    })),
    l.known ? null : testFields(l),
    l.known && l.state && l.state.test && l.state.test.due && !l.tested ? h("p", { class: "note" }, tx.testDueOn(L.monthText(l.state.test.due))) : null,
    l.known && l.movement === "from_refill"
      ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: l.tested, onchange: (e) => {
          l.tested = e.target.checked;
          if (l.tested && !l.testMonth) l.testMonth = thisMonth();
          l.testMode = l.testMode === "unreadable" ? "last" : l.testMode || "last";
          render();
        } }), " ", tx.tested)
      : null,
    l.known && l.tested ? testFields(l) : null,
    h(
      "div",
      { class: "row" },
      moves.length > 1 ? select(moves.map((m) => [m, tx.movements[m]]), l.movement, (v) => {
        l.movement = v;
        render();
      }) : h("span", {}, tx.movements[l.movement]),
      select(S.CONDITIONS.map((c) => [c, tx.conditions[c]]), l.condition, (v) => {
        l.condition = v;
        render();
      })
    ),
    l.anomaly ? h("p", { class: "warn" }, "⚠ " + L.anomalyText(tx, l.anomaly)) : null,
    l.offline ? h("p", { class: "note" }, tx.offline) : null
  );
}

function viewDoc() {
  const tx = t();
  const d = app.doc;
  const manual = h("input", { type: "text", placeholder: tx.typeSerial, autocapitalize: "characters", spellcheck: "false" });
  const sum = L.summary(d.lines.filter((l) => l.gas));
  const anyAnomaly = d.lines.some((l) => l.anomaly);
  const preset = recipients().filter((e) => !d.extra.map((x) => x.trim().toLowerCase()).includes(e));
  return [
    h("h2", {}, `${{ delivery_note: tx.newDelivery, refill_note: tx.newRefill, stock_count: tx.stockCount }[d.kind]} · ${d.cp.name}`),
    h(
      "div",
      { class: "scanbar" },
      btn(tx.scan, async () => {
        try {
          addCylinder(await app.native.scan("any"));
        } catch (e) {
          fail(e);
        }
      }, "primary big"),
      h("div", { class: "row" }, manual, btn(tx.add, () => addCylinder(manual.value)))
    ),
    h("h3", {}, `${tx.lines} (${d.lines.length})`),
    d.lines.length ? d.lines.map(lineCard) : note(tx.noLines),
    d.lines.length
      ? h(
          "section",
          { class: "summary" },
          h("h3", {}, tx.summary),
          Object.entries(sum).map(([m, byGas]) =>
            h("p", {}, `${tx.movements[m]}: ${Object.entries(byGas).map(([g, n]) => `${n} ${tx.gases[g]}`).join(", ")}`)
          )
        )
      : null,
    d.kind !== "stock_count"
      ? h("label", {}, d.kind === "delivery_note" ? tx.ddtNumber : tx.docNumber,
          h("input", { type: "text", value: d.number, oninput: (e) => (d.number = e.target.value) }))
      : null,
    h(
      "section",
      { class: "recipients" },
      h("h3", {}, tx.recipients),
      preset.map((e) => h("span", { class: "chip" }, e)),
      d.extra.map((v, i) => h("input", { type: "email", value: v, placeholder: tx.extraEmail, oninput: (e) => (d.extra[i] = e.target.value) }))
    ),
    anyAnomaly
      ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.confirmed, onchange: (e) => (d.confirmed = e.target.checked) }), tx.confirmAnomalies)
      : null,
    h("div", { class: "actions" }, btn(tx.cancel, () => setView("home")), d.lines.length ? btn(tx.send, sendDocument, "primary big") : null),
  ];
}

function itemStatus(item) {
  const tx = t();
  if (item.failed) return { text: tx.failedReason(L.errorText(app.lang, item.failed)), cls: "error" };
  if (item.done) {
    const mail = { sent: " " + tx.mailSent, failed: " " + tx.mailFailed, unknown: " " + tx.mailUnknown }[item.mail] || "";
    return { text: tx.sentOk + mail, cls: item.mail === "failed" || item.mail === "unknown" ? "warn" : "ok" };
  }
  if (item.waiting) return { text: tx.waitingRetry, cls: "warn" };
  if (item.offline) return { text: tx.queued, cls: "warn" };
  return { text: tx.sending, cls: "note" };
}

function mailtoLink(item) {
  const last = item.parts[item.parts.length - 1].body;
  if (!last.mail) return null;
  const m = S.renderMail(last.mail); // the same template the relayer uses
  return `mailto:${m.to.join(",")}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.text)}`;
}

function viewResult() {
  const tx = t();
  const item = app.result;
  const st = itemStatus(item);
  return [
    h("h2", {}, `${item.number || tx.stockCount} · ${item.who}`),
    h("p", { class: st.cls + " big-status" }, st.text),
    item.done && (item.mail === "failed" || item.mail === "unknown") ? h("a", { class: "button", href: mailtoLink(item) }, tx.sendFromPhone) : null,
    item.failed && item.draft && !item.parts.some((p) => p.state === "confirmed") ? btn(tx.redo, () => redo(item), "big") : null,
    btn(tx.close, () => setView("home"), "primary big"),
  ];
}

/**
 * Cancels a waiting document (review G-07): its parts not sent yet are cancelled on the register (one
 * fingerprint), so that nobody can record them later; then it leaves the list. Needs the network. A
 * document refused or already recorded only leaves the list.
 */
async function cancelDocument(it) {
  const tx = t();
  // A document partly recorded: its recorded part stays (review A12).
  if (it.parts.some((p) => p.state === "confirmed" || p.state === "sent") && !window.confirm(tx.discardPartial)) return;
  if (!it.failed && it.parts.some((p) => p.state === "new" && !p.hash)) {
    if (!window.confirm(tx.cancelConfirm)) return;
    app.msg = { text: tx.cancelling, cls: "note" };
    render();
    try {
      await L.cancelItem(it, {
        registry: app.reg,
        operator: app.phone,
        relayer: CONFIG.relayer,
        signDigests: (digests) => app.native.deviceKey.signDigests(digests, prompt(tx.cancelTitle)),
      });
    } catch (e) {
      return fail(L.isNetworkError(e) || /fetch/i.test(String(e.message)) ? new Error(tx.cancelNeedsNetwork) : e);
    }
    app.msg = { text: tx.cancelled, cls: "ok" };
  }
  app.outbox.remove(it.id);
  render();
}

function viewOutbox() {
  const tx = t();
  const items = app.outbox.pending();
  return [
    h("h2", {}, tx.outboxTitle),
    items.length
      ? items.map((it) => {
          const st = itemStatus(it);
          return h(
            "div",
            { class: "line" },
            h("strong", {}, `${it.number || tx.stockCount} · ${it.who}`),
            h("p", { class: "note" }, new Date(it.createdAt).toLocaleString(app.lang === "en" ? "en-GB" : "it-IT")),
            h("p", { class: st.cls }, st.text),
            h("div", { class: "row" },
              !it.failed && !it.done ? btn(tx.sendNow, () => sendOne(it)) : null,
              it.done && (it.mail === "failed" || it.mail === "unknown") ? h("a", { class: "button", href: mailtoLink(it) }, tx.sendFromPhone) : null,
              it.failed && it.draft && !it.parts.some((p) => p.state === "confirmed") ? btn(tx.redo, () => redo(it), "primary") : null,
              it.done
                ? btn(tx.mailHandled, () => {
                    app.outbox.remove(it.id);
                    render();
                  }, "small")
                : btn(tx.discard, () => cancelDocument(it), "small"))
          );
        })
      : note(tx.outboxEmpty),
    btn(tx.back, () => setView("home")),
  ];
}

// ------------------------------------------------------------------------------------------------
// Check a cylinder
// ------------------------------------------------------------------------------------------------

async function checkCode(code) {
  if (!code) return;
  try {
    app.check = await app.reg.readCylinder(code);
    app.msg = null;
    render();
  } catch (e) {
    fail(/invalid/.test(String(e.message)) ? new Error(t().serialInvalid) : e);
  }
}

function locationText(st) {
  const tx = t();
  const n = names();
  if (st.location.type === "depot") return tx.locations.depot;
  return tx.locations[st.location.type](n[st.location.id] || "?");
}

function testText(test) {
  const tx = t();
  if (!test) return `${tx.testLabel}: —`;
  if (test.unreadable) return `${tx.testLabel}: ${tx.testUnreadable}`;
  const status = S.testStatus(test, Math.floor(Date.now() / 1000));
  return `${tx.testLabel}: ${tx.testDueOn(L.monthText(test.due))}${status === "expired" ? " ⚠ " + tx.testExpired : status === "soon" ? " · " + tx.testSoon : ""}`;
}

function viewCheck() {
  const tx = t();
  const c = app.check;
  const manual = h("input", { type: "text", placeholder: tx.typeSerial, autocapitalize: "characters", spellcheck: "false" });
  return [
    h("h2", {}, tx.checkTitle),
    btn(tx.scan, async () => {
      try {
        checkCode(await app.native.scan("any"));
      } catch (e) {
        fail(e);
      }
    }, "primary big"),
    h("div", { class: "row" }, manual, btn(tx.lookUp, () => checkCode(manual.value))),
    c
      ? h(
          "section",
          { class: "line" },
          h("strong", {}, c.serial),
          c.known
            ? [
                h("p", {}, `${tx.gas}: ${tx.gases[c.info.gas]}${c.info.capacityL ? ` · ${c.info.capacityL} l` : ""}`),
                h("p", {}, `${tx.ownerLabel}: ${c.info.owner === "supplier" ? tx.ownerOurs : names()[c.info.owner] || "?"}`),
                c.state ? h("p", {}, `${locationText(c.state)} · ${tx.conditions[c.state.condition]}`) : null,
                c.state ? h("p", {}, testText(c.state.test)) : null,
                c.state
                  ? h("p", { class: "note" }, `${tx.lastMovement}: ${tx.movements[c.state.movement]} · ${new Date(c.state.at * 1000).toLocaleString(app.lang === "en" ? "en-GB" : "it-IT")}`)
                  : null,
              ]
            : h("p", { class: "warn" }, tx.unknownCylinder),
          c.offline ? h("p", { class: "note" }, tx.offline) : null
        )
      : null,
    btn(tx.back, () => setView("home")),
  ];
}

// ------------------------------------------------------------------------------------------------
// Render
// ------------------------------------------------------------------------------------------------

function render() {
  const tx = t();
  document.documentElement.lang = app.lang;
  const root = document.getElementById("app");
  const scroll = window.scrollY;
  const views = {
    loading: () => [note(tx.loading)],
    error: () => [],
    setup: viewSetup,
    unlock: viewUnlock,
    home: viewHome,
    choose: viewChoose,
    doc: viewDoc,
    result: viewResult,
    outbox: viewOutbox,
    check: viewCheck,
    newKey: viewNewKey,
  };
  const parts = [
    h(
      "header",
      {},
      h("span", { class: "brand" }, tx.appName),
      btn(tx.lang, () => {
        app.lang = app.lang === "it" ? "en" : "it";
        store.set("gcr.lang", app.lang);
        render();
      }, "lang")
    ),
    app.online ? null : h("p", { class: "banner" }, tx.offline),
    app.update
      ? h("div", { class: "update" }, h("span", {}, tx.updateAvailable(app.update.version)),
          h("a", { class: "button primary", href: app.update.url, target: "_blank", rel: "noopener" }, tx.updateDownload))
      : null,
    app.msg ? h("p", { class: "msg " + app.msg.cls }, app.msg.text) : null,
    h("main", {}, (views[app.view] || views.loading)()),
  ];
  root.replaceChildren(...parts.filter(Boolean));
  if (app.view === "doc") window.scrollTo(0, scroll);
}

window.addEventListener("DOMContentLoaded", () => {
  render();
  start().catch(fail);
});
