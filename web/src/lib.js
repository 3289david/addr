// Shared UI toolkit: DOM builder, icons, toasts, modals, router, API client, session state.
import qrcode from "qrcode-generator";

// ------------------------------------------------------------------- DOM
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "html") el.innerHTML = v; // only ever called with our own static SVG strings
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...kids) {
  clear(el);
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}

// ----------------------------------------------------------------- icons
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  wallet: '<path d="M3 7a3 3 0 0 1 3-3h12v4"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H6a3 3 0 0 1-3-3"/><circle cx="16.5" cy="14" r="1.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="m10 13 4-4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 18h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5"/><path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
};
export function icon(name, size = 18) {
  const s = h("span", { class: "ico-wrap", style: `display:inline-flex;width:${size}px;height:${size}px;flex:none` });
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
  return s;
}

// ------------------------------------------------------------ small widgets
const COIN = { BTC: "#f7931a", LTC: "#345d9d", ETH: "#627eea", POL: "#8247e5", BNB: "#d6a41c", TRX: "#e8392f", SOL: "#7c4dff", USDT: "#26a17b", USDC: "#2775ca", base: "#0052ff", arbitrum: "#28a0f0", optimism: "#ff0420", ethereum: "#627eea", bitcoin: "#f7931a", litecoin: "#345d9d", polygon: "#8247e5", bsc: "#d6a41c", tron: "#e8392f", solana: "#7c4dff" };
const COIN_LABEL = { bitcoin: "BTC", litecoin: "LTC", ethereum: "ETH", base: "BASE", arbitrum: "ARB", optimism: "OP", polygon: "POL", bsc: "BNB", tron: "TRX", solana: "SOL" };
export function coin(key, lg = false) {
  const label = COIN_LABEL[key] || String(key).slice(0, 4).toUpperCase();
  return h("span", { class: "coin" + (lg ? " lg" : ""), style: `--c:${COIN[key] || COIN[label] || "#6b7280"}`, title: key }, label.slice(0, 4));
}

export function pill(text, kind = "", dot = false) { return h("span", { class: `pill ${kind}` }, dot ? h("span", { class: "dot" }) : null, text); }
export function statusPill(status) {
  const k = status === "active" || status === "completed" || status === "sent" || status === "available" ? "ok" : status === "grace" || status === "pending" || status === "confirming" ? "warn" : status === "ticket" ? "info" : "bad";
  return pill(status, k, true);
}
export function alert(kind, ...kids) {
  const ic = kind === "ok" ? "check" : kind === "bad" ? "warn" : kind === "warn" ? "warn" : "info";
  return h("div", { class: `alert ${kind}`, role: kind === "bad" ? "alert" : "status" }, icon(ic, 18), h("div", { class: "body" }, kids));
}
export function field(label, input, help) {
  return h("label", { class: "field" }, h("span", { class: "lab" }, label), input, help ? h("div", { class: "help" }, help) : null);
}
export function kv(pairs, compact = false) {
  return h("div", { class: "kv" + (compact ? " compact" : "") }, pairs.filter(Boolean).flatMap(([k, v]) => [h("div", null, k), h("div", null, v)]));
}
export function skeleton(lines = 3) {
  return h("div", { class: "stack" }, Array.from({ length: lines }, (_, i) => h("div", { class: "skeleton", style: `height:${i === 0 ? 28 : 16}px;width:${i === 0 ? 40 : 90 - i * 12}%` })));
}
export function empty(iconName, title, text, action) {
  return h("div", { class: "empty card flat" }, icon(iconName, 40), h("h3", null, title), h("p", null, text), action || null);
}
export function table(head, rows) {
  return h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))), h("tbody", null, rows)));
}
export function tabs(items, current, onPick) {
  return h("div", { class: "segmented", role: "tablist" }, items.map(([k, label]) => h("button", { role: "tab", class: k === current ? "on" : "", "aria-selected": String(k === current), onclick: () => onPick(k) }, label)));
}
export function steps(names, cur) {
  return h("div", { class: "steps" }, names.map((n, i) => h("div", { class: "step " + (i < cur ? "done" : i === cur ? "cur" : "") }, h("span", { class: "n" }, i < cur ? "✓" : String(i + 1)), n)));
}
export function btn(label, onclick, cls = "") {
  const b = h("button", { class: `btn ${cls}`, type: "button" }, label);
  if (onclick) b.addEventListener("click", () => run(b, onclick));
  return b;
}

