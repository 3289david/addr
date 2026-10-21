import { h, mount, icon, btn, field, alert, kv, pill, qr, copy, copyLine, short, toast } from "../../web/src/lib.js";
import { NETWORKS, getNetwork, paymentUri, parseUnits } from "../../packages/core/src/index.ts";
import { resolveOnChain } from "../../packages/core/src/wallet-client.ts";
import { Interface } from "ethers";
import { wallet, isConnected, readProvider, ensureChain, requireWallet } from "./connect.js";
import { loadChain } from "./chain.js";
import { openConnect } from "./ui.js";

function selectors(initial = {}) {
  const net = h("select", { "aria-label": "Network" }, NETWORKS.map((n) => h("option", { value: n.id }, n.name)));
  const asset = h("select", { "aria-label": "Asset" });
  const fill = () => { const n = getNetwork(net.value); mount(asset, n.assets.map((a) => h("option", { value: `${a.symbol}|${a.standard}` }, a.standard === "native" ? a.symbol : `${a.symbol} (${a.standard})`))); };
  net.addEventListener("change", fill);
  net.value = initial.network && getNetwork(initial.network) ? initial.network : "base";
  fill();
  return { net, asset, get: () => { const [symbol, standard] = asset.value.split("|"); return { network: net.value, symbol, standard }; } };
}

export async function send(root) {
  const to = h("input", { placeholder: "name.addr", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Recipient name" });
  const sel = selectors();
  const amount = h("input", { placeholder: "0.00", inputmode: "decimal", "aria-label": "Amount" });
  const result = h("div");
  const lookup = btn("Look up recipient", async () => {
    mount(result);
    const name = to.value.trim().toLowerCase();
    if (!/\.addr$/.test(name)) throw new Error("Enter a full name ending in .addr");
    const { network, symbol, standard } = sel.get();
    try {
      const dep = await loadChain();
      const r = await resolveOnChain(dep, await readProvider(), name, network, symbol, standard);
      mount(result, confirmCard(r, amount.value.trim(), root));
    } catch (e) { mount(result, alert("bad", e.message)); }
  }, "large block");
  to.addEventListener("keydown", (e) => { if (e.key === "Enter") lookup.click(); });
  mount(root, h("div", { class: "stack lg" },
    h("div", { class: "card stack" }, h("h2", { style: "margin:0" }, "Send"),
      field("Recipient", to), h("div", { class: "grid" }, field("Network", sel.net), field("Asset", sel.asset)), field("Amount", amount), lookup),
    result));
}

function confirmCard(r, amountStr, root) {
  const net = getNetwork(r.network);
  const asset = net.assets.find((a) => a.symbol === r.asset && a.standard === r.standard);
  const uri = paymentUri(net, asset, r.address, amountStr || undefined);
  const out = h("div");
  const canDirect = net.family === "evm" && isConnected() && wallet.mode !== "manual";
  const sendBtn = btn("Send from my wallet", async () => {
    if (!amountStr) throw new Error("Enter an amount first");
    if (!(await requireWallet(() => openConnect()))) return;
    const amt = parseUnits(amountStr, asset.decimals);
    await ensureChain(net.chainId);
    let tx;
    if (asset.standard === "native") tx = await wallet.signer.sendTransaction({ to: r.address, value: amt });
    else {
      const data = new Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [r.address, amt]);
      tx = await wallet.signer.sendTransaction({ to: asset.contract, data });
    }
    const rc = await tx.wait();
    mount(out, alert("ok", h("b", null, "Sent. "), h("span", { class: "mono" }, rc.hash)));
    toast("Transaction sent");
  }, "large");
  return h("div", { class: "card stack" },
    h("div", { class: "row between" }, h("h3", { style: "margin:0" }, "Confirm recipient"), pill("verified on-chain", "ok", true)),
    h("div", null, h("a", { href: "#", style: "font-size:20px;font-weight:700;color:var(--text)" }, r.name), h("div", { class: "muted", style: "font-size:13.5px" }, `${r.asset} (${r.standard}) on ${r.networkName}`)),
    h("div", null, h("div", { class: "faint", style: "font-size:12px;margin-bottom:6px" }, "ADDRESS"), copyLine(r.address)),
    r.fallbackWarning ? alert("warn", r.fallbackWarning) : null,
    r.recentlyChanged ? alert("warn", "This address changed in the last 24 hours. Confirm with the recipient before sending.") : null,
    h("div", { class: "help" }, "Verified means the address is well-formed and read straight from this name's on-chain record, right now, over a public RPC. It does not prove who the recipient is."),
    h("div", { class: "row" }, canDirect ? sendBtn : null,
      !canDirect ? h("span", { class: "muted help" }, wallet.mode === "manual" ? "Watch-only — connect a real wallet to send." : net.family !== "evm" ? `Send on ${net.name} from your own ${net.nativeSymbol} wallet using the address or QR below.` : "Connect a wallet to send.") : null),
    h("div", { class: "divider", style: "margin:2px 0" }),
    h("div", { class: "row", style: "align-items:flex-start" }, qr(uri), h("div", { class: "grow stack" }, h("div", { class: "faint", style: "font-size:12px" }, "PAYMENT LINK"), h("div", { class: "mono" }, uri), btn("Copy link", () => copy(uri), "ghost small"))),
    out);
}
