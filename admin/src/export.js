"use strict";
// The register's data as CSV files for the owner: cylinders, movements (one row per cylinder in each
// document), documents and customers. Plain functions, no interface: the page builds a file from them and
// the tests check them. Texts come from the page's language (i18n.js), with that language's separator:
// ";" in Italian, as Excel expects with Italian settings, "," in English. UTF-8 with a byte order mark,
// so Excel shows accented letters right.

const ZERO32 = "0x" + "0".repeat(64);

/**
 * A cell as text. A value starting with = + - @ (or a tab or carriage return) gets a leading apostrophe,
 * so a spreadsheet never runs it as a formula: names, codes and warnings are typed by people.
 */
function cell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV text: a header row, then the rows; CRLF line ends, with the byte order mark. */
function toCsv(header, rows, sep) {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}

/** A date and time as the spreadsheets read it, in the computer's time zone: 2026-11-13 15:04. */
function dateTime(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The four files: { cylinders, movements, documents, customers }, each { name, text }.
 * `data` is the page's data ({ cps, cyls, docs }); `tx` the texts of the page's language; `day` the date
 * in the file names (YYYY-MM-DD).
 */
function exportFiles(data, tx, lang, day) {
  const e = tx.export;
  const sep = lang === "en" ? "," : ";";
  const names = Object.fromEntries(data.cps.map((c) => [c.id, c.name]));
  const cpName = (id) => names[id] || e.removed;
  const where = (s) => {
    if (!s) return "";
    if (s.lifecycle === "retired") return tx.retired;
    if (s.location.type === "depot") return tx.locations.depot;
    return tx.locations[s.location.type](cpName(s.location.id));
  };
  const docNumber = (d) => (d.number ? String(d.number).replace(/^DDT\s*/i, "") : ""); // as the page shows it
  const file = (key, header, rows) => ({ name: `gastrace-${e.files[key]}-${day}.csv`, text: toCsv(header, rows, sep) });
  const readable = data.docs.filter((d) => d.document);

  return {
    cylinders: file(
      "cylinders",
      [tx.serial, tx.gas, e.capacity, tx.ownedBy, tx.where, tx.condition, tx.lastMovement, e.lastMovementDate, tx.registeredOn],
      data.cyls.map((c) => [
        c.info.serial,
        tx.gases[c.info.gas],
        c.info.capacityL || "",
        c.info.owner === "supplier" ? tx.supplier : cpName(c.info.owner),
        where(c.state),
        c.state ? tx.conditions[c.state.condition] : "",
        c.state ? tx.movements[c.state.movement] : "",
        c.state ? dateTime(c.state.at) : "",
        dateTime(c.info.registeredAt),
      ])
    ),
    movements: file(
      "movements",
      [tx.date, e.document, tx.number, tx.counterparty, tx.serial, tx.gas, e.movement, tx.condition, e.warning],
      readable
        .slice()
        .reverse()
        .flatMap((d) =>
          d.document.lines.map((l) => [
            dateTime(d.document.date),
            tx.docKinds[d.document.kind],
            docNumber(d.document),
            cpName(d.document.counterparty),
            l.serial,
            tx.gases[l.gas],
            tx.movements[l.movement],
            tx.conditions[l.condition],
            l.anomaly || "",
          ])
        )
    ),
    documents: file(
      "documents",
      [tx.date, e.document, tx.number, tx.counterparty, e.cylinders, ...e.movementColumns.map((m) => tx.movements[m]), e.warnings, e.correction, e.phone],
      readable
        .slice()
        .reverse()
        .map((d) => {
          const doc = d.document;
          const n = (m) => doc.lines.filter((l) => l.movement === m).length || "";
          return [
            dateTime(doc.date),
            tx.docKinds[doc.kind],
            docNumber(doc),
            cpName(doc.counterparty),
            doc.lines.length,
            ...e.movementColumns.map(n),
            doc.lines.filter((l) => l.anomaly).length || "",
            d.corrects && d.corrects !== ZERO32 ? e.yes : "",
            d.signer ? d.signer.slice(2).match(/.{1,4}/g).join(" ") : "",
          ];
        })
    ),
    customers: file(
      "customers",
      [e.type, tx.name, e.emails],
      data.cps.map((c) => [c.type === "customer" ? e.customer : e.refill, c.name, c.emails.join(", ")])
    ),
  };
}

module.exports = { exportFiles, toCsv, cell, dateTime };
