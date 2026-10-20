const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const dist = path.join(root, "web", "dist");
fs.mkdirSync(dist, { recursive: true });
const dev = process.argv.includes("--dev");
esbuild.buildSync({
  entryPoints: [path.join(root, "web/src/main.js")],
  bundle: true, minify: !dev, sourcemap: dev, format: "iife", target: "es2022",
  outfile: path.join(dist, "app.js"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "info",
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
