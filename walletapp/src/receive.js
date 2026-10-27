import { h, mount, icon, btn, field, alert, qr, copy, copyLine, toast } from "../../web/src/lib.js";
import { wallet, isConnected, primaryName, registryContracts, requireWallet, getRegisteredNames } from "./connect.js";
import { openConnect, notRegisteredCard } from "./ui.js";

export async function receive(root) {
  if (!isConnected()) {
    mount(root, h("div", { class: "card stack center", style: "padding:40px 20px" }, icon("wallet", 40), h("h2", { style: "margin:8px 0 0" }, "Connect a wallet"),
      btn("Connect wallet", async () => { if (await requireWallet(() => openConnect())) receive(root); }, "large")));
    return;
  }
  const namesList = await getRegisteredNames(wallet.address);
  if (!namesList.length) {
    mount(root, notRegisteredCard(wallet.address));
    return;
  }
  const primary = await primaryName(wallet.address).catch(() => null);
  const name = primary || namesList[0]?.name || null;
  const setBox = h("div");
  mount(root, h("div", { class: "stack lg" },
    h("div", { class: "card stack center" },
      h("h2", { style: "margin:0" }, "Receive"),
      name ? h("div", { style: "font-size:24px;font-weight:800" }, name) : h("div", { class: "muted" }, "No primary .addr name set — people will see your raw address"),
      qr(name || wallet.address, 220),
      h("div", { style: "width:100%" }, copyLine(wallet.address)),
      h("div", { class: "help" }, "Anyone can send to you using this address directly, or your .addr name.")),
    wallet.mode !== "manual" ? h("div", { class: "card stack" },
      h("h3", { style: "margin:0" }, "Primary name"),
      h("p", { class: "muted", style: "margin:0" }, "Pick which of your own .addr names is shown as your identity."),
      field("Your registered name", (() => {
        const sel = h("select", { "aria-label": "Select primary name" },
          namesList.map((n) => h("option", { value: n.name, selected: n.name === name }, n.name)));
        return sel;
      })()),
      setBox,
      btn("Set as primary name", async () => {
        const sel = root.querySelector("select[aria-label='Select primary name']");
        const v = sel.value.trim().toLowerCase();
        if (!/\.addr$/.test(v)) throw new Error("Enter a full name ending in .addr");
        const { resolver } = await registryContracts(true);
        const tx = await resolver.setPrimaryName(v);
        await tx.wait();
        toast("Primary name set");
        receive(root);
      }, "large")) : null));
}
