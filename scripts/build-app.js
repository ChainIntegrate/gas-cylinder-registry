#!/usr/bin/env node
"use strict";
// Builds the app's web content into app/www (what Capacitor packages):
//   app.js     app/src/ui.js bundled with esbuild (ethers, shared/, the logic, Capacitor's plugins)
//   index.html app/index.html, with the Content-Security-Policy allowing only the configured RPC and relayer
//   app.css
// GCR_APP_CONFIG=<file> uses another configuration (the browser tests point it at a local chain).
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "app");
const OUT = path.join(APP, "www");
const configFile = process.env.GCR_APP_CONFIG ? path.resolve(process.env.GCR_APP_CONFIG) : path.join(APP, "app-config.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
for (const k of ["rpc", "chainId", "relayer"]) if (!config[k]) throw new Error(`app config: ${k} missing`);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(APP, "src", "ui.js")],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["chrome100"],
    outfile: path.join(OUT, "app.js"),
    // The configuration is bundled in place of app/app-config.json.
    plugins: [{
      name: "app-config",
      setup(b) {
        b.onResolve({ filter: /app-config\.json$/ }, () => ({ path: configFile }));
      },
    }],
    legalComments: "linked",
    logLevel: "warning",
  });
  const origin = (u) => new URL(u).origin;
  const connect = [...new Set([origin(config.rpc), origin(config.relayer)])].join(" ");
  const html = fs.readFileSync(path.join(APP, "index.html"), "utf8")
    .replace(/connect-src [^;]+;/, `connect-src ${connect};`);
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  fs.copyFileSync(path.join(APP, "app.css"), path.join(OUT, "app.css"));
  const size = fs.statSync(path.join(OUT, "app.js")).size;
  console.log(`app/www built (app.js ${(size / 1024).toFixed(0)} KB, connect-src ${connect})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
