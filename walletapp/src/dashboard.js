import { h, mount, icon, btn, pill, short, copy, copyLine, skeleton } from "../../web/src/lib.js";
import { JsonRpcProvider, formatEther } from "ethers";
import { wallet, isConnected, primaryName, disconnect, getRegisteredNames } from "./connect.js";
import { openConnect, notRegisteredCard } from "./ui.js";

// A small curated set of well-known public RPCs, for the dashboard's cross-chain balance view only —
// separate from the ADDR registry chain's own RPC (which comes from the baked-in deployment config).
const BALANCE_CHAINS = [
  { name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com" },
  { name: "Base", symbol: "ETH", rpc: "https://mainnet.base.org" },
  { name: "Arbitrum One", symbol: "ETH", rpc: "https://arb1.arbitrum.io/rpc" },
  { name: "Optimism", symbol: "ETH", rpc: "https://mainnet.optimism.io" },
  { name: "Polygon", symbol: "POL", rpc: "https://polygon-rpc.com" },
  { name: "BNB Smart Chain", symbol: "BNB", rpc: "https://bsc-dataseed.binance.org" },
];

export async function dashboard(root) {
  if (!isConnected()) {
    mount(root, h("div", { class: "card stack center", style: "padding:40px 20px" },
      icon("wallet", 40),
      h("h2", { style: "margin:8px 0 0" }, "Connect a wallet"),
      h("p", { class: "muted", style: "margin:0" }, "View balances, send to .addr names, and manage your names."),
      btn("Connect wallet", async () => { if (await openConnect()) render(root); }, "large")));
    return;
  }
  render(root);
}

async function render(root) {
  const namesList = await getRegisteredNames(wallet.address);
  if (!namesList.length) {
    mount(root, notRegisteredCard(wallet.address));
    return;
  }
  const primary = await primaryName(wallet.address).catch(() => null);
  const name = primary || namesList[0]?.name || null;
  const balRows = h("div", { class: "stack" }, skeleton(3));
  mount(root, h("div", { class: "stack lg" },
    h("div", { class: "card stack" },
      h("div", { class: "row between" },
        h("div", null,
          name ? h("div", { style: "font-size:22px;font-weight:800" }, name) : h("div", { class: "muted" }, "No primary .addr name set"),
          h("div", { class: "mono muted", style: "font-size:13.5px" }, wallet.address)),
        h("div", { class: "row tight" },
          btn(icon("copy", 16), () => copy(wallet.address), "ghost small"),
          btn("Disconnect", () => { disconnect(); render(root); }, "ghost small"))),
      h("div", { class: "help" }, wallet.mode === "manual" ? "Watch-only — connect a real wallet to send." : `Connected via ${wallet.label}`)),
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Balances"), balRows)));

  const results = await Promise.all(BALANCE_CHAINS.map(async (c) => {
    try {
      const provider = new JsonRpcProvider(c.rpc, undefined, { staticNetwork: false });
      const bal = await provider.getBalance(wallet.address);
      return { ...c, ok: true, balance: formatEther(bal) };
    } catch {
      return { ...c, ok: false };
    }
  }));
  mount(balRows, results.map((r) => h("div", { class: "row between", style: "padding:6px 0" },
    h("div", null, r.name),
    r.ok ? h("div", { class: "mono" }, `${Number(r.balance).toFixed(5)} ${r.symbol}`) : pill("unreachable", "bad"))));
}
