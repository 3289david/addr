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

esbuild.buildSync({
  entryPoints: [path.join(root, "web/src/main.js")],
  bundle: true, minify: !dev, sourcemap: dev, format: "iife", target: "es2022",
  outfile: path.join(dist, "app.js"),
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.WALLETCONNECT_PROJECT_ID": JSON.stringify(process.env.WALLETCONNECT_PROJECT_ID || ""),
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
