"use strict";
// GasTrace admin page: the register's owner signs in with the ChainIntegrate Account extension (EIP-6963),
// opens the data with the data password (kept in this page's memory only), and manages customers, refill
// plants, drivers' phones and settings. Every change is a request the extension shows and the owner confirms;
// the relayer sends it and pays its cost. Plain words only.

const { JsonRpcProvider, Contract, getAddress, isAddress } = require("ethers");
const qrcode = require("qrcode-generator");
const S = require("../../shared");
const O = require("../../scripts/lib/owner");
const D = require("./data");
const E = require("./export");
const { T } = require("./i18n");
const CONFIG = require("../admin-config.json");

const EXTENSION_RDNS = "it.chainintegrate.account";
const INSTALL_URL = "https://account.chainintegrate.it/";

const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

const st = {
  lang: new URLSearchParams(location.search).get("lang") || store.get("gastrace.lang", (navigator.language || "it").startsWith("en") ? "en" : "it"),
  view: "connect",
  tab: "overview",
  wallet: null, // the extension's EIP-1193 provider
  account: null,
  provider: new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true }),
  registries: [],
  reg: null, // { address, name, block }
  ctx: null, // owner tools context
  keys: null,
  dek: null,
  data: null, // { settings, cps, phones, cyls, docs, ov }
  msg: null,
  busy: null,
  search: "",
  editing: null, // counterparty being edited
  history: null, // { serial, entries }
  recovery: false,
};
const t = () => T[st.lang] || T.it;

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // through the CSSOM: the page's policy blocks style attributes
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const btn = (label, onclick, cls = "") => h("button", { type: "button", class: cls, onclick }, label);
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString(st.lang === "en" ? "en-GB" : "it-IT", { dateStyle: "short", timeStyle: "short" });
const names = () => Object.fromEntries((st.data ? st.data.cps : []).map((c) => [c.id, c.name]));
const emailList = (s) => String(s || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const phoneCodeText = (a) => a.slice(2).match(/.{1,4}/g).join(" ");
/** "DDT 2026/118", never "DDT DDT 2026/118" when the driver typed the word too. */
const docLabel = (doc) => `${t().docKinds[doc.kind]}${doc.number ? " " + String(doc.number).replace(/^DDT\s*/i, "") : ""}`;

function locationText(state) {
  if (!state) return "—";
  if (state.lifecycle === "retired") return t().retired;
  if (state.location.type === "depot") return t().locations.depot;
  return t().locations[state.location.type](names()[state.location.id] || "?");
}

function say(text, cls = "ok") {
  st.msg = { text, cls };
  render();
}

function failText(e) {
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return t().refused;
  return t().failed((e && (e.shortMessage || e.message)) || "?");
}

// ------------------------------------------------------------------------------------------------
// The extension
// ------------------------------------------------------------------------------------------------

/** The ChainIntegrate Account extension's provider, found through EIP-6963 (null after `ms`). */
function findExtension(ms = 1200) {
  return new Promise((resolve) => {
    let found = null;
    const onAnnounce = (ev) => {
      const d = ev.detail;
      if (d && d.info && d.info.rdns === EXTENSION_RDNS && d.provider) found = d.provider;
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const started = Date.now();
    const tick = () => {
      if (found || Date.now() - started > ms) {
        window.removeEventListener("eip6963:announceProvider", onAnnounce);
        resolve(found);
      } else setTimeout(tick, 100);
    };
    tick();
  });
}

/** The owner as the owner tools expect it: an address and an EIP-712 signer, here the extension. */
function extensionOwner(wallet, account) {
  return {
    address: account,
    async signTypedData(domain, types, value) {
      const primaryType = Object.keys(types)[0];
      const typed = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          [primaryType]: types[primaryType],
        },
        primaryType,
        domain: { ...domain, chainId: Number(domain.chainId) },
        message: JSON.parse(JSON.stringify(value, (k, v) => (typeof v === "bigint" ? v.toString() : v))),
      };
      st.busy = t().confirmInExtension;
      render();
      try {
        return await wallet.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] });
      } finally {
        st.busy = t().recording;
        render();
      }
    },
  };
}

