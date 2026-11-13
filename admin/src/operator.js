"use strict";
// GasTrace operator page, for ChainIntegrate only (operator.html, not indexed): creates a supplier's register
// from the browser. ChainIntegrate's Universal Profile, owner of the factory, signs and pays the creation in
// its own wallet (LUKSO's Universal Profile extension or UP Wallet, found through EIP-6963). The data
// password and the recovery code are made in this page and never leave it: only the key wraps go on-chain.

const { JsonRpcProvider, Contract, Interface, getAddress, isAddress, hexlify, randomBytes, id } = require("ethers");
const qrcode = require("qrcode-generator");
const S = require("../../shared");
const O = require("../../scripts/lib/owner");
const CONFIG = require("../admin-config.json");

const EXPLORER = CONFIG.chainId === 42 ? "https://explorer.execution.mainnet.lukso.network" : "https://explorer.execution.testnet.lukso.network";
const ADMIN_URL = "https://gastrace.chainintegrate.it/";
const NOT_FOR_ADMIN = ["it.chainintegrate.account"]; // the clients' extension never signs ChainIntegrate's administration

const T = {
  it: {
    lang: "English",
    title: "GasTrace · Operatore",
    tagline: "Crea i registri delle bombole per i fornitori (solo ChainIntegrate).",
    connect: "Collega il wallet della UP di ChainIntegrate",
    chooseWallet: "Scegli il wallet",
    noWallet: "Nessun wallet trovato: installa l'estensione Universal Profile di LUKSO o UP Wallet.",
    wrongNetwork: (c) => `Il wallet è sulla rete ${c}: passa a LUKSO (42).`,
    notOwner: (a, o) => `L'account ${a} non è il proprietario della Factory (${o}).`,
    connected: (a) => `Collegato: ${a}, proprietario della Factory.`,
    factory: "Factory",
    registers: "Registri creati",
    none: "Nessun registro.",
    colName: "Nome",
    colOwner: "Titolare",
    colCylinders: "Bombole",
    newRegister: "Nuovo registro",
    company: "Nome dell'azienda (nome della collezione)",
    symbol: "Sigla (maiuscole, 3-8 caratteri)",
    owner: "Account ChainIntegrate del fornitore (indirizzo 0x…)",
    ownerHint: "La UP che gestirà il registro dalla pagina admin con l'estensione ChainIntegrate Account.",
    password: "Password dei dati",
    password2: "Ripeti la password",
    passwordHint: "La scrive il fornitore, o tu con lui: protegge i dati cifrati. Resta in questa pagina.",
    language: "Lingua delle 24 parole",
    prepare: "Prepara",
    weak: { too_short: "Password troppo corta (almeno 14, meglio una frase di 20+).", too_simple: "Password troppo semplice: mescola maiuscole, cifre e simboli, o usa una frase di 20+ caratteri.", repetitive: "Password troppo ripetitiva." },
    mismatch: "Le due password non coincidono.",
    badOwner: "Indirizzo del titolare non valido.",
    ownerNotProfile: "L'indirizzo del titolare non è una Universal Profile.",
    badName: "Scrivi il nome dell'azienda.",
    badSymbol: "Sigla: 3-8 lettere maiuscole o cifre.",
    codeTitle: "CODICE DI RECUPERO — scrivilo ora",
    codeIntro: "24 parole: con queste il fornitore imposta una nuova password se perde quella attuale. Compaiono solo ora: scrivile o stampale e consegnale al fornitore. Nessuno le può recuperare.",
    print: "Stampa",
    check: (n) => `Controllo: parola numero ${n}`,
    checkFail: "Le parole di controllo non coincidono.",
    create: "Crea il registro",
    confirmWallet: "Conferma la transazione nel wallet…",
    waiting: "In attesa della conferma della rete…",
    created: "Registro creato.",
    address: "Indirizzo del registro",
    block: "Blocco",
    next: "Al fornitore: apra la pagina admin, acceda con l'estensione ChainIntegrate Account e scriva la password dei dati.",
    openAdmin: "Pagina admin",
    failed: (m) => `Non riuscito: ${m}`,
    rejected: "Annullato nel wallet.",
  },
  en: {
    lang: "Italiano",
    title: "GasTrace · Operator",
    tagline: "Create suppliers' cylinder registers (ChainIntegrate only).",
    connect: "Connect the wallet of ChainIntegrate's UP",
    chooseWallet: "Choose the wallet",
    noWallet: "No wallet found: install LUKSO's Universal Profile extension or UP Wallet.",
    wrongNetwork: (c) => `The wallet is on network ${c}: switch to LUKSO (42).`,
    notOwner: (a, o) => `The account ${a} is not the factory's owner (${o}).`,
    connected: (a) => `Connected: ${a}, the factory's owner.`,
    factory: "Factory",
    registers: "Registers created",
    none: "No registers.",
    colName: "Name",
    colOwner: "Owner",
    colCylinders: "Cylinders",
    newRegister: "New register",
    company: "Company name (the collection's name)",
    symbol: "Symbol (capitals, 3-8 characters)",
    owner: "The supplier's ChainIntegrate account (0x… address)",
    ownerHint: "The UP that will manage the register from the admin page with the ChainIntegrate Account extension.",
    password: "Data password",
    password2: "Password again",
    passwordHint: "Typed by the supplier, or you with them: it protects the encrypted data. It stays in this page.",
    language: "Language of the 24 words",
    prepare: "Prepare",
    weak: { too_short: "Password too short (at least 14, better a phrase of 20+).", too_simple: "Password too simple: mix capitals, digits and symbols, or use a phrase of 20+ characters.", repetitive: "Password too repetitive." },
    mismatch: "The two passwords do not match.",
    badOwner: "Invalid owner address.",
    ownerNotProfile: "The owner's address is not a Universal Profile.",
    badName: "Type the company's name.",
    badSymbol: "Symbol: 3-8 capitals or digits.",
    codeTitle: "RECOVERY CODE — write it down now",
    codeIntro: "24 words: with them the supplier sets a new password if the current one is lost. They are shown only now: write them down or print them and hand them to the supplier. Nobody can recover them.",
    print: "Print",
    check: (n) => `Check: word number ${n}`,
    checkFail: "The check words do not match.",
    create: "Create the register",
    confirmWallet: "Confirm the transaction in the wallet…",
    waiting: "Waiting for the network to confirm…",
    created: "Register created.",
    address: "Register address",
    block: "Block",
    next: "For the supplier: open the admin page, sign in with the ChainIntegrate Account extension and type the data password.",
    openAdmin: "Admin page",
    failed: (m) => `Failed: ${m}`,
    rejected: "Cancelled in the wallet.",
  },
};

