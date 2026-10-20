import { h, mount, icon, btn, field, alert, api, coin, pill, kv, tabs, qr, copy, copyLine, empty, fmtTime, timeAgo, short, store, toast, navigate, query, confirmDialog } from "./lib.js";
import { wallet, requireWallet, isConnected, sendEvmTransfer } from "./wallet.js";
import { NETWORKS, getNetwork, paymentUri, parseUnits, explorerTxUrl, isMultiNetworkAsset } from "../../packages/core/src/index.ts";
import { ethers } from "ethers";

export async function send(root) {
  const q = query();
  const tab = q.tab || "send";
  const go = (t) => navigate(t === "send" ? "/send" : `/send?tab=${t}`);
  mount(root, h("div", { class: "page-head" }, h("h1", null, "Send and receive"), h("p", null, "Send to a name. Pick the exact network and asset, check the resolved address, then confirm in your wallet.")),
    h("div", { style: "margin-bottom:22px" }, tabs([["send", "Send"], ["request", "Request payment"], ["history", "Receipts and address book"]], tab, go)),
    tab === "send" ? sendForm(q) : tab === "request" ? requestForm() : historyView());
}

function selectors(initial) {
  const net = h("select", { "aria-label": "Network" }, NETWORKS.map((n) => h("option", { value: n.id }, n.name)));
  const asset = h("select", { "aria-label": "Asset" });
  const fill = () => {
    const n = getNetwork(net.value);
    mount(asset, n.assets.map((a) => h("option", { value: `${a.symbol}|${a.standard}` }, a.standard === "native" ? a.symbol : `${a.symbol} (${a.standard})`)));
  };
  net.addEventListener("change", fill);
  net.value = initial.network && getNetwork(initial.network) ? initial.network : "ethereum";
  fill();
  if (initial.asset) {
    const want = `${initial.asset.toUpperCase()}|${(initial.standard || "").toUpperCase()}`;
    const opt = [...asset.options].find((o) => o.value.toUpperCase() === want) || [...asset.options].find((o) => o.value.toUpperCase().startsWith(initial.asset.toUpperCase() + "|"));
    if (opt) asset.value = opt.value;
  }
  return { net, asset, get: () => { const [symbol, standard] = asset.value.split("|"); return { network: net.value, symbol, standard }; } };
}