async function connect() {
  st.msg = null;
  const wallet = await findExtension();
  if (!wallet) {
    st.view = "noExtension";
    return render();
  }
  st.busy = t().connecting;
  render();
  try {
    const [account] = await wallet.request({ method: "eth_requestAccounts" });
    const chainId = Number(await wallet.request({ method: "eth_chainId" }));
    if (chainId !== Number(CONFIG.chainId)) throw Object.assign(new Error(t().wrongNetwork), { plain: true });
    st.wallet = wallet;
    st.account = getAddress(account);
    st.registries = await D.registriesOf(st.provider, CONFIG.factory, st.account, CONFIG.factoryBlock || 0);
    st.busy = null;
    if (!st.registries.length) {
      st.view = "noRegistry";
    } else if (st.registries.length === 1) {
      chooseRegistry(st.registries[0]);
      return;
    } else st.view = "choose";
    render();
  } catch (e) {
    st.busy = null;
    st.msg = { text: e.plain ? e.message : failText(e), cls: "err" };
    render();
  }
}

async function chooseRegistry(r) {
  st.reg = r;
  st.ctx = await O.context({
    provider: st.provider,
    registry: r.address,
    owner: extensionOwner(st.wallet, st.account),
    submit: O.relayerSubmitter(CONFIG.relayer, st.provider),
    fromBlock: r.block,
  });
  st.view = "unlock";
  render();
}

function signOut() {
  if (st.dek) st.dek.fill(0);
  Object.assign(st, { view: "connect", wallet: null, account: null, reg: null, ctx: null, keys: null, dek: null, data: null, msg: null, history: null, editing: null });
  render();
}

// ------------------------------------------------------------------------------------------------
// Data
// ------------------------------------------------------------------------------------------------

async function unlock(password) {
  st.busy = t().opening;
  st.msg = null;
  render();
  try {
    const { dek, keys } = await O.unlockWithPassword(st.ctx, password);
    st.dek = dek;
    st.keys = keys;
    await loadAll();
    st.view = "main";
  } catch (e) {
    st.msg = { text: /wrong password/.test(String(e.message)) ? t().wrongPassword : failText(e), cls: "err" };
  }
  st.busy = null;
  render();
}

async function recover(code, p1, p2) {
  if (p1 !== p2) return say(t().mismatch, "err");
  const c = S.checkPassword(p1);
  if (!c.ok) return say(t().weak[c.reason], "err");
  st.busy = t().opening;
  render();
  try {
    const { dek, keys } = await O.unlockWithRecoveryCode(st.ctx, code);
    await O.changePassword(st.ctx, dek, p1);
    st.dek = dek;
    st.keys = keys;
    await loadAll();
    st.view = "main";
    st.recovery = false;
    st.msg = { text: t().passwordChanged, cls: "ok" };
  } catch (e) {
    st.msg = { text: /recovery code/.test(String(e.message)) ? t().wrongRecovery : failText(e), cls: "err" };
  }
  st.busy = null;
  render();
}

async function loadAll() {
  const reg = new Contract(st.reg.address, D.REGISTRY_ABI, st.provider);
  const [settings, cps, phones, cyls, docs] = await Promise.all([
    O.readSettings(st.ctx, st.keys),
    O.listCounterparties(st.ctx, st.keys),
    O.listOperators(st.ctx),
    D.cylinders(reg, st.keys, st.reg.block, st.provider),
    D.documents(reg, st.keys, st.reg.block, st.provider),
  ]);
  st.data = { settings, cps, phones, cyls, docs, ov: D.overview(cyls) };
}

/**
 * Runs a change: the extension asks the owner to confirm, the relayer records it, then the data is read
 * again. `fn` may return its own success message (shown instead of "Done.").
 */
async function change(fn) {
  st.msg = null;
  st.busy = t().confirmInExtension;
  render();
  try {
    const said = await fn();
    st.busy = t().loading;
    render();
    await loadAll();
    st.msg = { text: typeof said === "string" ? said : t().done, cls: "ok" };
  } catch (e) {
    st.msg = { text: e.plain ? e.message : failText(e), cls: "err" };
  }
  st.busy = null;
  st.editing = null;
  render();
}

async function showHistory(c) {
  st.busy = t().loading;
  render();
  try {
    const reg = new Contract(st.reg.address, D.REGISTRY_ABI, st.provider);
    st.history = { cyl: c, entries: await D.history(reg, st.keys, c.tokenId, st.reg.block, st.provider, st.data.docs) };
  } catch (e) {
    st.msg = { text: failText(e), cls: "err" };
  }
  st.busy = null;
  render();
}

