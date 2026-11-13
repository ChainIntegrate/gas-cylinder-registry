"use strict";
// Publishes the source of the factory and of the registry implementation on LUKSO's explorer (Blockscout),
// so that anyone can check the deployed contracts are this repository's. Registries are EIP-1167 clones of
// the implementation: the explorer shows them as proxies of the verified implementation.
//
//   npx hardhat run --network luksoMainnet scripts/verify-lukso.js            (factory from gcr-registry.json)
//   FACTORY=0x… npx hardhat run --network luksoMainnet scripts/verify-lukso.js
//
// Needs the development dependencies (npm ci) and reaches the explorer's API; no key is used.
const fs = require("fs");
const hre = require("hardhat");

async function verify(address, constructorArguments, contract) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`verified: ${address}`);
  } catch (e) {
    if (/already verified/i.test(String(e.message))) console.log(`already verified: ${address}`);
    else throw e;
  }
}

async function main() {
  let factoryAddress = process.env.FACTORY;
  if (!factoryAddress && fs.existsSync("gcr-registry.json")) factoryAddress = JSON.parse(fs.readFileSync("gcr-registry.json", "utf8")).factory;
  if (!factoryAddress) throw new Error("no factory: set FACTORY=0x… or run from the folder with gcr-registry.json");
  const factory = await hre.ethers.getContractAt("GasCylinderRegistryFactory", factoryAddress);
  // The constructor's argument was the deployer, the factory's first owner; read it from the deployment
  // receipt's OwnershipTransferred event if the owner has changed since.
  const logs = await factory.queryFilter(factory.filters.OwnershipTransferred(hre.ethers.ZeroAddress));
  const firstOwner = logs.length ? logs[0].args.newOwner : await factory.owner();
  const implementation = await factory.implementation();
  console.log(`factory ${factoryAddress} (first owner ${firstOwner}), implementation ${implementation}`);
  await verify(implementation, [], "contracts/GasCylinderRegistry.sol:GasCylinderRegistry");
  await verify(factoryAddress, [firstOwner], "contracts/GasCylinderRegistryFactory.sol:GasCylinderRegistryFactory");
  const base = hre.network.config.chainId === 42 ? "https://explorer.execution.mainnet.lukso.network" : "https://explorer.execution.testnet.lukso.network";
  console.log(`\n${base}/address/${factoryAddress}?tab=contract\n${base}/address/${implementation}?tab=contract`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