function sendForm(q) {
  const to = h("input", { placeholder: "heelo.addr", value: q.to || "", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Recipient name" });
  const sel = selectors(q);
  const amount = h("input", { placeholder: "0.00", inputmode: "decimal", value: q.amount || "", "aria-label": "Amount" });
  const result = h("div");
  const warn = h("div");
  const updWarn = () => {
    const s = sel.get();
    mount(warn, isMultiNetworkAsset(s.symbol) ? alert("warn", h("b", null, `${s.symbol} exists on several networks. `), `You are sending ${s.symbol} as ${s.standard} on ${getNetwork(s.network).name}. A mismatch with what the recipient expects can lose funds permanently.`) : null);
  };
  sel.net.addEventListener("change", updWarn); sel.asset.addEventListener("change", updWarn); updWarn();
  const lookup = btn("Look up recipient", async () => {
    mount(result);
    const name = to.value.trim().toLowerCase();
    if (!/\.addr$/.test(name)) throw new Error("Enter a full name ending in .addr");
    const { network, symbol, standard } = sel.get();
    try {
      const r = await api("GET", `/v1/names/${encodeURIComponent(name)}/resolve?${new URLSearchParams({ network, asset: symbol, standard })}`);
      mount(result, confirmCard(r, amount.value.trim()));
    } catch (e) { mount(result, alert("bad", e.message)); }
  }, "large block");
  to.addEventListener("keydown", (e) => { if (e.key === "Enter") lookup.click(); });
  if (q.to) setTimeout(() => lookup.click(), 60);
  return h("div", { class: "split" },
    h("div", { class: "card stack" }, field("Recipient", to), h("div", { class: "grid" }, field("Network", sel.net), field("Asset", sel.asset)), field("Amount", amount), warn, lookup),
    h("div", { class: "stack" }, result.childNodes.length ? null : null, result,
      h("div", { class: "card soft tight" }, h("h3", null, "Before you send"), h("ul", { class: "muted", style: "margin:0;padding-left:18px;display:grid;gap:6px;font-size:14px" },
        h("li", null, "Check the full address, not just the first and last characters."),
        h("li", null, "You are warned if the address changed in the last 24 hours or differs from what you saw before."),
        h("li", null, "Resolution never moves funds. Your wallet signs and sends the transaction.")))));
}

function confirmCard(r, amountStr) {
  const net = getNetwork(r.network);
  const asset = net.assets.find((a) => a.symbol === r.asset && a.standard === r.standard);
  const seenKey = `seen.${r.name}.${r.network}`;
  const seen = store.get(seenKey, null);
  const warnings = [];
  if (seen && seen.address !== r.address) warnings.push(["bad", h("span", null, h("b", null, "Different from last time. "), `You last saw ${short(seen.address, 8)} for this name on ${r.networkName} (${timeAgo(seen.at)}). Verify with the recipient through another channel.`)]);
  if (r.recentlyChanged) warnings.push(["warn", h("span", null, h("b", null, "Changed in the last 24 hours. "), `Updated ${fmtTime(r.updatedAt)} (version ${r.version}). This can be a hijack or a normal update; confirm with the recipient.`)]);
  if (r.fallbackWarning) warnings.push(["warn", r.fallbackWarning]);
  const ack = h("input", { type: "checkbox", id: "ack" });
  const out = h("div");
  const uri = paymentUri(net, asset, r.address, amountStr || undefined);
  const sendBtn = btn("Send from my wallet", async () => {
    if (!amountStr) throw new Error("Enter an amount first");
    if (!(await requireWallet())) return;
    const hash = await walletSend(net, asset, r.address, amountStr, r.name);
    store.set(seenKey, { address: r.address, at: Math.floor(Date.now() / 1000) });
    const rec = { name: r.name, network: r.network, asset: r.asset, standard: r.standard, address: r.address, amount: amountStr, tx: hash, at: Math.floor(Date.now() / 1000) };
    store.set("receipts", [rec, ...store.get("receipts", [])].slice(0, 200));
    mount(out, receipt(rec, net));
  }, "large");
  if (warnings.length) sendBtn.disabled = true;
  ack.addEventListener("change", () => (sendBtn.disabled = !ack.checked));
  const markBtn = btn("I sent it elsewhere: save receipt", async () => {
    const tx = prompt("Paste the transaction id (optional)") || "";
    const rec = { name: r.name, network: r.network, asset: r.asset, standard: r.standard, address: r.address, amount: amountStr || "?", tx, at: Math.floor(Date.now() / 1000) };
    store.set("receipts", [rec, ...store.get("receipts", [])].slice(0, 200));
    store.set(seenKey, { address: r.address, at: rec.at });
    mount(out, receipt(rec, net));
  }, "ghost small");
  const saveBtn = btn("Save to address book", () => {
    const book = store.get("book", {});
    book[r.name] = { ...(book[r.name] || {}), [r.network]: r.address };
    store.set("book", book); store.set(seenKey, { address: r.address, at: Math.floor(Date.now() / 1000) });
    toast("Saved to address book");
  }, "ghost small");
  const canDirect = net.family === "evm";
  return h("div", { class: "card stack" },
    h("div", { class: "row between" }, h("h3", { style: "margin:0" }, "Confirm recipient"), pill("verified on-chain", "ok", true)),
    h("div", { class: "row" }, coin(net.id, true), h("div", null, h("a", { href: `/name/${r.name}`, style: "font-size:20px;font-weight:700;color:var(--text)" }, r.name), h("div", { class: "muted", style: "font-size:13.5px" }, `${r.asset} (${r.standard}) on ${r.networkName}`))),
    h("div", null, h("div", { class: "faint", style: "font-size:12px;margin-bottom:6px" }, "ADDRESS"), copyLine(r.address)),
    kv([["Format", `${r.addressFormat}, checksum valid`], ["Last changed", r.updatedAt ? `${fmtTime(r.updatedAt)} (v${r.version})` : "-"], r.tokenContract ? ["Token contract", h("span", { class: "mono" }, r.tokenContract)] : null, ["Amount", amountStr ? `${amountStr} ${r.asset}` : h("span", { class: "muted" }, "not set")]], true),
    h("div", { class: "help" }, "Verified means the address is well-formed and read from an active name's on-chain record. It does not prove who the recipient is."),
    warnings.map(([k, t]) => alert(k, t)),
    warnings.length ? h("label", { class: "check" }, ack, h("span", null, "I have verified this address with the recipient")) : null,
    h("div", { class: "row" }, canDirect ? sendBtn : null, saveBtn),
    !canDirect ? alert("info", `Sending on ${net.name} is done from your ${net.nativeSymbol} wallet: scan the QR or copy the address / payment link below.`) : null,
    h("div", { class: "divider", style: "margin:2px 0" }),
    h("div", { class: "row", style: "align-items:flex-start" }, qr(uri), h("div", { class: "grow stack" }, h("div", { class: "faint", style: "font-size:12px" }, "PAYMENT LINK"), h("div", { class: "mono" }, uri), h("div", { class: "row tight" }, btn("Copy address", () => copy(r.address), "ghost small"), btn("Copy link", () => copy(uri), "ghost small"), markBtn))),
    out);
}

async function walletSend(net, asset, to, amountStr, name) {
  const amt = parseUnits(amountStr, asset.decimals);
  if (net.family === "evm") {
    const summary = `Sending ${amountStr} ${asset.symbol} to ${name} on ${net.name}`;
    if (asset.standard === "native") return sendEvmTransfer({ chainId: net.chainId, chainName: net.name, to, valueWei: amt, summary });
    const data = new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [to, amt]);
    return sendEvmTransfer({ chainId: net.chainId, chainName: net.name, to: asset.contract, valueWei: 0n, data, summary: `${summary}. This is a token transfer to the ${asset.symbol} contract, with the recipient inside the data.` });
  }
  throw new Error("Direct sending is not available for this network in the browser. Use the address, payment link or QR.");
}

function receipt(rec, net) {
  const l = rec.tx ? explorerTxUrl(net, rec.tx) : null;
  return alert("ok", h("b", null, "Payment submitted"), kv([["To", `${rec.name} (${short(rec.address, 8)})`], ["Amount", `${rec.amount} ${rec.asset} (${rec.standard}) on ${net.name}`], ["Time", fmtTime(rec.at)],
    ["Transaction", rec.tx ? (l ? h("a", { href: l, target: "_blank", rel: "noopener" }, rec.tx) : h("span", { class: "mono" }, rec.tx)) : "not recorded"]], true),
    h("div", { style: "margin-top:10px" }, btn("Print receipt", () => window.print(), "ghost small")));
}

function requestForm() {
  const to = h("input", { placeholder: "yourname.addr", value: store.get("myname", ""), spellcheck: "false" });
  const sel = selectors({});
  const amount = h("input", { placeholder: "optional amount", inputmode: "decimal" });
  const out = h("div");
  const mk = btn("Create request link", () => {
    const name = to.value.trim().toLowerCase();
    if (!/\.addr$/.test(name)) throw new Error("Enter a name ending in .addr");
    const { network, symbol, standard } = sel.get();
    const a = getNetwork(network).assets.find((x) => x.symbol === symbol && x.standard === standard);
    if (amount.value.trim()) parseUnits(amount.value.trim(), a.decimals);
    store.set("myname", name);
    const qs = new URLSearchParams({ to: name, network, asset: symbol, standard });
    if (amount.value.trim()) qs.set("amount", amount.value.trim());
    const link = `${location.origin}/send?${qs}`;
    mount(out, h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Your request link"), copyLine(link), h("div", { class: "center" }, qr(link)),
      h("div", { class: "help" }, "The payer's page resolves your current address from the chain when they open the link. It never contains a raw address, so it cannot go stale.")));
  }, "large");
  return h("div", { class: "split" }, h("div", { class: "card stack" }, field("Your name", to), h("div", { class: "grid" }, field("Network", sel.net), field("Asset", sel.asset)), field("Amount (optional)", amount), mk), out);
}

