"use strict";
// The admin page's data download (admin/src/export.js): the CSV files' content, separator and safety.

const { expect } = require("chai");
const E = require("../admin/src/export");
const { T } = require("../admin/src/i18n");

const CUST = "0x" + "11".repeat(20);
const PLANT = "0x" + "22".repeat(20);
const GONE = "0x" + "33".repeat(20);
const at = Date.UTC(2026, 10, 13, 9, 30) / 1000;

const data = {
  cps: [
    { id: CUST, type: "customer", name: "Officina Demo; Nord", emails: ["demo@example.com", "ufficio@example.com"] },
    { id: PLANT, type: "refill", name: "=HYPERLINK(\"x\")", emails: [] },
  ],
  cyls: [
    { info: { serial: "A-001", gas: "argon", capacityL: 50, owner: "supplier", registeredAt: at }, state: { location: { type: "customer", id: CUST }, condition: "full", lifecycle: "active", movement: "delivery", at } },
    { info: { serial: "B-002", gas: "oxygen", owner: GONE, registeredAt: at }, state: null },
  ],
  docs: [
    { document: { kind: "delivery_note", number: "2026/118", date: at + 60, counterparty: CUST, lines: [
      { serial: "A-001", gas: "argon", movement: "delivery", condition: "full" },
      { serial: "C-003", gas: "co2", movement: "collection", condition: "empty", anomaly: "+ risulta altrove" },
    ] }, signer: "0x" + "ab".repeat(20), corrects: "0x" + "0".repeat(64) },
    { unreadable: true },
    { document: { kind: "stock_count", date: at, counterparty: GONE, lines: [{ serial: "B-002", gas: "oxygen", movement: "stock_count", condition: "empty" }] }, signer: "0x" + "cd".repeat(20), corrects: "0x" + "12".repeat(32) },
  ],
};

const rows = (f) => f.text.replace(/^﻿/, "").trim().split("\r\n");

describe("admin page: data download", function () {
  it("makes four CSV files in Italian, with ';' and a byte order mark", function () {
    const f = E.exportFiles(data, T.it, "it", "2026-11-13");
    expect(Object.keys(f)).to.deep.equal(["cylinders", "movements", "documents", "customers"]);
    expect(f.cylinders.name).to.equal("gastrace-bombole-2026-11-13.csv");
    expect(f.cylinders.text.startsWith("﻿Codice;Gas;Litri;")).to.equal(true);
    const c = rows(f.cylinders);
    expect(c).to.have.length(3);
    expect(c[1]).to.match(/^A-001;Argon;50;del fornitore;"Presso Officina Demo; Nord";Piena;Consegna;2026-11-13 \d\d:30;/);
    expect(c[2]).to.match(/^B-002;Ossigeno;;\(tolto dall'elenco\);;;;;/);
  });

  it("lists every cylinder of every readable document, oldest first", function () {
    const m = rows(E.exportFiles(data, T.it, "it", "d").movements);
    expect(m).to.have.length(4);
    expect(m[1]).to.include("Giacenze;;(tolto dall'elenco);B-002;Ossigeno;Giacenza;Vuota;");
    expect(m[2]).to.include("DDT;2026/118;\"Officina Demo; Nord\";A-001;Argon;Consegna;Piena;");
    expect(m[3]).to.match(/C-003;CO₂;Ritiro;Vuota;'\+ risulta altrove$/);
  });

  it("counts each document's movements, its warnings, corrections and phone", function () {
    const d = rows(E.exportFiles(data, T.it, "it", "d").documents);
    expect(d[0]).to.equal("Data;Documento;Numero;Cliente / centro;Bombole;Consegna;Ritiro;Giacenza;Invio a ricarica;Rientro da ricarica;Segnalazioni;Correzione;Telefono");
    expect(d[1]).to.match(/;Giacenze;;\(tolto dall'elenco\);1;;;1;;;;sì;cdcd cdcd/);
    expect(d[2]).to.match(/;DDT;2026\/118;"Officina Demo; Nord";2;1;1;;;;1;;abab abab/);
  });

  it("never lets a spreadsheet run a typed value as a formula", function () {
    const c = rows(E.exportFiles(data, T.it, "it", "d").customers);
    expect(c[2]).to.equal(`Centro di ricarica;"'=HYPERLINK(""x"")";`);
    expect(E.cell("-1")).to.equal("'-1");
    expect(E.cell("@a")).to.equal("'@a");
    expect(E.cell("a\nb")).to.equal('"a\nb"');
  });

  it("uses ',' and English texts in English", function () {
    const f = E.exportFiles(data, T.en, "en", "2026-11-13");
    expect(f.customers.name).to.equal("gastrace-customers-2026-11-13.csv");
    expect(rows(f.customers)[1]).to.equal('Customer,"Officina Demo; Nord","demo@example.com, ufficio@example.com"');
    expect(rows(f.cylinders)[0]).to.match(/^Code,Gas,Litres,/);
  });
});