const st = {
  lang: (() => { try { return localStorage.getItem("gastrace.lang") || "it"; } catch { return "it"; } })(),
  provider: new JsonRpcProvider(CONFIG.rpc, CONFIG.chainId, { staticNetwork: true }),
  wallets: [],
  wallet: null,
  account: null,
  registers: null,
  form: { name: "", symbol: "", owner: "", password: "", password2: "", language: "it" }, // kept across renders
  prepared: null, // { form, prepared, checks: [n, m] }
  result: null,
  msg: null,
  busy: null,
};
const t = () => T[st.lang] || T.it;
const factoryRead = () => new Contract(CONFIG.factory, O.FACTORY_ABI, st.provider);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const btn = (label, onclick, cls = "") => h("button", { type: "button", class: cls, onclick }, label);
const say = (text, cls = "err") => { st.msg = { text, cls }; st.busy = null; render(); };
const short = (a) => a.slice(0, 8) + "…" + a.slice(-6);
const errText = (e) => (e && (e.code === 4001 || e.code === "ACTION_REJECTED") ? t().rejected : t().failed((e && (e.shortMessage || e.message)) || "?"));

// ------------------------------------------------------------------------------------------------
// Wallet
// ------------------------------------------------------------------------------------------------

function discover() {
  return new Promise((resolve) => {
    const found = new Map();
    const on = (ev) => {
      const d = ev.detail;
      if (d && d.info && d.provider && !NOT_FOR_ADMIN.includes(d.info.rdns)) found.set(d.info.uuid || d.info.rdns, d);
    };
    window.addEventListener("eip6963:announceProvider", on);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", on);
      const list = [...found.values()];
      if (!list.length && window.lukso) list.push({ info: { name: "Universal Profile", rdns: "window.lukso", uuid: "lukso" }, provider: window.lukso });
      resolve(list);
    }, 800);
  });
}

async function start() {
  st.msg = null;
  st.wallets = await discover();
  if (!st.wallets.length) return say(t().noWallet);
  if (st.wallets.length === 1) return connect(st.wallets[0]);
  render();
}

async function connect(w) {
  st.msg = null;
  try {
    const [account] = await w.provider.request({ method: "eth_requestAccounts" });
    const chainId = Number(await w.provider.request({ method: "eth_chainId" }));
    if (chainId !== Number(CONFIG.chainId)) return say(t().wrongNetwork(chainId));
    const owner = getAddress(await factoryRead().owner());
    if (getAddress(account) !== owner) return say(t().notOwner(getAddress(account), owner));
    st.wallet = w;
    st.account = owner;
    st.msg = { text: t().connected(owner), cls: "ok" };
    await loadRegisters();
  } catch (e) {
    say(errText(e));
  }
}