// ------------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------------

function header() {
  const tx = t();
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, h("div", { class: "mark", "aria-hidden": "true" }, cylinderIcon()), h("div", {}, h("div", { class: "name" }, tx.title), h("div", { class: "tagline" }, tx.tagline))),
    h(
      "div",
      { class: "top-actions" },
      st.account ? h("span", { class: "who", title: st.account }, st.data && st.data.settings ? st.data.settings.company : phoneCodeText(st.account).slice(0, 9) + "…") : null,
      st.account ? btn(tx.signOut, signOut, "ghost") : null,
      btn(tx.lang, () => {
        st.lang = st.lang === "it" ? "en" : "it";
        store.set("gastrace.lang", st.lang);
        render();
      }, "ghost")
    )
  );
}

function cylinderIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 108 108");
  svg.innerHTML =
    '<rect x="47" y="22" width="14" height="8" rx="2" fill="currentColor" opacity=".85"/><rect x="44" y="28" width="20" height="5" rx="2" fill="currentColor" opacity=".85"/>' +
    '<path d="M41 42 Q41 33 54 33 Q67 33 67 42 L67 82 Q67 86 63 86 L45 86 Q41 86 41 82 Z" fill="var(--brand)"/><rect x="41" y="44" width="26" height="6" fill="#fff" opacity=".9"/>';
  return svg;
}

function viewConnect() {
  const tx = t();
  return h(
    "section",
    { class: "hero" },
    h("h1", {}, tx.connectTitle),
    h("p", {}, tx.connectIntro),
    btn(tx.connectButton, connect, "primary big")
  );
}

function viewNoExtension() {
  const tx = t();
  return h(
    "section",
    { class: "hero" },
    h("h1", {}, tx.connectTitle),
    h("p", { class: "warn" }, tx.noExtension),
    h("a", { class: "button primary big", href: INSTALL_URL, target: "_blank", rel: "noopener" }, tx.installExtension),
    btn(tx.connectButton, connect, "ghost")
  );
}

function viewChoose() {
  const tx = t();
  return h("section", { class: "panel" }, h("h2", {}, tx.chooseRegistry), st.registries.map((r) => btn(r.name, () => chooseRegistry(r), "big")));
}

function viewNoRegistry() {
  return h("section", { class: "panel" }, h("p", {}, t().noRegistry));
}

function viewUnlock() {
  const tx = t();
  if (st.recovery) {
    const code = h("textarea", { rows: "3", autocomplete: "off", spellcheck: "false" });
    const p1 = h("input", { type: "password", autocomplete: "new-password" });
    const p2 = h("input", { type: "password", autocomplete: "new-password" });
    return h(
      "section",
      { class: "panel narrow" },
      h("h2", {}, tx.recoveryTitle),
      h("p", { class: "dim" }, tx.recoveryIntro),
      h("label", {}, tx.recoveryCode, code),
      h("label", {}, tx.newPassword, p1),
      h("label", {}, tx.newPasswordAgain, p2),
      h("div", { class: "row" }, btn(tx.cancel, () => { st.recovery = false; render(); }, "ghost"), btn(tx.save, () => recover(code.value, p1.value, p2.value), "primary"))
    );
  }
  const pw = h("input", { type: "password", autocomplete: "current-password", onkeydown: (e) => e.key === "Enter" && unlock(pw.value) });
  return h(
    "section",
    { class: "panel narrow" },
    h("h2", {}, tx.unlockTitle),
    h("p", { class: "dim" }, tx.unlockIntro),
    h("label", {}, tx.password, pw),
    btn(tx.open, () => unlock(pw.value), "primary big"),
    h("a", { href: "#", class: "link", onclick: (e) => { e.preventDefault(); st.recovery = true; st.msg = null; render(); } }, tx.lostPassword)
  );
}

function tabs() {
  const tx = t();
  return h(
    "nav",
    { class: "tabs" },
    Object.keys(tx.tabs).map((k) => h("button", { type: "button", class: st.tab === k ? "tab on" : "tab", onclick: () => { st.tab = k; st.history = null; st.msg = null; render(); } }, tx.tabs[k])),
    btn("↻ " + tx.refresh, () => change(async () => {}), "tab ghost refresh")
  );
}

function stat(label, n, cls = "") {
  return h("div", { class: "stat " + cls }, h("div", { class: "n" }, String(n)), h("div", { class: "l" }, label));
}

