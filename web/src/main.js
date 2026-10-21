import { h, mount, $, icon, btn, auth, loadAuth, loadChain, router, navigate, initTheme, toast, copy, short, api, query } from "./lib.js";
import { wallet, openConnect, disconnect, isConnected, autoConnect } from "./wallet.js";
import { loginView, verifyLinkView } from "./auth.js";
import { home } from "./home.js";
import { names } from "./names.js";
import { send } from "./send.js";
import { profile } from "./profile.js";
import { invoice } from "./invoice.js";
import { dev } from "./dev.js";
import { enterprise } from "./enterprise.js";
import { admin } from "./admin.js";
import { legal } from "./legal.js";
import { apidocs } from "./apidocs.js";

const NAV = [["/", "Search"], ["/names", "My names"], ["/send", "Send"], ["/dev", "Developers"], ["/enterprise", "Enterprise"]];
const toggleTheme = initTheme();

// pages that need an account. Everything else (search, send, profiles) stays open without signing in.
const PROTECTED = { "/dev": "Sign in to use the developer console, API keys and usage analytics.", "/enterprise": "Sign in to issue names to your customers.", "/admin": "Sign in with an administrator email." };

const routes = [
  [/^\/$/, (r) => home(r)],
  [/^\/names\/?$/, (r) => names(r)],
  [/^\/send\/?$/, (r) => send(r)],
  [/^\/name\/(.+)$/, (r, m) => profile(r, m[1])],
  [/^\/invoice\/([0-9a-f]+)\/?$/, (r, m) => invoice(r, m[1])],
  [/^\/dev\/?$/, (r) => dev(r)],
  [/^\/enterprise\/?$/, (r) => enterprise(r)],
  [/^\/admin\/?$/, (r) => admin(r)],
  [/^\/legal\/([a-z-]+)\/?$/, (r, m) => legal(r, m[1])],
  [/^\/api\/?$/, (r) => apidocs(r)],
  [/^\/login\/?$/, (r) => mount(r, loginView(safeNext(query().next)))],
  [/^\/auth\/verify\/?$/, (r) => mount(r, verifyLinkView())],
];
const safeNext = (n) => (n && /^\/[a-zA-Z0-9/_\-.]*$/.test(n) && !n.startsWith("//") ? n : "/dev");

let shell;
function buildShell() {
  const nav = h("nav", { class: "nav", id: "nav", "aria-label": "Main" }, NAV.map(([href, label]) => h("a", { href }, label)));
  const menu = h("button", { class: "icon-btn menu-btn", "aria-label": "Menu", "aria-expanded": "false", onclick: () => { const o = nav.classList.toggle("open"); menu.setAttribute("aria-expanded", String(o)); } }, icon("menu", 20));
  const walletBox = h("div", { class: "dropdown", id: "wallet-box" });
  const acctBox = h("div", { class: "dropdown", id: "acct-box" });
  const themeBtn = h("button", { class: "icon-btn", "aria-label": "Toggle color theme", onclick: () => { const t = toggleTheme(); themeBtn.replaceChildren(icon(t === "light" ? "moon" : "sun", 18)); } }, icon(document.documentElement.dataset.theme === "light" ? "moon" : "sun", 18));
  const header = h("header", { class: "top" }, h("a", { class: "brand", href: "/" }, h("span", { class: "mark" }, "A"), h("span", { class: "word" }, "ADDR")), nav, h("div", { class: "top-actions" }, themeBtn, walletBox, acctBox, menu));
  const main = h("main", { id: "app", tabindex: "-1" });
  const col = (title, links) => h("div", null, h("h4", null, title), links.map(([href, label, ext]) => h("a", { href, target: ext ? "_blank" : null, rel: ext ? "noopener" : null }, label)));
  const foot = h("footer", { class: "foot" }, h("div", { class: "foot-grid" },
    h("div", null, h("a", { class: "brand", href: "/", style: "margin-bottom:12px" }, h("span", { class: "mark" }, "A"), h("span", { class: "word" }, "ADDR")), h("p", { class: "muted", style: "font-size:13.5px;max-width:300px;margin:0" }, "Readable names for crypto addresses. Records are public and verified on the chain you use.")),
    col("Product", [["/", "Search names"], ["/send", "Send"], ["/names", "My names"], ["/dev", "Developers"], ["/enterprise", "Enterprise"]]),
    col("Resources", [["/api", "API reference"], ["/docs/", "Specification", true], ["/docs/integration-guide.md", "Integration guide", true], ["/openapi.json", "Raw OpenAPI", true], ["/legal/report", "Report a name"]]),
    col("Legal", [["/legal/terms", "Terms of Service"], ["/legal/privacy", "Privacy Policy"], ["/legal/privacy-ko", "개인정보 처리방침"], ["/legal/acceptable-use", "Acceptable Use"], ["/legal/refunds", "Payments and refunds"], ["/legal/risks", "Risk disclosure"], ["/legal/name-policy", "Name policy"], ["/legal/cookies", "Cookies"]])),
    h("div", { class: "foot-base" }, h("span", null, "A resolved name is not an endorsement of the recipient. Always check the address before you send."), h("span", null, "\u00a9 ADDR")));
  mount($("#root"), header, main, foot);
  document.addEventListener("click", (e) => { if (!e.target.closest?.(".dropdown")) document.querySelectorAll(".dropdown-panel").forEach((p) => p.remove()); if (e.target.closest?.("#nav a")) nav.classList.remove("open"); });
  shell = { main, nav, walletBox, acctBox };
}

