const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const dist = path.join(root, "web", "dist");
fs.mkdirSync(dist, { recursive: true });
const dev = process.argv.includes("--dev");

// Pull build-time-only public config (e.g. WALLETCONNECT_PROJECT_ID) from .env, same loader as server/config.ts.
// These values end up baked into the public JS bundle, so only ever put values here that are safe to ship to the browser.
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

// Bake the deployment's contract addresses + chain info into the bundle too, as a fallback for
// loadChain() to use if GET /v1/contracts can't be reached (backend down, DNS issue, etc). Resolving a
// .addr name and sending to it needs nothing from the ADDR backend beyond these public, static facts —
// everything else (registry.statusOf, resolver.addr, ...) is a direct RPC call. Without this fallback,
// "works without the API" would still secretly depend on the API once, just to learn its own addresses.
const chainId = Number(process.env.CHAIN_ID || 31337);
const depPath = path.join(root, "deployments", `${chainId}.json`);
let chainFallback = null;
if (fs.existsSync(depPath)) {
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  chainFallback = {
    chainId: dep.chainId, registry: dep.registry, resolver: dep.resolver, registrar: dep.registrar,
    timelock: dep.timelock, ethUsdFeed: dep.ethUsdFeed, acceptedTokens: dep.tokens, treasury: dep.treasury,
    startBlock: dep.startBlock, relayer: null, tld: "addr",
    chain: {
      id: dep.chainId,
      name: process.env.CHAIN_NAME || (dep.chainId === 31337 ? "ADDR Local" : `Chain ${dep.chainId}`),
      rpcUrl: process.env.PUBLIC_RPC_URL || (process.env.RPC_URLS || "http://127.0.0.1:8545").split(",")[0].trim(),
      explorer: process.env.CHAIN_EXPLORER || "", currency: process.env.CHAIN_CURRENCY || "ETH", minCommitmentAge: undefined,
    },
  };
} else {
  console.warn(`no deployments/${chainId}.json found — the browser will have no offline fallback if the API is unreachable`);
}

esbuild.buildSync({
  entryPoints: [path.join(root, "web/src/main.js")],
  bundle: true, minify: !dev, sourcemap: dev, format: "iife", target: "es2022",
  outfile: path.join(dist, "app.js"),
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.WALLETCONNECT_PROJECT_ID": JSON.stringify(process.env.WALLETCONNECT_PROJECT_ID || ""),
    "process.env.CHAIN_FALLBACK": JSON.stringify(JSON.stringify(chainFallback)),
  },
  logLevel: "info",
});
if (dev) {
  // local-chain-only injected wallet, loaded before the app
  const dw = fs.readFileSync(path.join(root, "web/src/devwallet.js"), "utf8");
  const app = fs.readFileSync(path.join(dist, "app.js"), "utf8");
  fs.writeFileSync(path.join(dist, "app.js"), dw + "\n" + app);
}
const v = Date.now().toString(36);
fs.writeFileSync(path.join(dist, "index.html"), fs.readFileSync(path.join(root, "web", "index.html"), "utf8").replace('/app.js"', `/app.js?v=${v}"`).replace('/style.css"', `/style.css?v=${v}"`));
fs.copyFileSync(path.join(root, "web", "style.css"), path.join(dist, "style.css"));
console.log(dev ? "built web (dev wallet enabled via ?devwallet=N)" : "built web (production)");