function docRow(d) {
  const tx = t();
  const doc = d.document;
  if (!doc) return h("tr", {}, h("td", { colspan: "4", class: "dim" }, d.unreadable ? tx.unreadable : "…"));
  const counts = {};
  for (const l of doc.lines) counts[l.movement] = (counts[l.movement] || 0) + 1;
  return h(
    "tr",
    {},
    h("td", {}, fmtDate(doc.date)),
    h("td", {}, docLabel(doc), d.corrects !== "0x" + "0".repeat(64) ? h("div", { class: "dim small" }, tx.corrects) : null),
    h("td", {}, names()[doc.counterparty] || "—"),
    h("td", {}, Object.entries(counts).map(([m, n]) => h("span", { class: "chip" }, `${tx.movements[m]} ${n}`)))
  );
}

function viewOverview() {
  const tx = t();
  const ov = st.data.ov;
  return [
    h(
      "div",
      { class: "stats" },
      stat(tx.total, ov.total, "main"),
      stat(tx.atDepot, ov.depot),
      stat(tx.atCustomers, ov.customer),
      stat(tx.atRefill, ov.refill),
      stat(tx.defective, ov.defective, ov.defective ? "warn" : "")
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, tx.byGas),
      Object.keys(ov.byGas).length
        ? h("div", { class: "bars" }, Object.entries(ov.byGas).sort((a, b) => b[1] - a[1]).map(([g, n]) =>
            h("div", { class: "bar" }, h("span", { class: "bl" }, tx.gases[g]), h("span", { class: "bt" }, h("span", { class: "bf", style: `width:${Math.max(4, (100 * n) / ov.total)}%` })), h("span", { class: "bn" }, String(n)))
          ))
        : h("p", { class: "dim" }, tx.noCylinders)
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, tx.lastDocuments),
      st.data.docs.length
        ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, tx.date), h("th", {}, tx.number), h("th", {}, tx.counterparty), h("th", {}, tx.contents))), h("tbody", {}, st.data.docs.slice(0, 5).map(docRow)))
        : h("p", { class: "dim" }, tx.noDocuments)
    ),
  ];
}

function viewCylinders() {
  const tx = t();
  if (st.history) {
    const c = st.history.cyl;
    return h(
      "section",
      { class: "panel" },
      h("div", { class: "row between" }, h("h2", {}, tx.historyTitle(c.info.serial)), btn("←", () => { st.history = null; render(); }, "ghost small")),
      h("p", {}, `${tx.gas}: ${tx.gases[c.info.gas]}${c.info.capacityL ? ` · ${tx.capacity} ${c.info.capacityL} l` : ""} · ${tx.registeredOn} ${fmtDate(c.info.registeredAt)} · ${tx.ownedBy} ${c.info.owner === "supplier" ? tx.supplier : names()[c.info.owner] || "?"}`),
      h(
        "ol",
        { class: "timeline" },
        st.history.entries.map((e) =>
          h(
            "li",
            {},
            h("div", { class: "when" }, fmtDate(e.state.at)),
            h("div", {}, h("b", {}, tx.movements[e.state.movement]), ` · ${locationText(e.state)} · ${tx.conditions[e.state.condition]}`),
            e.document ? h("div", { class: "dim small" }, docLabel(e.document)) : null
          )
        )
      )
    );
  }
  const q = st.search.trim().toLowerCase();
  const list = st.data.cyls.filter((c) => !q || [c.info.serial, tx.gases[c.info.gas], locationText(c.state)].join(" ").toLowerCase().includes(q));
  const search = h("input", { type: "search", placeholder: tx.search, value: st.search, oninput: (e) => {
    st.search = e.target.value;
    render();
    const el = document.querySelector("input[type=search]");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  } });
  return h(
    "section",
    { class: "panel" },
    search,
    st.data.cyls.length
      ? h(
          "table",
          { class: "click" },
          h("thead", {}, h("tr", {}, h("th", {}, tx.serial), h("th", {}, tx.gas), h("th", {}, tx.where), h("th", {}, tx.condition), h("th", {}, tx.lastMovement))),
          h(
            "tbody",
            {},
            list.map((c) =>
              h(
                "tr",
                { onclick: () => showHistory(c) },
                h("td", { class: "mono" }, c.info.serial),
                h("td", {}, tx.gases[c.info.gas]),
                h("td", {}, locationText(c.state)),
                h("td", {}, c.state ? h("span", { class: "chip " + c.state.condition }, tx.conditions[c.state.condition]) : "—"),
                h("td", { class: "dim" }, c.state ? `${tx.movements[c.state.movement]} · ${fmtDate(c.state.at)}` : "—")
              )
            )
          )
        )
      : h("p", { class: "dim" }, tx.noCylinders)
  );
}

