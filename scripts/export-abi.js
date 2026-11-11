"use strict";
// Copies the contracts' ABIs from Hardhat's artifacts to shared/abi, so that the owner tools, the
// relayer and the app need no Hardhat. Run after `npx hardhat compile`: node scripts/export-abi.js
const fs = require("fs");
const path = require("path");

for (const name of ["GasCylinderRegistry", "GasCylinderRegistryFactory"]) {
  const artifact = require(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`));
  fs.writeFileSync(path.join(__dirname, "..", "shared", "abi", `${name}.json`), JSON.stringify(artifact.abi, null, 2) + "\n");
  if (name === "GasCylinderRegistryFactory") {
    // The factory's bytecode, for the deployment command of the owner tools.
    fs.writeFileSync(path.join(__dirname, "..", "shared", "abi", `${name}.bytecode.json`), JSON.stringify({ bytecode: artifact.bytecode }) + "\n");
  }
  console.log("exported", name);
}
