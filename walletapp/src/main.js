import { h, mount, $, icon, btn, short, initTheme, router } from "../../web/src/lib.js";
import { wallet, isConnected, disconnect, autoConnect } from "./connect.js";
import { openConnect } from "./ui.js";
import { dashboard } from "./dashboard.js";
import { send } from "./send.js";
import { receive } from "./receive.js";
import { names } from "./names.js";

const NAV = [["/", "Dashboard"], ["/send", "Send"], ["/receive", "Receive"], ["/names", "Names"]];
const toggleTheme = initTheme();

const routes = [
  [/^\/$/, dashboard],
  [/^\/send\/?$/, send],
  [/^\/receive\/?$/, receive],
  [/^\/names\/?$/, names],
];

let shell;
function buildShell() {
  const nav = h("nav", { class: "nav" }, NAV.map(([href, label]) => h("a", { href }, label)));
  const walletBox = h("div", { class: "dropdown", id: "wallet-box" });
  const themeBtn = h("button", { class: "icon-btn", "aria-label": "Toggle theme", onclick: () => { const t = toggleTheme(); themeBtn.replaceChildren(icon(t === "light" ? "moon" : "sun", 18)); } }, icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun", 18));
  const header = h("header", { class: "top" }, h("a", { class: "brand", href: "/" }, h("span", { class: "mark" }, "A"), h("span", { class: "word" }, "ADDR Wallet")), nav, h("div", { class: "top-actions" }, themeBtn, walletBox));
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
  const path = location.pathname.replace(/\/+$/, "") || "/";
  shell.nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === path));
  for (const [re, fn] of routes) {
    if (re.test(path)) { fn(shell.main).catch((e) => mount(shell.main, h("div", { class: "card" }, h("h3", null, "Something went wrong"), h("p", { class: "muted" }, e.message)))); return; }
  }
  mount(shell.main, h("div", { class: "empty" }, h("h1", null, "Page not found"), h("a", { class: "btn", href: "/" }, "Go home")));
}

buildShell();
router.render = render;
wallet.listeners.push(render);
render();
autoConnect(); // silently resumes the last-connected wallet, never prompts

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