async function loadRegisters() {
  const f = factoryRead();
  const n = Number(await f.registryCount());
  const list = n ? await f.registries(0, n) : [];
  st.registers = [];
  for (const a of list) {
    const r = new Contract(a, O.REGISTRY_ABI, st.provider);
    const [name, owner, supply] = await Promise.all([r.getData(id("LSP4TokenName")), r.owner(), r.totalSupply()]);
    st.registers.push({ address: a, name: name === "0x" ? "" : new TextDecoder().decode(Uint8Array.from(name.slice(2).match(/../g).map((x) => parseInt(x, 16)))), owner, cylinders: Number(supply) });
  }
  render();
}

// ------------------------------------------------------------------------------------------------
// A new register
// ------------------------------------------------------------------------------------------------

async function prepare(form) {
  const tx = t();
  st.msg = null;
  if (!form.name.trim()) return say(tx.badName);
  if (!/^[A-Z0-9]{3,8}$/.test(form.symbol)) return say(tx.badSymbol);
  if (!isAddress(form.owner)) return say(tx.badOwner);
  const owner = getAddress(form.owner);
  if (form.password !== form.password2) return say(tx.mismatch);
  const c = S.checkPassword(form.password);
  if (!c.ok) return say(tx.weak[c.reason]);
  st.busy = "…";
  render();
  try {
    let isProfile = false;
    if ((await st.provider.getCode(owner)) !== "0x") {
      isProfile = await new Contract(owner, ["function supportsInterface(bytes4) view returns (bool)"], st.provider).supportsInterface("0x24871b3d").catch(() => false);
    }
    if (!isProfile) return say(tx.ownerNotProfile);
    const prepared = await O.prepareRegistry({ factory: factoryRead(), password: form.password, language: form.language, salt: hexlify(randomBytes(32)) });
    const a = 1 + Math.floor(Math.random() * 12);
    const b = 13 + Math.floor(Math.random() * 12);
    st.prepared = { form: { ...form, owner, password: null, password2: null }, prepared, checks: [a, b] };
    st.form.password = st.form.password2 = ""; // the wraps are made: the password is no longer needed here
    st.busy = null;
    render();
  } catch (e) {
    say(errText(e));
  }
}

async function create(answers) {
  const tx = t();
  const p = st.prepared;
  const words = p.prepared.recoveryCode.split(" ");
  if (answers.some((w, i) => w.trim().toLowerCase() !== words[p.checks[i] - 1])) return say(tx.checkFail);
  st.msg = null;
  st.busy = tx.confirmWallet;
  render();
  try {
    const data = new Interface(O.FACTORY_ABI).encodeFunctionData("createRegistry", [
      p.prepared.salt,
      p.form.owner,
      p.form.name.trim(),
      p.form.symbol,
      p.prepared.dataKeys,
      p.prepared.dataValues,
    ]);
    const hash = await st.wallet.provider.request({ method: "eth_sendTransaction", params: [{ from: st.account, to: CONFIG.factory, data, value: "0x0" }] });
    st.busy = tx.waiting;
    render();
    let receipt = null;
    for (let i = 0; i < 120 && !receipt; i++) {
      receipt = await st.provider.getTransactionReceipt(hash).catch(() => null);
      if (!receipt) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!(await factoryRead().isRegistry(p.prepared.address))) throw new Error("the register is not on the factory yet: check the transaction " + hash);
    st.result = { address: p.prepared.address, block: receipt ? receipt.blockNumber : null, hash, name: p.form.name };
    st.prepared = null;
    st.form = { name: "", symbol: "", owner: "", password: "", password2: "", language: "it" };
    st.busy = null;
    st.msg = { text: tx.created, cls: "ok" };
    await loadRegisters();
  } catch (e) {
    say(errText(e));
  }
}

// ------------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------------

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const w = h("div", { class: "qr" });
  w.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  return w;
}

function viewConnect() {
  const tx = t();
  if (st.wallets.length > 1 && !st.wallet) {
    return h("section", { class: "panel narrow" }, h("h2", {}, tx.chooseWallet), st.wallets.map((w) => btn(w.info.name, () => connect(w), "big ghost")));
  }
  return h("section", { class: "hero" }, h("h1", {}, tx.title), h("p", {}, tx.tagline), btn(tx.connect, start, "primary big"));
}

function viewRegisters() {
  const tx = t();
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, tx.registers),
    h("p", { class: "dim small" }, `${tx.factory}: `, h("a", { href: `${EXPLORER}/address/${CONFIG.factory}`, target: "_blank", rel: "noopener", class: "mono" }, CONFIG.factory)),
    st.registers && st.registers.length
      ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, tx.colName), h("th", {}, tx.colOwner), h("th", {}, tx.colCylinders))),
          h("tbody", {}, st.registers.map((r) => h("tr", {},
            h("td", {}, h("a", { href: `${EXPLORER}/address/${r.address}`, target: "_blank", rel: "noopener" }, r.name || short(r.address))),
            h("td", { class: "mono" }, short(r.owner)),
            h("td", {}, String(r.cylinders))))))
      : h("p", { class: "dim" }, tx.none)
  );
}

