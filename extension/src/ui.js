// Connect-wallet modal for the extension popup. Only WalletConnect + watch-only — see connect.js for why
// injected/browser-wallet support isn't offered here.
import { h, modal, btn, icon, field, store, toast } from "../../web/src/lib.js";
import { wallet, connectWalletConnect, connectManual, walletConnectEnabled } from "./connect.js";

export function openConnect() {
  return new Promise((resolve) => {
    const manualBox = h("div", { class: "hide stack" });
    const manualInput = h("input", { placeholder: "0x... your EVM address", spellcheck: "false", autocomplete: "off", value: store.get("ext.manualAddress", "") });
    const manualErr = h("div", { class: "bad help" });
    const wcBox = h("div", { class: "hide stack" });
    const m = modal({
      title: "Connect a wallet",
      body: h("div", { class: "stack" },
        h("p", { class: "muted", style: "margin:0" }, "Nothing is connected until you pick an option. This extension never sees your private keys."),
        walletConnectEnabled()
          ? h("button", { class: "option", type: "button", onclick: () => { wcBox.classList.toggle("hide"); manualBox.classList.add("hide"); } },
              h("span", { class: "ico" }, icon("phone", 22)),
              h("span", null, h("div", { class: "t" }, "Mobile wallet app"), h("div", { class: "d" }, "Scan a QR code with your phone's wallet app.")))
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
  });
}
