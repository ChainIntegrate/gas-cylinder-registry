"use strict";
// The e-mail that goes with a document (external review G-03). The phone no longer sends an e-mail's
// text: it sends the document's facts (recipients, language, company, customer, kind, number, date,
// cylinders, warnings), signed with the same key and fingerprint as the document and bound to its
// EIP-712 digest. The relayer writes the e-mail from the fixed template below, the same one the app uses
// to offer "send from the phone": no free text, no attachment, at most eight recipients.
//
// No Buffer and no Node-only module: this file also runs in the app's WebView.

const { keccak256, toUtf8Bytes, getAddress, getBytes } = require("ethers");
const { GASES, MOVEMENTS, CONDITIONS, DOCUMENT_KINDS } = require("./schema");

const LIMITS = { maxRecipients: 8, maxLines: 1000, maxName: 120, maxNumber: 40, maxText: 20000 };
const EMAIL = /^[^\s@<>,;"()\\]+@[^\s@<>,;"()\\]+\.[^\s@<>,;"()\\]+$/;
const ANOMALIES = ["at_other", "at_customer", "at_refill", "retired", "owned_by_other", "not_here"];
const LANGS = ["it", "en"];

// The template's words, Italian and English (the app's own texts for the driver are in app/src/i18n.js).
const T = {
  it: {
    subject: (kind, number, company) => {
      const label = { delivery_note: "DDT", refill_note: "Documento ricarica", stock_count: "Giacenze" }[kind];
      const n = number ? String(number).replace(/^DDT\s*/i, "") : "";
      return `${company}: ${label}${n ? " " + n : ""}`;
    },
    intro: (company, who, date) => `${company}\nDocumento per: ${who}\nData: ${date}`,
    lines: "Bombole",
    anomaliesTitle: "Segnalazioni confermate dall'autista",
    footer: "Messaggio automatico: non rispondere a questo indirizzo.",
    movements: { delivery: "Consegna", collection: "Ritiro", to_refill: "Invio a ricarica", from_refill: "Rientro da ricarica", stock_count: "Giacenza", register: "Registrazione", defect: "Difettosa", retire: "Dismessa" },
    conditions: { full: "Piena", empty: "Vuota", defective: "Difettosa" },
    gases: { argon: "Argon", acetylene: "Acetilene", oxygen: "Ossigeno", nitrogen: "Azoto", co2: "CO₂", argon_co2: "Argon/CO₂", helium: "Elio", other: "Altro" },
    anomalies: {
      at_other: (n) => `Risulta presso ${n}`,
      at_customer: (n) => `Risulta già consegnata a ${n}`,
      at_refill: (n) => `Risulta in ricarica presso ${n}`,
      retired: "Risulta dismessa",
      owned_by_other: (n) => `È di proprietà di ${n}`,
      not_here: "Non risulta presso questo cliente",
    },
    locale: "it-IT",
  },
  en: {
    subject: (kind, number, company) => {
      const label = { delivery_note: "Delivery note", refill_note: "Refill note", stock_count: "Stock count" }[kind];
      const n = number ? String(number).replace(/^DDT\s*/i, "") : "";
      return `${company}: ${label}${n ? " " + n : ""}`;
    },
    intro: (company, who, date) => `${company}\nDocument for: ${who}\nDate: ${date}`,
    lines: "Cylinders",
    anomaliesTitle: "Warnings confirmed by the driver",
    footer: "Automatic message: do not reply to this address.",
    movements: { delivery: "Delivery", collection: "Collection", to_refill: "Sent to refill", from_refill: "Back from refill", stock_count: "Stock count", register: "Registration", defect: "Defective", retire: "Retired" },
    conditions: { full: "Full", empty: "Empty", defective: "Defective" },
    gases: { argon: "Argon", acetylene: "Acetylene", oxygen: "Oxygen", nitrogen: "Nitrogen", co2: "CO₂", argon_co2: "Argon/CO₂", helium: "Helium", other: "Other" },
    anomalies: {
      at_other: (n) => `Recorded at ${n}`,
      at_customer: (n) => `Already delivered to ${n}`,
      at_refill: (n) => `Recorded as being refilled at ${n}`,
      retired: "Recorded as retired",
      owned_by_other: (n) => `Owned by ${n}`,
      not_here: "Not recorded at this customer",
    },
    locale: "en-GB",
  },
};

function bad(why) {
  throw new Error(`mail: ${why}`);
}
/** One line of plain text: trimmed, no control characters (no header or line injection), bounded. */
function plain(what, v, max, optional = false) {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    bad(`${what} missing`);
  }
  if (typeof v !== "string") bad(`${what} is not text`);
  const s = v.trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) bad(`${what} has control characters`);
  if (!s && !optional) bad(`${what} empty`);
  if (s.length > max) bad(`${what} longer than ${max} characters`);
  return s || undefined;
}
function one(what, v, list) {
  if (!list.includes(v)) bad(`${what} "${v}" not allowed`);
  return v;
}

