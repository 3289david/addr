const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const srcDir = path.join(root, "walletapp");
const dist = path.join(srcDir, "dist");
fs.mkdirSync(dist, { recursive: true });

const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

// Same baked-in deployment fallback as scripts/build-web.cjs. This app has NO backend of its own at
// all — every build must have this, there is no "optional" here.
const chainId = Number(process.env.CHAIN_ID || 31337);
const depPath = path.join(root, "deployments", `${chainId}.json`);
if (!fs.existsSync(depPath)) throw new Error(`no deployments/${chainId}.json — the wallet app has nothing to run without it`);
const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
const chainFallback = {
  chainId: dep.chainId, registry: dep.registry, resolver: dep.resolver, registrar: dep.registrar,
  startBlock: dep.startBlock,
  chain: {
    id: dep.chainId,
    name: process.env.CHAIN_NAME || (dep.chainId === 31337 ? "ADDR Local" : `Chain ${dep.chainId}`),
    rpcUrl: process.env.PUBLIC_RPC_URL || (process.env.RPC_URLS || "http://127.0.0.1:8545").split(",")[0].trim(),
    explorer: process.env.CHAIN_EXPLORER || "", currency: process.env.CHAIN_CURRENCY || "ETH",
  },
};

esbuild.buildSync({
  entryPoints: [path.join(srcDir, "src/main.js")],
  bundle: true, minify: true, format: "iife", target: "es2022",
  outfile: path.join(dist, "app.js"),
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.WALLETCONNECT_PROJECT_ID": JSON.stringify(process.env.WALLETCONNECT_PROJECT_ID || ""),
    "process.env.CHAIN_FALLBACK": JSON.stringify(JSON.stringify(chainFallback)),
  },
  logLevel: "info",
});

const v = Date.now().toString(36);
fs.writeFileSync(path.join(dist, "index.html"), fs.readFileSync(path.join(srcDir, "index.html"), "utf8").replace('/app.js"', `/app.js?v=${v}"`));
fs.copyFileSync(path.join(root, "web", "style.css"), path.join(dist, "style.css"));
fs.copyFileSync(path.join(srcDir, "manifest.json"), path.join(dist, "manifest.json"));
fs.copyFileSync(path.join(srcDir, "sw.js"), path.join(dist, "sw.js"));
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });
for (const f of fs.readdirSync(path.join(srcDir, "icons"))) fs.copyFileSync(path.join(srcDir, "icons", f), path.join(dist, "icons", f));
console.log("built wallet app (static, no backend)");
