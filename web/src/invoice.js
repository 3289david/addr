import { h, mount, icon, btn, field, alert, api, coin, pill, statusPill, kv, qr, copy, copyLine, steps, skeleton, fmtTime, timeAgo, toast } from "./lib.js";
import { getNetwork, explorerTxUrl } from "../../packages/core/src/index.ts";

export async function invoice(root, id) {
  mount(root, skeleton(5));
  let timer;
  const stop = () => clearTimeout(timer);
  const draw = async () => {
    if (!root.isConnected) return stop();
    let inv;
    try { inv = await api("GET", `/v1/invoices/${id}`); } catch (e) { return mount(root, alert("bad", e.message)); }
    const net = getNetwork(inv.network);
    const open = inv.status === "pending";
    const stage = inv.status === "completed" ? 3 : inv.status === "paid" ? 2 : inv.status === "confirming" ? 1 : 0;
    const tx = h("input", { placeholder: net.family === "evm" ? "0x transaction hash" : "transaction id", spellcheck: "false", value: inv.txid || "", "aria-label": "Transaction id" });
    const submit = btn("Verify payment", async () => {
      try { await api("POST", `/v1/invoices/${id}/payment`, { txid: tx.value.trim() }); toast("Payment found. Waiting for confirmations."); draw(); }
      catch (e) { toast(e.message, "bad"); }
    }, "block large");
    const title = inv.kind === "plan" ? `${inv.plan[0].toUpperCase()}${inv.plan.slice(1)} plan` : inv.name;
    mount(root,
      h("div", { class: "page-head" }, h("div", { class: "row tight" }, h("h1", { style: "margin:0" }, title), statusPill(inv.status)), h("p", { class: "mono", style: "font-size:12.5px" }, `Invoice ${inv.id}`)),
      steps(["Send payment", "Confirming", "Registering", "Done"], stage), h("div", { style: "height:18px" }),
      inv.status === "completed" ? alert("ok", h("b", null, inv.kind === "name" ? `${inv.name} is registered to ${inv.owner}.` : "Payment applied."), inv.name ? h("div", { style: "margin-top:8px" }, h("a", { class: "btn small", href: `/name/${inv.name}` }, "Open profile")) : null) : null,
      inv.status === "expired" ? alert("warn", "This quote expired. Create a new invoice to get a fresh price.") : null,
      inv.error ? alert("bad", inv.error) : null,
      ["needs_review", "registration_failed"].includes(inv.status) ? alert("warn", "This payment needs manual attention. Keep this invoice id and the transaction id; if the name was taken in the meantime it will be refunded.") : null,
      h("div", { class: "split", style: "margin-top:16px" },
        h("div", { class: "card stack" },
          h("div", { class: "row between" }, h("div", { class: "row tight" }, coin(inv.network, true), h("div", null, h("div", { style: "font-weight:700" }, `${inv.asset}${inv.standard !== "native" ? " " + inv.standard : ""}`), h("div", { class: "muted", style: "font-size:13px" }, net.name))), h("div", { class: "right" }, h("div", { class: "faint", style: "font-size:12px" }, "PRICE"), h("div", { style: "font-size:20px;font-weight:750" }, inv.priceUsd))),
          h("div", null, h("div", { class: "faint", style: "font-size:12px;margin-bottom:6px" }, "SEND EXACTLY"), copyLine(`${inv.amount}`, "Copy amount")),
          h("div", null, h("div", { class: "faint", style: "font-size:12px;margin-bottom:6px" }, "TO ADDRESS"), copyLine(inv.payTo)),
          inv.contract ? h("div", null, h("div", { class: "faint", style: "font-size:12px;margin-bottom:6px" }, "TOKEN CONTRACT"), h("div", { class: "mono" }, inv.contract)) : null,
          kv([["Quote valid until", fmtTime(inv.expiresAt)], ["Rate", `1 ${inv.asset} = $${inv.rateUsdPerUnit}`], ["Confirmations", `${inv.confirmations ?? 0} of ${inv.minConfirmations}`], inv.txid ? ["Transaction", h("a", { href: explorerTxUrl(net, inv.txid), target: "_blank", rel: "noopener noreferrer", class: "mono" }, inv.txid)] : null], true),
          open ? alert("info", inv.note) : null),
        open ? h("div", { class: "stack" }, h("div", { class: "card center stack" }, h("div", { class: "muted" }, "Scan with your wallet"), h("div", null, qr(inv.paymentUri)), h("div", { class: "help" }, "Network fees are paid by you on top of this amount.")),
          h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "After you pay"), h("p", { class: "muted", style: "margin:0" }, "Paste the transaction id. We read it from the network and check the recipient, asset and exact amount."), field("Transaction id", tx), submit)) : null));
    if (["confirming", "paid"].includes(inv.status)) timer = setTimeout(draw, 5000);
  };
  window.addEventListener("popstate", stop, { once: true });
  draw();
}
void pill; void timeAgo; void copy;
