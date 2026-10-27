// Connect-wallet modal, shared by every screen.
import { h, mount, modal, btn, icon, field, alert, toast, store } from "../../web/src/lib.js";
import { wallet, discoverWallets, connectInjected, connectWalletConnect, connectManual, walletConnectEnabled } from "./connect.js";

export function openConnect() {
  return new Promise((resolve) => {
    const list = h("div", { class: "stack" }, h("div", { class: "muted" }, "Looking for wallets..."));
    const manualBox = h("div", { class: "hide stack" });
    const manualInput = h("input", { placeholder: "0x... your EVM address", spellcheck: "false", autocomplete: "off", value: store.get("wapp.manualAddress", "") });
    const manualErr = h("div", { class: "bad help" });
    const wcBox = h("div", { class: "hide stack" });
    const m = modal({
      title: "Connect a wallet",
      body: h("div", { class: "stack" },
        h("p", { class: "muted", style: "margin:0" }, "Nothing is connected until you pick an option. This app never sees your private keys."),
        list,
        walletConnectEnabled()
          ? h("button", { class: "option", type: "button", onclick: () => { wcBox.classList.toggle("hide"); manualBox.classList.add("hide"); } },
              h("span", { class: "ico" }, icon("phone", 22)),
              h("span", null, h("div", { class: "t" }, "Mobile wallet app"), h("div", { class: "d" }, "Scan a QR code or open your wallet app directly.")))
          : null,
        wcBox,
        h("button", { class: "option", type: "button", onclick: () => { manualBox.classList.toggle("hide"); wcBox.classList.add("hide"); manualInput.focus(); } },
          h("span", { class: "ico" }, icon("key", 22)),
          h("span", null, h("div", { class: "t" }, "Watch an address"), h("div", { class: "d" }, "View-only. You can look things up but cannot send."))),
        manualBox),
    });
    m.onClose = (v) => resolve(!!v);
    wcBox.append(btn("Show QR code", async () => {
      try { await connectWalletConnect(); toast(`Connected to ${wallet.label}`); m.close(true); } catch (e) { if (e.code !== "CANCELLED") toast(e.message, "bad"); }
    }, "block"));
    manualBox.append(field("Address", manualInput), manualErr,
      btn("Continue", async () => {
        try { await connectManual(manualInput.value.trim()); toast("Watching address"); m.close(true); } catch (e) { manualErr.textContent = e.message; }
      }));
    discoverWallets().then((wallets) => {
      mount(list, wallets.length
        ? wallets.map((w) => h("button", { class: "option", type: "button", onclick: async () => {
            try { await connectInjected(w); toast(`Connected to ${w.name}`); m.close(true); } catch (e) { toast(e.code === 4001 ? "Request cancelled in your wallet" : e.message, "bad"); }
          } }, h("span", { class: "ico" }, w.icon ? h("img", { src: w.icon, alt: "", width: 26, height: 26, style: "border-radius:6px" }) : icon("wallet", 22)),
          h("span", null, h("div", { class: "t" }, w.name), h("div", { class: "d" }, "Browser wallet"))))
        : h("div", { class: "alert info" }, icon("info", 18), h("div", { class: "body" }, "No browser wallet found. Install one such as MetaMask, or use the options below.")));
    });
  });
}

export function notRegisteredCard(address) {
  return h("div", { class: "card stack center", style: "padding:40px 20px;text-align:center" },
    icon("alert", 48),
    h("h2", { style: "margin:10px 0 6px" }, "Registration Required"),
    h("p", { class: "lead", style: "max-width:520px;margin:0 auto 12px" },
      "ADDR Wallet only works with wallets that have a .addr name registered on addr.krl.kr."),
    h("p", { class: "muted", style: "max-width:480px;margin:0 auto 20px;font-size:13.5px" },
      "You cannot register a domain directly in ADDR Wallet. Please visit addr.krl.kr to register your name — 5+ character names are 100% free with gasless sponsored claims!"),
    h("div", { class: "row center", style: "justify-content:center;gap:12px" },
      h("a", { class: "btn large", href: "https://addr.krl.kr", target: "_blank", rel: "noopener" }, "Register on addr.krl.kr (Free)"),
      btn("Check again", () => location.reload(), "secondary large")));
}