function viewForm() {
  const tx = t();
  const f = st.form;
  const field = (key, attrs = {}, transform = (v) => v) =>
    h("input", { ...attrs, value: f[key], oninput: (e) => { e.target.value = transform(e.target.value); f[key] = e.target.value; } });
  const lang = h("select", { onchange: (e) => (f.language = e.target.value) },
    h("option", { value: "it", selected: f.language === "it" }, "Italiano"), h("option", { value: "en", selected: f.language === "en" }, "English"));
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, tx.newRegister),
    h("label", {}, tx.company, field("name", { type: "text" })),
    h("label", {}, tx.symbol, field("symbol", { type: "text", maxlength: "8" }, (v) => v.toUpperCase())),
    h("label", {}, tx.owner, field("owner", { type: "text", placeholder: "0x…", spellcheck: "false", autocomplete: "off" }), h("span", { class: "hint" }, tx.ownerHint)),
    h("label", {}, tx.password, field("password", { type: "password", autocomplete: "new-password" }), h("span", { class: "hint" }, tx.passwordHint)),
    h("label", {}, tx.password2, field("password2", { type: "password", autocomplete: "new-password" })),
    h("label", {}, tx.language, lang),
    btn(tx.prepare, () => prepare({ ...f, symbol: f.symbol.trim(), owner: f.owner.trim() }), "primary")
  );
}

function viewCode() {
  const tx = t();
  const p = st.prepared;
  const words = p.prepared.recoveryCode.split(" ");
  p.answers = p.answers || ["", ""]; // kept across renders, as the form
  const check = (i) => h("input", { type: "text", autocomplete: "off", spellcheck: "false", value: p.answers[i], oninput: (e) => (p.answers[i] = e.target.value) });
  const a = check(0);
  const b = check(1);
  return h(
    "section",
    { class: "panel code" },
    h("h2", {}, tx.codeTitle),
    h("p", {}, tx.codeIntro),
    h("div", { class: "printable" },
      h("p", { class: "print-only" }, `GasTrace · ${p.form.name} · ${p.prepared.address}`),
      h("ol", { class: "words" }, words.map((w) => h("li", {}, w)))),
    btn(tx.print, () => window.print(), "ghost"),
    h("label", {}, tx.check(p.checks[0]), a),
    h("label", {}, tx.check(p.checks[1]), b),
    btn(tx.create, () => create([a.value, b.value]), "primary big")
  );
}

function viewResult() {
  const tx = t();
  const r = st.result;
  return h(
    "section",
    { class: "panel" },
    h("h2", {}, tx.created),
    h("p", {}, h("b", {}, r.name)),
    h("p", {}, `${tx.address}: `, h("a", { class: "mono", href: `${EXPLORER}/address/${r.address}`, target: "_blank", rel: "noopener" }, r.address)),
    r.block ? h("p", { class: "dim" }, `${tx.block}: ${r.block}`) : null,
    h("p", {}, tx.next),
    h("div", { class: "row" }, h("a", { class: "button primary", href: ADMIN_URL, target: "_blank", rel: "noopener" }, tx.openAdmin)),
    qrSvg(ADMIN_URL)
  );
}

function render() {
  const tx = t();
  document.documentElement.lang = st.lang;
  document.title = tx.title;
  const main = !st.account ? [viewConnect()] : [st.result ? viewResult() : null, st.prepared ? viewCode() : viewForm(), viewRegisters()];
  document.getElementById("app").replaceChildren(
    ...[
      h("header", { class: "top" },
        h("div", { class: "brand" }, h("div", {}, h("div", { class: "name" }, tx.title), h("div", { class: "tagline" }, tx.tagline))),
        h("div", { class: "top-actions" }, st.account ? h("span", { class: "who mono" }, short(st.account)) : null,
          btn(tx.lang, () => { st.lang = st.lang === "it" ? "en" : "it"; try { localStorage.setItem("gastrace.lang", st.lang); } catch { /* private mode */ } render(); }, "ghost"))),
      st.msg ? h("div", { class: "msg " + st.msg.cls, role: "status" }, st.msg.text) : null,
      h("main", {}, main),
      st.busy ? h("div", { class: "busy", role: "status" }, h("span", { class: "spin" }), st.busy) : null,
    ].filter(Boolean)
  );
}

window.addEventListener("DOMContentLoaded", render);
