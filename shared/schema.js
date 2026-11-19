"use strict";
// Plaintext formats (version 1; the periodic test, the cylinder's owner and corrections added for the contracts' version 2) of the values GasCylinderRegistry stores encrypted.
// `validate*` functions return the value with only the known fields, or throw with the reason:
// the app and the owner tools never write, and never trust when reading, anything else.

const GASES = ["argon", "acetylene", "oxygen", "nitrogen", "co2", "argon_co2", "helium", "other"];
const LOCATIONS = ["depot", "customer", "refill"];
const CONDITIONS = ["full", "empty", "defective"];
const LIFECYCLES = ["active", "retired"];
const MOVEMENTS = ["register", "stock_count", "delivery", "collection", "to_refill", "from_refill", "defect", "retire", "correct"];
const COUNTERPARTY_TYPES = ["customer", "refill"];
const DOCUMENT_KINDS = ["delivery_note", "stock_count", "refill_note", "correction"];
/** Years between periodic tests when the settings say nothing for a gas. */
const DEFAULT_TEST_YEARS = 10;

const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

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

function years(what, v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 30) fail(what, "not a number of years from 1 to 30");
  return n;
}
function month(what, v) {
  if (typeof v !== "string" || !MONTH.test(v)) fail(what, "not a month (YYYY-MM)");
  const y = Number(v.slice(0, 4));
  if (y < 1950 || y > 2100) fail(what, "year out of range");
  return v;
}

// ------------------------------------------------------------------------------------------------
// Periodic test: months as "YYYY-MM"
// ------------------------------------------------------------------------------------------------

