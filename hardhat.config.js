require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Compile with the solc-js build from npm (pinned in package.json) instead of downloading a compiler:
// the build is reproducible offline and in sandboxes where binaries.soliditylang.org is unreachable.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion !== SOLC_VERSION) return runSuper();
  const solcPath = require.resolve("solc/soljson.js");
  return { compilerPath: solcPath, isSolcJs: true, version: SOLC_VERSION, longVersion: require("solc").version() };
});

module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
    },
  },
  networks: {
    luksoTestnet: {
      url: process.env.LUKSO_TESTNET_RPC_URL || "https://rpc.testnet.lukso.network",
      chainId: 4201,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
    luksoMainnet: {
      url: process.env.LUKSO_MAINNET_RPC_URL || "https://rpc.mainnet.lukso.network",
      chainId: 42,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  // Source verification on LUKSO's Blockscout explorers (scripts/verify-lukso.js). Blockscout needs no API
  // key, but hardhat-verify wants the field.
  etherscan: {
    apiKey: { luksoMainnet: "no-api-key-needed", luksoTestnet: "no-api-key-needed" },
    customChains: [
      {
        network: "luksoMainnet",
        chainId: 42,
        urls: { apiURL: "https://explorer.execution.mainnet.lukso.network/api", browserURL: "https://explorer.execution.mainnet.lukso.network" },
      },
      {
        network: "luksoTestnet",
        chainId: 4201,
        urls: { apiURL: "https://explorer.execution.testnet.lukso.network/api", browserURL: "https://explorer.execution.testnet.lukso.network" },
      },
    ],
  },
  sourcify: { enabled: false },
};