/** Runs an async handler with a busy state and a readable error toast. Never rejects. */
export async function run(button, fn) {
  if (button) {
    if (button.getAttribute("aria-busy") === "true") return;
    button._html = button.innerHTML; button.setAttribute("aria-busy", "true"); button.disabled = true;
    button.prepend(h("span", { class: "spinner" }), " ");
  }
  try { return await fn(); }
  catch (e) { if (e?.code !== "CANCELLED") toast(errText(e), "bad"); return undefined; }
  finally { if (button) { button.disabled = false; button.removeAttribute("aria-busy"); if (button._html != null) button.innerHTML = button._html; } }
}

const ERR_NAMES = {
  InvalidLabel: "Invalid name: use a-z, 0-9 and single hyphens inside the name", ReservedName: "This name is reserved",
  LengthNotOpen: "Names of this length are not open for registration", BadDuration: "Invalid duration", CommitmentMissing: "Commitment not found",
  CommitmentTooNew: "Wait a few more seconds after committing", CommitmentExpired: "Commitment expired, start again",
  FreeAlreadyClaimed: "This wallet already claimed its free name", BadVoucher: "Free-claim voucher is invalid or expired",
  TokenNotAccepted: "Payment token not accepted", OracleStale: "Price oracle is stale, try again later", NameUnavailable: "This name is not available",
  NameLockedError: "This name is locked and cannot be transferred yet", NotAuthorised: "Your wallet is not authorised for this name",
  NameNotActive: "This name is not active (expired?)", DurationCap: "Maximum registration length is 5 years", Underpaid: "Payment is lower than the price",
};
export function errText(e) {
  const msg = e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);
  if (/user rejected|ACTION_REJECTED|denied/i.test(msg)) return "Request cancelled in your wallet";
  const blob = JSON.stringify(e?.info?.error ?? "") + msg;
  for (const [n, t] of Object.entries(ERR_NAMES)) if (blob.includes(n)) return t;
  return msg;
}

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = "ok") {
  let box = $("#toasts");
  if (!box) { box = h("div", { class: "toasts", id: "toasts", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: `toast ${kind}`, role: "status" }, icon(kind === "bad" ? "warn" : "check", 18), h("div", null, msg));
  box.append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3200);
}

// ---------------------------------------------------------------- modals
export function modal({ title, body, footer, wide = false, dismissible = true }) {
  const back = h("div", { class: "modal-back", role: "presentation" });
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title });
  let closed = false;
  const prev = document.activeElement;
  const api = {
    el: box,
    close(result) { if (closed) return; closed = true; back.remove(); document.removeEventListener("keydown", onKey); prev?.focus?.(); api.onClose?.(result); },
  };
  const onKey = (e) => { if (e.key === "Escape" && dismissible) api.close(undefined); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => { if (e.target === back && dismissible) api.close(undefined); });
  box.append(
    h("div", { class: "modal-head" }, h("h2", null, title), dismissible ? h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => api.close(undefined) }, icon("x", 18)) : null),
    h("div", { class: "modal-body" }, body), footer ? h("div", { class: "modal-foot" }, footer) : null);
  back.append(box);
  document.body.append(back);
  setTimeout(() => (box.querySelector("input, button.btn, button.option") || box).focus?.(), 30);
  return api;
}
/** Promise-based modal: resolves with the value passed to close(), or undefined when dismissed. */
export function ask(opts) {
  return new Promise((resolve) => {
    const m = modal(opts(resolve_(resolve)));
    function resolve_(r) { return (v) => { m.close(v); r(v); }; }
    m.onClose = (v) => resolve(v);
  });
}
export function confirmDialog(title, text, okLabel = "Confirm", danger = false) {
  return new Promise((resolve) => {
    const m = modal({ title, body: h("p", { class: "muted", style: "margin:0" }, text),
      footer: [btn("Cancel", () => m.close(false), "ghost"), btn(okLabel, () => m.close(true), danger ? "danger" : "")] });
    m.onClose = (v) => resolve(!!v);
  });
}