function dropdown(box, trigger, items) {
  box.querySelector(".dropdown-panel")?.remove();
  mount(box, trigger);
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = box.querySelector(".dropdown-panel");
    document.querySelectorAll(".dropdown-panel").forEach((p) => p.remove());
    if (open) return;
    const panel = h("div", { class: "dropdown-panel", role: "menu" }, items());
    box.append(panel);
  });
}

function drawWallet() {
  const box = shell.walletBox;
  if (!isConnected()) {
    mount(box, btn(h("span", { class: "row tight" }, icon("wallet", 16), h("span", { class: "lbl" }, "Connect wallet")), async () => { await openConnect(); }, "secondary small"));
    return;
  }
  const t = h("button", { class: "btn secondary small", type: "button", "aria-haspopup": "menu" }, h("span", { class: "pill ok", style: "padding:1px 8px" }, h("span", { class: "dot" })), h("span", { class: "mono", style: "font-size:13px" }, short(wallet.address, 4)), icon("chev", 14));
  dropdown(box, t, () => [
    h("div", { class: "meta" }, h("div", { style: "font-weight:650;color:var(--text)" }, wallet.mode === "manual" ? "Manual address" : wallet.label), h("div", { class: "mono", style: "margin-top:4px" }, wallet.address), h("div", { class: "faint", style: "margin-top:4px" }, wallet.mode === "manual" ? "Transactions are shown as fields you send yourself" : `Chain ${wallet.chainId}`)),
    h("div", { class: "sep" }),
    h("button", { class: "item", onclick: () => copy(wallet.address) }, icon("copy", 16), "Copy address"),
    h("button", { class: "item", onclick: async () => { disconnect(); await openConnect(); } }, icon("refresh", 16), "Switch wallet"),
    h("a", { class: "item", href: "/names" }, icon("list", 16), "My names"),
    h("div", { class: "sep" }),
    h("button", { class: "item", onclick: () => { disconnect(); toast("Wallet disconnected"); } }, icon("logout", 16), "Disconnect"),
  ]);
}

function drawAccount() {
  const box = shell.acctBox;
  if (!auth.user) { mount(box, h("a", { class: "btn small", href: `/login?next=${encodeURIComponent(location.pathname)}` }, h("span", { class: "row tight" }, icon("user", 16), h("span", { class: "lbl" }, "Sign in")))); return; }
  const t = h("button", { class: "icon-btn", "aria-label": "Account menu", "aria-haspopup": "menu", style: "background:var(--grad);color:#fff;border:0;font-weight:700" }, auth.user.email[0].toUpperCase());
  dropdown(box, t, () => [
    h("div", { class: "meta" }, h("div", { style: "font-weight:650;color:var(--text)" }, auth.user.email), h("div", { class: "faint", style: "margin-top:2px" }, `${(auth.tenant?.plan || "free").toUpperCase()} plan`)),
    h("div", { class: "sep" }),
    h("a", { class: "item", href: "/dev" }, icon("code", 16), "Developer console"),
    h("a", { class: "item", href: "/dev?tab=keys" }, icon("key", 16), "API keys"),
    h("a", { class: "item", href: "/enterprise" }, icon("layers", 16), "Enterprise"),
    auth.isAdmin ? h("a", { class: "item", href: "/admin" }, icon("shield", 16), "Admin") : null,
    h("div", { class: "sep" }),
    h("button", { class: "item", onclick: async () => { await api("POST", "/v1/auth/logout", {}); await loadAuth(); toast("Signed out"); navigate("/"); } }, icon("logout", 16), "Sign out"),
  ]);
}

async function render() {
  const root = shell.main;
  const path = location.pathname.replace(/\/+$/, "") || "/";
  shell.nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === path || (a.getAttribute("href") === "/" && path.startsWith("/name/"))));
  root.classList.toggle("wide", path === "/enterprise" || path === "/admin");
  root.classList.toggle("landing", path === "/");
  document.title = path === "/" ? "ADDR - Your name is your address" : path === "/api" ? "API reference - ADDR" : `${path.slice(1).split("/")[0].replace(/^./, (c) => c.toUpperCase())} - ADDR`;
  if (!auth.loaded) await loadAuth();
  if (PROTECTED[path] && !auth.user) { mount(root, loginView(path, PROTECTED[path])); return; }
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      try { await fn(root, m); } catch (e) { mount(root, h("div", { class: "card" }, h("h3", null, "Something went wrong"), h("p", { class: "muted" }, e.message || String(e)))); console.error(e); }
      root.focus({ preventScroll: true });
      return;
    }
  }
  mount(root, h("div", { class: "empty" }, h("h1", null, "Page not found"), h("p", null, "That page does not exist."), h("a", { class: "btn", href: "/" }, "Go home")));
}

buildShell();
router.render = render;
wallet.listeners.push(() => { drawWallet(); if (/^\/(names|send)/.test(location.pathname)) render(); });
auth.listeners.push(() => { drawAccount(); });
drawWallet(); drawAccount();
loadChain().catch(() => toast("API unreachable", "bad"));
loadAuth().finally(() => { drawAccount(); render(); });
autoConnect(); // silently resumes the last-connected wallet, if any — never prompts