function historyView() {
  const receipts = store.get("receipts", []);
  const book = store.get("book", {});
  const clearAll = btn("Clear local data", async () => { if (await confirmDialog("Clear local data?", "Receipts and the address book are stored only in this browser. This cannot be undone.", "Clear", true)) { store.set("receipts", []); store.set("book", {}); navigate("/send?tab=history", true); location.reload(); } }, "ghost small");
  return h("div", { class: "stack lg" },
    h("div", null, h("h2", { style: "margin-top:0" }, "Receipts"), h("p", { class: "muted", style: "margin-top:-6px" }, "Stored only in this browser."),
      receipts.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["When", "To", "Amount", "Network", "Transaction"].map((x) => h("th", null, x)))),
        h("tbody", null, receipts.map((r) => { const n = getNetwork(r.network); const l = r.tx ? explorerTxUrl(n, r.tx) : null;
          return h("tr", null, h("td", { class: "nowrap" }, fmtTime(r.at)), h("td", null, r.name), h("td", null, `${r.amount} ${r.asset}`), h("td", null, n.name), h("td", null, l ? h("a", { href: l, target: "_blank", rel: "noopener" }, short(r.tx, 8)) : r.tx || "-")); }))))
        : empty("inbox", "No receipts yet", "Payments you send from here are listed with explorer links.")),
    h("div", null, h("h2", { style: "margin-top:0" }, "Address book"),
      Object.keys(book).length ? h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, Object.entries(book).map(([name, nets]) => h("tr", null,
        h("td", null, h("a", { href: `/send?to=${name}` }, name)), h("td", { class: "mono" }, Object.entries(nets).map(([n, a]) => h("div", null, `${n}: ${a}`))),
        h("td", { class: "right" }, btn("Remove", () => { const b = store.get("book", {}); delete b[name]; store.set("book", b); navigate("/send?tab=history", true); location.reload(); }, "ghost small")))))))
        : empty("list", "Address book is empty", "Save a recipient while sending. Their saved address is compared on every future send, and you are warned on change.")),
    h("div", null, clearAll));
}
void isConnected; void wallet;
