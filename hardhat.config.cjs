require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./contracts", tests: "./test", artifacts: "./artifacts", cache: "./cache" },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545" },
    ...(process.env.RPC_URL
      ? { custom: { url: process.env.RPC_URL, accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [] } }
      : {}),
  },
};
