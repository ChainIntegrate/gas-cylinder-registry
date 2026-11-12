"use strict";
// Plaintext formats (version 1) of the values GasCylinderRegistry stores encrypted.
// `validate*` functions return the value with only the known fields, or throw with the reason:
// the app and the owner tools never write, and never trust when reading, anything else.

const GASES = ["argon", "acetylene", "oxygen", "nitrogen", "co2", "argon_co2", "helium", "other"];
const LOCATIONS = ["depot", "customer", "refill"];
const CONDITIONS = ["full", "empty", "defective"];
const LIFECYCLES = ["active", "retired"];
const MOVEMENTS = ["register", "stock_count", "delivery", "collection", "to_refill", "from_refill", "defect", "retire"];
const COUNTERPARTY_TYPES = ["customer", "refill"];
const DOCUMENT_KINDS = ["delivery_note", "stock_count", "refill_note"];

const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(what, why) {
  throw new Error(`invalid ${what}: ${why}`);
}
function oneOf(what, v, list) {
  if (!list.includes(v)) fail(what, `"${v}" is not one of ${list.join(", ")}`);
  return v;
}
function text(what, v, max, optional = false) {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    fail(what, "missing");
  }
  if (typeof v !== "string") fail(what, "not text");
  const s = v.trim();
  if (!s && !optional) fail(what, "empty");
  if (s.length > max) fail(what, `longer than ${max} characters`);
  return s || undefined;
}
function time(what, v) {
  if (!Number.isInteger(v) || v < 1600000000 || v > 4102444800) fail(what, "not a Unix time in seconds");
  return v;
}
function hex(what, v, re) {
  if (typeof v !== "string" || !re.test(v)) fail(what, "wrong format");
  return v.toLowerCase();
}
function version(what, v) {
  if (v.v !== 1) fail(what, `unsupported version ${v.v}`);
}
function prune(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * GCRInfo: { v: 1, serial, gas, capacityL?, owner: "supplier" | counterparty id, registeredAt }
 */
function validateInfo(x) {
  if (!x || typeof x !== "object") fail("info", "not an object");
  version("info", x);
  const capacityL = x.capacityL === undefined ? undefined : Math.round(Number(x.capacityL) * 10) / 10;
  if (capacityL !== undefined && !(capacityL > 0 && capacityL <= 1000)) fail("info.capacityL", "out of range");
  return prune({
    v: 1,
    serial: text("info.serial", x.serial, 40),
    gas: oneOf("info.gas", x.gas, GASES),
    capacityL,
    owner: x.owner === "supplier" ? "supplier" : hex("info.owner", x.owner, HEX20),
    registeredAt: time("info.registeredAt", x.registeredAt),
  });
}

/**
 * GCRState: { v: 1, location: { type, id? }, condition, lifecycle, movement, at }
 * `id` is required for a customer or a refill plant and absent at the depot. `at` is the scan time
 * on the phone (a document may be sent later from the offline queue). The document and the signer
 * are not repeated here: the same transaction's `DocumentRecorded` event carries both, which keeps
 * every state write small.
 */
function validateState(x) {
  if (!x || typeof x !== "object") fail("state", "not an object");
  version("state", x);
  const loc = x.location || fail("state.location", "missing");
  const type = oneOf("state.location.type", loc.type, LOCATIONS);
  const location = type === "depot" ? { type } : { type, id: hex("state.location.id", loc.id, HEX20) };
  return {
    v: 1,
    location,
    condition: oneOf("state.condition", x.condition, CONDITIONS),
    lifecycle: oneOf("state.lifecycle", x.lifecycle, LIFECYCLES),
    movement: oneOf("state.movement", x.movement, MOVEMENTS),
    at: time("state.at", x.at),
  };
}

/**
 * Counterparty: { v: 1, type: "customer" | "refill", name, emails: [] }
 * Only the heading the driver needs and the addresses that receive the e-mail.
 */
function validateCounterparty(x) {
  if (!x || typeof x !== "object") fail("counterparty", "not an object");
  version("counterparty", x);
  const emails = Array.isArray(x.emails) ? x.emails.map((e) => text("counterparty.emails", e, 254)) : [];
  if (emails.length > 5) fail("counterparty.emails", "more than 5");
  for (const e of emails) if (!EMAIL.test(e)) fail("counterparty.emails", `"${e}" is not an e-mail address`);
  return {
    v: 1,
    type: oneOf("counterparty.type", x.type, COUNTERPARTY_TYPES),
    name: text("counterparty.name", x.name, 120),
    emails,
  };
}

/**
 * Document: { v: 1, kind, number?, date, counterparty, lines: [...], notes? }
 * line: { tokenId, serial, gas, movement, condition, anomaly? }
 * `number` is required for a delivery note and a refill note, absent for a stock count.
 */
function validateDocument(x) {
  if (!x || typeof x !== "object") fail("document", "not an object");
  version("document", x);
  const kind = oneOf("document.kind", x.kind, DOCUMENT_KINDS);
  const number = text("document.number", x.number, 40, kind === "stock_count");
  if (!Array.isArray(x.lines) || x.lines.length === 0) fail("document.lines", "empty");
  if (x.lines.length > 1000) fail("document.lines", "more than 1000");
  const lines = x.lines.map((l, i) =>
    prune({
      tokenId: hex(`document.lines[${i}].tokenId`, l.tokenId, HEX32),
      serial: text(`document.lines[${i}].serial`, l.serial, 40),
      gas: oneOf(`document.lines[${i}].gas`, l.gas, GASES),
      movement: oneOf(`document.lines[${i}].movement`, l.movement, MOVEMENTS),
      condition: oneOf(`document.lines[${i}].condition`, l.condition, CONDITIONS),
      anomaly: text(`document.lines[${i}].anomaly`, l.anomaly, 200, true),
    })
  );
  return prune({
    v: 1,
    kind,
    number,
    date: time("document.date", x.date),
    counterparty: hex("document.counterparty", x.counterparty, HEX20),
    lines,
    notes: text("document.notes", x.notes, 500, true),
  });
}

/**
 * Registry settings: { v: 1, company, emails: [] }. The company's name as the app and the e-mails show
 * it, and the supplier's own addresses, which receive every document's e-mail.
 */
function validateSettings(x) {
  if (!x || typeof x !== "object") fail("settings", "not an object");
  version("settings", x);
  const emails = Array.isArray(x.emails) ? x.emails.map((e) => text("settings.emails", e, 254)) : [];
  if (emails.length > 5) fail("settings.emails", "more than 5");
  for (const e of emails) if (!EMAIL.test(e)) fail("settings.emails", `"${e}" is not an e-mail address`);
  return { v: 1, company: text("settings.company", x.company, 120), emails };
}

/**
 * The setup code the owner tools show and the app scans once: "GCR1:<registry>:<creation block>".
 */
function parseSetupCode(code) {
  const m = /^GCR1:(0x[0-9a-fA-F]{40}):(\d{1,12})$/.exec(String(code).trim());
  if (!m) throw new Error("invalid setup code");
  return { registry: m[1], fromBlock: Number(m[2]) };
}

function setupCode(registry, fromBlock) {
  if (!HEX20.test(registry) || !Number.isInteger(fromBlock) || fromBlock < 0) throw new Error("invalid setup code fields");
  return `GCR1:${registry}:${fromBlock}`;
}

module.exports = {
  GASES,
  LOCATIONS,
  CONDITIONS,
  LIFECYCLES,
  MOVEMENTS,
  COUNTERPARTY_TYPES,
  DOCUMENT_KINDS,
  validateInfo,
  validateState,
  validateCounterparty,
  validateDocument,
  validateSettings,
  parseSetupCode,
  setupCode,
};
