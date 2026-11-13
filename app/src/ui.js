"use strict";
// The app's interface: one page, Italian and English, plain words only.

const { JsonRpcProvider, hexlify, getBytes } = require("ethers");
const S = require("../../shared");
const L = require("./logic");
const { T } = require("./i18n");
const { loadNative } = require("./native");
const CONFIG = require("../app-config.json");

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
  outbox: new L.Outbox(localStorage),
  online: navigator.onLine !== false,
};
const t = () => T[app.lang];
const names = () => Object.fromEntries(app.cps.map((c) => [c.id, c.name]));

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
  });
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

// ------------------------------------------------------------------------------------------------
// Setup (once, with the owner)
// ------------------------------------------------------------------------------------------------

async function setupCode(code) {
  try {
    const s = S.parseSetupCode(code);
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
    const dek = await S.unwrapWithPassword(await app.reg.passwordWrap(), password, app.reg.address);
    await app.native.deviceKey.storeDataKey(hexlify(dek), prompt(t().setupStep4));
    dek.fill(0);
    app.msg = { text: t().setupDone, cls: "ok" };
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
    app.reg.keys = await S.deriveKeys(dek, app.reg.address);
    dek.fill(0);
    const st = await app.native.deviceKey.status();
    app.phone = st.address;
    await loadLists();
    setView("home");
    flushOutbox();
  } catch (e) {
    fail(e);
  }
}

/** The owner's settings and lists; kept on the phone for when there is no network. */
async function loadLists() {
  try {
    app.settings = await app.reg.settings();
    app.cps = await app.reg.counterparties();
    store.set("gcr.lists", { settings: app.settings, cps: app.cps });
  } catch (e) {
    if (!L.isNetworkError(e)) throw e;
    const cached = store.get("gcr.lists", { settings: null, cps: [] });
    app.settings = cached.settings;
    app.cps = cached.cps;
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
  const list = app.cps.filter((c) => (refill ? c.type === "refill" : app.doc.kind === "stock_count" ? true : c.type === "customer"));
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
  const p = L.propose(cyl, d.cp, d.kind, names());
  d.lines.unshift({ ...cyl, ...p, gas: cyl.info ? cyl.info.gas : "", capacityL: cyl.info && cyl.info.capacityL });
  d.confirmed = false;
  app.msg = null;
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
  if (d.kind !== "stock_count" && !d.number.trim()) return fail(new Error(tx.needNumber));
  if (d.lines.some((l) => l.anomaly) && !d.confirmed) return fail(new Error(tx.anomaliesToConfirm));
  const to = recipients();
  for (const e of to) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return fail(new Error(`${e}?`));
  d.busy = true;
  app.msg = { text: tx.sending, cls: "note" };
  render();
  try {
    const now = Math.floor(Date.now() / 1000);
    const lines = d.lines.map((l) => ({ ...l, capacityL: l.capacityL ? Number(l.capacityL) : undefined })).reverse();
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
      meta: { kind: d.kind, number: d.kind === "stock_count" ? "" : built.number, who: d.cp.name },
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
    for (const item of app.outbox.pending()) if (!item.failed) await sendOne(item);
  } finally {
    flushing = false;
  }
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
  if (item.offline) return { text: tx.queued, cls: "warn" };
  return { text: tx.sending, cls: "note" };
}

function mailtoLink(item) {
  const last = item.parts[item.parts.length - 1].body;
  if (!last.mail) return null;
  const m = last.mail;
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
    btn(tx.close, () => setView("home"), "primary big"),
  ];
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
              !it.failed ? btn(tx.sendNow, () => sendOne(it)) : null,
              it.done && (it.mail === "failed" || it.mail === "unknown") ? h("a", { class: "button", href: mailtoLink(it) }, tx.sendFromPhone) : null,
              btn(tx.discard, () => {
                app.outbox.remove(it.id);
                render();
              }, "small"))
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
                c.state ? h("p", {}, `${locationText(c.state)} · ${tx.conditions[c.state.condition]}`) : null,
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
