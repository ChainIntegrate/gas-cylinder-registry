#!/usr/bin/env node
"use strict";
// Builds the GasTrace admin page and the operator page into admin/www (static files for the web server):
//   admin.js, operator.js   admin/src/*.js bundled with esbuild (ethers, shared/, the owner tools' logic)
//   index.html, operator.html with the Content-Security-Policy allowing only the configured RPC and relayer
//   admin.css, logo.png, favicon.ico, and the users' guide (guida.html in Italian, guide.html in English)
// GCR_ADMIN_CONFIG=<file> uses another configuration (the browser test points it at a local chain).
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const allWordlists = require("./lib/esbuild-wordlists");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "admin");
const OUT = path.join(DIR, "www");
const configFile = process.env.GCR_ADMIN_CONFIG ? path.resolve(process.env.GCR_ADMIN_CONFIG) : path.join(DIR, "admin-config.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
for (const k of ["rpc", "chainId", "relayer", "factory"]) if (config[k] === undefined) throw new Error(`admin config: ${k} missing`);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const page of ["admin", "operator"]) await esbuild.build({
    entryPoints: [path.join(DIR, "src", `${page}.js`)],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["chrome110", "firefox110", "safari16"],
    outfile: path.join(OUT, `${page}.js`),
    plugins: [allWordlists, { name: "admin-config", setup(b) { b.onResolve({ filter: /admin-config\.json$/ }, () => ({ path: configFile })); } }],
    legalComments: "linked",
    logLevel: "warning",
  });
  const origin = (u) => new URL(u).origin;
  const connect = [...new Set([origin(config.rpc), origin(config.relayer)])].join(" ");
  for (const page of ["index.html", "operator.html"]) {
    const html = fs.readFileSync(path.join(DIR, page), "utf8").replace(/connect-src [^;]+;/, `connect-src ${connect};`);
    fs.writeFileSync(path.join(OUT, page), html);
  }
  for (const f of ["admin.css", "logo.png", "favicon.ico", "guida.html", "guide.html"]) fs.copyFileSync(path.join(DIR, f), path.join(OUT, f));
  console.log(`admin/www built (admin.js ${(fs.statSync(path.join(OUT, "admin.js")).size / 1024).toFixed(0)} KB, connect-src ${connect})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
