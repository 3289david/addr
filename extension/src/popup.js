import { h, mount, $, icon, btn, short, initTheme } from "../../web/src/lib.js";
import { wallet, isConnected, disconnect, autoConnect } from "./connect.js";
import { openConnect } from "./ui.js";
import { dashboard } from "./dashboard.js";
import { send } from "./send.js";
import { receive } from "./receive.js";
import { names } from "./names.js";

const TABS = [["dashboard", "Home", dashboard], ["send", "Send", send], ["receive", "Receive", receive], ["names", "Names", names]];
let current = "dashboard";
const toggleTheme = initTheme();

let shell;
function buildShell() {
  const nav = h("nav", { class: "nav" }, TABS.map(([key, label]) => h("a", { href: "#", "data-tab": key }, label)));
  nav.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-tab]");
    if (!a) return;
    e.preventDefault();
    current = a.dataset.tab;
    render();
  });
  const walletBox = h("div", { class: "dropdown", id: "wallet-box" });
  const themeBtn = h("button", { class: "icon-btn", "aria-label": "Toggle theme", onclick: () => { const t = toggleTheme(); themeBtn.replaceChildren(icon(t === "light" ? "moon" : "sun", 18)); } }, icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun", 18));
  const header = h("header", { class: "top" }, h("span", { class: "brand" }, h("span", { class: "mark" }, "A"), h("span", { class: "word" }, "ADDR")), nav, h("div", { class: "top-actions" }, themeBtn, walletBox));
  const main = h("main", { id: "app" });
  mount($("#root"), header, main);
  document.addEventListener("click", (e) => { if (!e.target.closest?.(".dropdown")) document.querySelectorAll(".dropdown-panel").forEach((p) => p.remove()); });
  shell = { main, nav, walletBox };
}

function drawWallet() {
  const box = shell.walletBox;
  if (!isConnected()) { mount(box, btn(h("span", { class: "row tight" }, icon("wallet", 16), "Connect"), async () => { if (await openConnect()) render(); }, "secondary small")); return; }
  const t = h("button", { class: "btn secondary small", type: "button" }, h("span", { class: "pill ok", style: "padding:1px 8px" }, h("span", { class: "dot" })), h("span", { class: "mono", style: "font-size:13px" }, short(wallet.address, 4)));
  t.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".dropdown-panel").forEach((p) => p.remove());
    const panel = h("div", { class: "dropdown-panel", role: "menu" },
      h("button", { class: "item", onclick: () => { disconnect(); render(); } }, icon("logout", 16), "Disconnect"));
    box.append(panel);
  });
  mount(box, t);
}

function render() {
  drawWallet();
  shell.nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.tab === current));
  const fn = TABS.find(([key]) => key === current)?.[2] || dashboard;
  fn(shell.main).catch((e) => mount(shell.main, h("div", { class: "card" }, h("h3", null, "Something went wrong"), h("p", { class: "muted" }, e.message))));
}

buildShell();
wallet.listeners.push(render);
render();
autoConnect();