function viewDocuments() {
  const tx = t();
  return h(
    "section",
    { class: "panel" },
    st.data.docs.length
      ? st.data.docs.map((d) => {
          const doc = d.document;
          if (!doc) return h("p", { class: "dim" }, tx.unreadable);
          return h(
            "details",
            { class: "doc" },
            h("summary", {}, h("span", { class: "dim" }, fmtDate(doc.date)), " ", h("b", {}, docLabel(doc)), " · ", names()[doc.counterparty] || "—", " ", h("span", { class: "chip" }, String(doc.lines.length))),
            h(
              "table",
              {},
              h("tbody", {}, doc.lines.map((l) => h("tr", {}, h("td", { class: "mono" }, l.serial), h("td", {}, tx.gases[l.gas]), h("td", {}, tx.movements[l.movement]), h("td", {}, tx.conditions[l.condition]), h("td", { class: "warn small" }, l.anomaly || ""))))
            )
          );
        })
      : h("p", { class: "dim" }, tx.noDocuments)
  );
}

function cpForm(type, cp) {
  const tx = t();
  const name = h("input", { type: "text", value: cp ? cp.name : "" });
  const emails = h("input", { type: "text", value: cp ? cp.emails.join(", ") : "" });
  const save = () =>
    change(async () => {
      const fields = { type, name: name.value, emails: emailList(emails.value) };
      if (cp) await O.updateCounterparty(st.ctx, st.keys, cp.id, fields);
      else await O.addCounterparty(st.ctx, st.keys, fields);
    });
  return h(
    "div",
    { class: "form" },
    h("label", {}, tx.name, name),
    h("label", {}, tx.emails, emails, h("span", { class: "hint" }, tx.emailsHint)),
    h("div", { class: "row" }, btn(tx.cancel, () => { st.editing = null; render(); }, "ghost"), btn(tx.save, save, "primary"))
  );
}

function cpList(type, title, empty, addLabel) {
  const tx = t();
  const list = st.data.cps.filter((c) => c.type === type);
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "row between" }, h("h2", {}, title), st.editing ? null : btn("+ " + addLabel, () => { st.editing = { type, cp: null }; render(); }, "ghost small")),
    st.editing && st.editing.type === type && !st.editing.cp ? cpForm(type, null) : null,
    list.length
      ? list.map((c) =>
          st.editing && st.editing.cp && st.editing.cp.id === c.id
            ? cpForm(type, c)
            : h(
                "div",
                { class: "item" },
                h("div", {}, h("b", {}, c.name), h("div", { class: "dim small" }, c.emails.join(", ") || "—")),
                h("div", { class: "row" }, btn(tx.edit, () => { st.editing = { type, cp: c }; render(); }, "ghost small"), btn(tx.remove, () => confirm(tx.confirmRemove(c.name)) && change(() => O.removeCounterparty(st.ctx, c.id)), "ghost small danger"))
              )
        )
      : h("p", { class: "dim" }, empty)
  );
}

function viewCounterparties() {
  const tx = t();
  return [cpList("customer", tx.customers, tx.noCustomers, tx.addCustomer), cpList("refill", tx.refillPlants, tx.noRefill, tx.addRefill)];
}

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const wrap = h("div", { class: "qr" });
  wrap.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  return wrap;
}