/** A month moved by `n` months ("2024-03", 120 -> "2034-03"). */
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** The month of a Unix time (seconds), in the local time zone. */
function monthOf(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * A cylinder's periodic test: { last?, due?, unreadable? }. The driver writes the month stamped on the
 * cylinder, the last test or the expiry; `completeTest` works out the other with the gas's years.
 * `unreadable: true` when the stamp cannot be read (the owner completes it).
 */
function validateTest(x) {
  if (!x || typeof x !== "object") fail("test", "not an object");
  if (x.unreadable === true) return { unreadable: true };
  const last = x.last === undefined ? undefined : month("test.last", x.last);
  const due = x.due === undefined ? undefined : month("test.due", x.due);
  if (!last && !due) fail("test", "neither the last test nor the expiry");
  if (last && due && due <= last) fail("test", "the expiry is not after the last test");
  return prune({ last, due });
}

/** The test with both months, the missing one worked out with `years`. */
function completeTest(test, yearsBetween) {
  const t = validateTest(test);
  if (t.unreadable) return t;
  const n = years("years", yearsBetween) || DEFAULT_TEST_YEARS;
  return { last: t.last || addMonths(t.due, -12 * n), due: t.due || addMonths(t.last, 12 * n) };
}

/** Years between tests for a cylinder: its own, else the settings' for its gas, else the default. */
function testYearsFor(info, settings) {
  return (info && info.testYears) || (settings && settings.testYears && settings.testYears[info && info.gas]) || DEFAULT_TEST_YEARS;
}

/**
 * "expired" (the expiry month is past), "soon" (within `soonMonths`), "ok", or "unknown" (no test or
 * an unreadable stamp). `now` in seconds.
 */
function testStatus(test, now, soonMonths = 3) {
  if (!test || test.unreadable || !test.due) return "unknown";
  const current = monthOf(now);
  if (test.due < current) return "expired";
  if (test.due <= addMonths(current, soonMonths)) return "soon";
  return "ok";
}

/**
 * GCRInfo: { v: 1, serial, gas, capacityL?, owner: "supplier" | counterparty id, testYears?, registeredAt }
 * `testYears`: this cylinder's years between periodic tests, when not the gas's (set by the owner).
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
    testYears: years("info.testYears", x.testYears),
    registeredAt: time("info.registeredAt", x.registeredAt),
  });
}

/**
 * GCRState: { v: 1, location: { type, id? }, condition, lifecycle, movement, at, test? }
 * `test`: the periodic test (validateTest), carried from state to state and updated when the cylinder
 * comes back tested; in the state because a phone may write it (the information only at registration).
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
    ...(x.test ? { test: validateTest(x.test) } : {}),
  };
}

/**
 * Counterparty: { v: 1, type: "customer" | "refill", name, emails: [], archived? }
 * Only the heading the driver needs and the addresses that receive the e-mail. `archived: true` takes it
 * off the lists while its documents keep its name (review A21: removing never erases a counterparty).
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
    ...(x.archived === true ? { archived: true } : {}),
  };
}

/**
 * Document: { v: 1, kind, number?, date, counterparty?, counterpartyName?, lines: [...], notes?, reason? }
 * `counterpartyName`: the counterparty's name when the document was made (review A21), so that a later
 * rename or archiving does not change what the document says.
 * line: { tokenId, serial, gas, movement, condition, anomaly?, owner?, capacityL?, testYears?, test? }
 * `number` is required for a delivery note and a refill note, absent for a stock count and a correction.
 * A line carries `owner`, `capacityL` and `test` when they were written: a new cylinder, a cylinder back
 * tested, a correction. A correction (by the owner) has no counterparty and gives its `reason`.
 */
function validateDocument(x) {
  if (!x || typeof x !== "object") fail("document", "not an object");
  version("document", x);
  const kind = oneOf("document.kind", x.kind, DOCUMENT_KINDS);
  const number = text("document.number", x.number, 40, kind === "stock_count" || kind === "correction");
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
      owner: l.owner === undefined ? undefined : l.owner === "supplier" ? "supplier" : hex(`document.lines[${i}].owner`, l.owner, HEX20),
      capacityL: l.capacityL === undefined ? undefined : Math.round(Number(l.capacityL) * 10) / 10,
      testYears: years(`document.lines[${i}].testYears`, l.testYears),
      test: l.test === undefined ? undefined : validateTest(l.test),
    })
  );
  return prune({
    v: 1,
    kind,
    number,
    date: time("document.date", x.date),
    counterparty: kind === "correction" && x.counterparty === undefined ? undefined : hex("document.counterparty", x.counterparty, HEX20),
    counterpartyName: text("document.counterpartyName", x.counterpartyName, 120, true),
    lines,
    notes: text("document.notes", x.notes, 500, true),
    reason: kind === "correction" ? text("document.reason", x.reason, 200) : undefined,
  });
}

/**
 * Registry settings: { v: 1, company, emails: [], testYears? }. The company's name as the app and the
 * e-mails show it, the supplier's own addresses, which receive every document's e-mail, and the years
 * between periodic tests by gas ({ argon: 10, … }; a gas not listed: DEFAULT_TEST_YEARS).
 */
function validateSettings(x) {
  if (!x || typeof x !== "object") fail("settings", "not an object");
  version("settings", x);
  const emails = Array.isArray(x.emails) ? x.emails.map((e) => text("settings.emails", e, 254)) : [];
  if (emails.length > 5) fail("settings.emails", "more than 5");
  for (const e of emails) if (!EMAIL.test(e)) fail("settings.emails", `"${e}" is not an e-mail address`);
  let testYears;
  if (x.testYears !== undefined) {
    if (!x.testYears || typeof x.testYears !== "object") fail("settings.testYears", "not an object");
    testYears = {};
    for (const [gas, n] of Object.entries(x.testYears)) testYears[oneOf("settings.testYears", gas, GASES)] = years(`settings.testYears.${gas}`, n);
  }
  return prune({ v: 1, company: text("settings.company", x.company, 120), emails, testYears });
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
  DEFAULT_TEST_YEARS,
  addMonths,
  monthOf,
  validateTest,
  completeTest,
  testYearsFor,
  testStatus,
  validateInfo,
  validateState,
  validateCounterparty,
  validateDocument,
  validateSettings,
  parseSetupCode,
  setupCode,
};
