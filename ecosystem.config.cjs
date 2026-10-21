module.exports = {
  apps: [
    {
      name: "addr-chain",
      script: "node_modules/.bin/hardhat",
      args: "node",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "addr-web",
      script: "node_modules/.bin/tsx",
      args: "--no-warnings server/index.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
