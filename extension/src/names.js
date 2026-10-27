import { h, mount, icon, btn, alert, pill, fmtDate } from "../../web/src/lib.js";
import { wallet, isConnected, requireWallet, getRegisteredNames } from "./connect.js";
import { openConnect, notRegisteredCard } from "./ui.js";

export async function names(root) {
  if (!isConnected() || wallet.mode === "manual") {
    mount(root, h("div", { class: "card stack center", style: "padding:40px 20px" },
      icon("list", 40),
      h("h2", { style: "margin:8px 0 0" }, "Connect a wallet"),
      h("p", { class: "muted", style: "margin:0" }, "View your registered .addr names."),
      btn("Connect wallet", async () => { if (await requireWallet(() => openConnect())) names(root); }, "large")));
    return;
  }

  mount(root, h("div", { class: "stack lg" },
    h("div", { class: "card stack" },
      h("div", { class: "muted" }, "Checking registered .addr names for your wallet..."))));

  const list = await getRegisteredNames(wallet.address);
  if (!list.length) {
    mount(root, notRegisteredCard(wallet.address));
    return;
  }

  mount(root, h("div", { class: "stack lg" },
    alert("info",
      h("b", null, "Registration is exclusive to addr.krl.kr. "),
      "You cannot register a domain directly in ADDR Wallet. Domain registration is handled with gasless sponsored claims (we cover all gas) exclusively on ",
      h("a", { href: "https://addr.krl.kr", target: "_blank", rel: "noopener" }, "addr.krl.kr"),
      "."),
    h("div", { class: "card stack" },
      h("div", { class: "row between" },
        h("div", null,
          h("h2", { style: "margin:0" }, "My .addr names"),
          h("p", { class: "muted", style: "margin:4px 0 0;font-size:13px" }, `${list.length} name${list.length === 1 ? "" : "s"} registered for this wallet`)),
        h("a", { class: "btn secondary small", href: "https://addr.krl.kr", target: "_blank", rel: "noopener" }, "Register more on addr.krl.kr")),
      h("div", { class: "stack" },
        list.map((r) => h("div", { class: "row between", style: "padding:12px 0;border-bottom:1px solid var(--border)" },
          h("div", null,
            h("div", { class: "row tight" },
              h("span", { style: "font-size:18px;font-weight:700" }, r.name),
              pill("active", "ok"),
              r.free ? pill("free tier", "info") : null),
            r.expiresAt ? h("div", { class: "muted", style: "font-size:12.5px;margin-top:2px" }, `Expires ${fmtDate(r.expiresAt)}`) : null),
          h("div", { class: "row tight" },
            h("a", { class: "btn small secondary", href: `https://addr.krl.kr/name/${r.name}`, target: "_blank", rel: "noopener" }, "Manage records on addr.krl.kr"))))))));
}
