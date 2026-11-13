"use strict";
// ethers' browser build keeps only the English word list (package.json "browser" field maps wordlists.js to
// wordlists-browser.js). The recovery code can be in Italian, so the pages and the app take ethers' full
// word lists: this esbuild plugin resolves ethers' own "./wordlists.js" to the file itself.
const path = require("path");

module.exports = {
  name: "ethers-all-wordlists",
  setup(build) {
    build.onResolve({ filter: /^\.\/wordlists\.js$/ }, (args) => {
      if (!/[\\/]ethers[\\/]lib\.(esm|commonjs)[\\/]wordlists[\\/]?/.test(args.importer + path.sep)) return undefined;
      return { path: path.join(path.dirname(args.importer), "wordlists.js") };
    });
  },
};