/**
 * Checks and normalizes an e-mail's facts:
 * { v: 2, to: [addresses], lang, company, who, kind, number?, date, lines: [{ serial, gas, movement,
 *   condition, anomaly?: { code, name? } }] }. Throws with the reason.
 */
function validateMail(m) {
  if (!m || typeof m !== "object") bad("not an object");
  if (m.v !== 2) bad("version 2 expected (the facts of the document, not a text)");
  const known = ["v", "to", "lang", "company", "who", "kind", "number", "date", "lines"];
  for (const k of Object.keys(m)) if (!known.includes(k)) bad(`"${k}" not allowed (the relayer writes the text; no attachments)`);
  const to = [...new Set((Array.isArray(m.to) ? m.to : []).map((a) => String(a).trim().toLowerCase()))];
  if (to.length === 0 || to.length > LIMITS.maxRecipients) bad(`1 to ${LIMITS.maxRecipients} recipients`);
  for (const a of to) if (a.length > 254 || !EMAIL.test(a)) bad(`"${a}" is not an e-mail address`);
  const kind = one("kind", m.kind, DOCUMENT_KINDS);
  if (!Number.isInteger(m.date) || m.date < 1600000000 || m.date > 4102444800) bad("date is not a Unix time");
  if (!Array.isArray(m.lines) || m.lines.length === 0 || m.lines.length > LIMITS.maxLines) bad(`1 to ${LIMITS.maxLines} lines`);
  const out = {
    v: 2,
    to,
    lang: one("lang", m.lang, LANGS),
    company: plain("company", m.company, LIMITS.maxName),
    who: plain("who", m.who, LIMITS.maxName),
    kind,
    number: kind === "stock_count" ? undefined : plain("number", m.number, LIMITS.maxNumber, true),
    date: m.date,
    lines: m.lines.map((l, i) => {
      const line = {
        serial: plain(`lines[${i}].serial`, l && l.serial, 40),
        gas: one(`lines[${i}].gas`, l.gas, GASES),
        movement: one(`lines[${i}].movement`, l.movement, MOVEMENTS),
        condition: one(`lines[${i}].condition`, l.condition, CONDITIONS),
      };
      if (l.anomaly) {
        line.anomaly = { code: one(`lines[${i}].anomaly`, l.anomaly.code, ANOMALIES) };
        const n = plain(`lines[${i}].anomaly.name`, l.anomaly.name, LIMITS.maxName, true);
        if (n) line.anomaly.name = n;
      }
      return line;
    }),
  };
  if (out.number === undefined) delete out.number;
  if (renderMail(out).text.length > LIMITS.maxText) bad("text too long");
  return out;
}

/** The e-mail, from the template: { to, subject, text }. `timeZone` for the date (the supplier's). */
function renderMail(m, { timeZone = "Europe/Rome" } = {}) {
  const t = T[m.lang] || T.it;
  const date = new Date(m.date * 1000).toLocaleString(t.locale, { dateStyle: "short", timeStyle: "short", timeZone });
  const sum = {};
  for (const l of m.lines) {
    sum[l.movement] = sum[l.movement] || {};
    sum[l.movement][l.gas] = (sum[l.movement][l.gas] || 0) + 1;
  }
  const out = [t.intro(m.company, m.who, date), ""];
  for (const [movement, byGas] of Object.entries(sum)) {
    out.push(`${t.movements[movement]}: ${Object.entries(byGas).map(([gas, n]) => `${n} ${t.gases[gas]}`).join(", ")}`);
  }
  out.push("", `${t.lines}:`);
  for (const l of m.lines) out.push(`- ${l.serial}  ${t.gases[l.gas]}  ${t.movements[l.movement]}  ${t.conditions[l.condition]}`);
  const flagged = m.lines.filter((l) => l.anomaly);
  if (flagged.length) {
    out.push("", `${t.anomaliesTitle}:`);
    for (const l of flagged) {
      const f = t.anomalies[l.anomaly.code];
      out.push(`- ${l.serial}: ${typeof f === "function" ? f(l.anomaly.name || "?") : f}`);
    }
  }
  out.push("", t.footer);
  return { to: m.to, subject: t.subject(m.kind, m.number, m.company), text: out.join("\n") };
}

/**
 * What the phone signs (as a personal message): the hash of the registry, the operation's EIP-712
 * digest and the e-mail's facts. Bound to the operation, the e-mail cannot be reused with another one.
 */
function mailDigest(registry, operationDigest, mail) {
  const m = validateMail(mail);
  const canonical = JSON.stringify({ registry: getAddress(registry).toLowerCase(), operation: String(operationDigest).toLowerCase(), mail: m });
  return keccak256(toUtf8Bytes(canonical));
}

/** Signs the e-mail with a wallet (tests, tools); the app signs `hashMessage(mailDigest)` natively. */
async function signMail(wallet, registry, operationDigest, mail) {
  return wallet.signMessage(getBytes(mailDigest(registry, operationDigest, mail)));
}

module.exports = { MAIL_LIMITS: LIMITS, MAIL_ANOMALIES: ANOMALIES, validateMail, renderMail, mailDigest, signMail };