function viewPhones() {
  const tx = t();
  const code = h("input", { type: "text", placeholder: "d59F 2E8B …", autocomplete: "off", spellcheck: "false" });
  const add = () => {
    const raw = code.value.replace(/\s+/g, "");
    const addr = raw.startsWith("0x") ? raw : "0x" + raw;
    if (!isAddress(addr.toLowerCase())) return say(tx.badPhoneCode, "err");
    change(() => O.setOperator(st.ctx, getAddress(addr.toLowerCase()), true));
  };
  return [
    h(
      "section",
      { class: "panel" },
      h("h2", {}, tx.tabs.phones),
      h("p", { class: "dim" }, tx.phonesIntro),
      st.data.phones.length
        ? st.data.phones.map((p) => h("div", { class: "item" }, h("code", { class: "phone" }, phoneCodeText(p)), btn(tx.revoke, () => confirm(tx.confirmRevoke) && change(() => O.setOperator(st.ctx, p, false)), "ghost small danger")))
        : h("p", { class: "dim" }, tx.noPhones),
      h("h3", {}, tx.addPhone),
      h("label", {}, tx.phoneCode, code, h("span", { class: "hint" }, tx.phoneCodeHint)),
      btn(tx.authorize, add, "primary")
    ),
    h("section", { class: "panel" }, h("h2", {}, tx.setupTitle), h("div", { class: "setup" }, qrSvg(S.setupCode(st.reg.address, st.reg.block)), h("p", { class: "dim" }, tx.setupIntro))),
  ];
}

function viewSettings() {
  const tx = t();
  const s = st.data.settings || { company: "", emails: [] };
  const company = h("input", { type: "text", value: s.company });
  const emails = h("input", { type: "text", value: s.emails.join(", ") });
  const p1 = h("input", { type: "password", autocomplete: "new-password" });
  const p2 = h("input", { type: "password", autocomplete: "new-password" });
  const changePw = () => {
    if (p1.value !== p2.value) return say(tx.mismatch, "err");
    const c = S.checkPassword(p1.value);
    if (!c.ok) return say(tx.weak[c.reason], "err");
    change(async () => {
      await O.changePassword(st.ctx, st.dek, p1.value);
      return tx.passwordChanged;
    });
  };
  return [
    h(
      "section",
      { class: "panel" },
      h("h2", {}, tx.tabs.settings),
      h("label", {}, tx.company, company, h("span", { class: "hint" }, tx.companyHint)),
      h("label", {}, tx.supplierEmails, emails, h("span", { class: "hint" }, tx.supplierEmailsHint)),
      btn(tx.save, () => change(() => O.writeSettings(st.ctx, st.keys, { company: company.value, emails: emailList(emails.value) })), "primary")
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, tx.passwordTitle),
      h("label", {}, tx.newPassword, p1),
      h("label", {}, tx.newPasswordAgain, p2),
      btn(tx.changePassword, changePw, "primary")
    ),
  ];
}

/** Saves a file from the page (no server involved). */
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function viewExport() {
  const tx = t();
  const day = new Date().toISOString().slice(0, 10);
  const files = E.exportFiles(st.data, tx, st.lang, day);
  const rows = (f) => f.text.split("\r\n").length - 2;
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, tx.tabs.export),
    h("p", {}, tx.export.intro),
    h(
      "div",
      { class: "list" },
      Object.entries(tx.export.items).map(([k, [title, what]]) =>
        h(
          "div",
          { class: "item export" },
          h("div", {}, h("b", {}, title), h("div", { class: "dim small" }, what), h("div", { class: "dim small" }, tx.export.rows(rows(files[k])))),
          btn(tx.export.download, () => saveFile(files[k].name, files[k].text), "primary small")
        )
      )
    ),
    h("p", { class: "warn small" }, tx.export.privacy)
  );
}

function viewMain() {
  const v = { overview: viewOverview, cylinders: viewCylinders, documents: viewDocuments, counterparties: viewCounterparties, phones: viewPhones, settings: viewSettings, export: viewExport }[st.tab];
  return [tabs(), v()];
}

function render() {
  const tx = t();
  document.documentElement.lang = st.lang;
  document.title = tx.title;
  const views = { connect: viewConnect, noExtension: viewNoExtension, choose: viewChoose, noRegistry: viewNoRegistry, unlock: viewUnlock, main: viewMain };
  const root = document.getElementById("app");
  root.replaceChildren(
    ...[
      header(),
      st.msg ? h("div", { class: "msg " + st.msg.cls, role: "status" }, st.msg.text) : null,
      h("main", {}, (views[st.view] || viewConnect)()),
      h("footer", {}, tx.footer, " · ", h("a", { href: st.lang === "it" ? "guida.html" : "guide.html", target: "_blank", rel: "noopener" }, tx.guide)),
      st.busy ? h("div", { class: "busy", role: "status" }, h("span", { class: "spin" }), st.busy) : null,
    ].filter(Boolean)
  );
}

window.addEventListener("DOMContentLoaded", render);