// ----------------------------------------------------------- clipboard/QR
export function copy(text, label = "Copied") {
  const done = () => toast(label);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const t = h("textarea", { style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select();
  try { document.execCommand("copy"); done(); } catch { toast("Copy failed", "bad"); }
  t.remove();
}
export function copyLine(text, label) {
  return h("div", { class: "copy-line" }, h("div", { class: "mono" }, text), h("button", { class: "btn ghost small", type: "button", onclick: () => copy(text) }, icon("copy", 15), label || "Copy"));
}
export function qr(text, size) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  const w = h("div", { class: "qr", role: "img", "aria-label": "QR code" });
  w.innerHTML = q.createSvgTag({ scalable: true, margin: 0 });
  if (size) w.firstChild.style.width = w.firstChild.style.height = size + "px";
  return w;
}

// -------------------------------------------------------------- formatting
export const short = (a, n = 6) => (a && a.length > 2 * n + 3 ? a.slice(0, n + 2) + "…" + a.slice(-n) : a);
export const fmtTime = (ts) => (Number(ts) > 0 ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-");
export const fmtDate = (ts) => (Number(ts) > 0 ? new Date(ts * 1000).toLocaleDateString(undefined, { dateStyle: "medium" }) : "-");
export function timeAgo(ts) {
  if (!(Number(ts) > 0)) return "-";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`;
}
export function daysLeft(ts) {
  if (!(Number(ts) > 0)) return "-"; const d = Math.ceil((ts - Date.now() / 1000) / 86400); return d > 0 ? `${d} days left` : "expired"; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- storage
export const store = {
  get(k, d) { try { const v = localStorage.getItem("addr." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("addr." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem("addr." + k); } catch { /* ignore */ } },
};

// --------------------------------------------------------------- session
export const auth = { loaded: false, user: null, csrf: "", tenant: null, isAdmin: false, listeners: [] };
export async function loadAuth() {
  const r = await fetch("/v1/auth/me", { headers: { accept: "application/json" } }).then((x) => x.json()).catch(() => ({ authenticated: false }));
  auth.loaded = true;
  auth.user = r.authenticated ? r.user : null;
  auth.csrf = r.csrf || "";
  auth.tenant = r.tenant || null;
  auth.isAdmin = !!r.isAdmin;
  auth.listeners.forEach((f) => f());
  return auth;
}

export async function api(method, path, body, opts = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && auth.csrf) headers["x-csrf-token"] = auth.csrf;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `Request failed (${res.status})`);
    e.code = json?.error?.code; e.status = res.status;
    if (res.status === 401 && e.code === "login_required") { auth.user = null; auth.listeners.forEach((f) => f()); }
    throw e;
  }
  return json;
}

export const chain = { info: null };
export async function loadChain() {
  if (!chain.info) chain.info = await api("GET", "/v1/contracts");
  return chain.info;
}

// ----------------------------------------------------------------- router
export const router = { routes: [], render: null };
export function navigate(path, replace = false) {
  if (path === location.pathname + location.search) return router.render?.();
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  window.scrollTo(0, 0);
  router.render?.();
}
export function link(href, children, cls = "") {
  const a = h("a", { href, class: cls }, children);
  return a;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank" || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.origin);
  if (url.origin !== location.origin) return;
  if (/^\/(v1|docs|openapi\.json)/.test(url.pathname)) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener("popstate", () => router.render?.());
export const query = () => Object.fromEntries(new URLSearchParams(location.search));

// ------------------------------------------------------------------ theme
export function initTheme() {
  const saved = store.get("theme", null);
  const apply = (t) => (document.documentElement.dataset.theme = t);
  apply(saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  return () => { const next = document.documentElement.dataset.theme === "light" ? "dark" : "light"; apply(next); store.set("theme", next); return next; };
}
