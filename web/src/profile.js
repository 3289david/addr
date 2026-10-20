import { h, mount, icon, btn, alert, api, coin, pill, statusPill, kv, qr, copyLine, copy, skeleton, empty, fmtTime, fmtDate, timeAgo, short, daysLeft } from "./lib.js";
import { paymentUri, getNetwork, explorerAddressUrl } from "../../packages/core/src/index.ts";

const EVENT_LABEL = { "name.registered": "Registered", "name.renewed": "Renewed", "name.transferred": "Transferred", "record.changed": "Address changed", "records.cleared": "Records cleared", "subname.created": "Subname created", "name.locked": "Locked", "name.resolver_changed": "Resolver changed", "text.changed": "Profile updated" };

export async function profile(root, rawName) {
  const name = decodeURIComponent(rawName).toLowerCase();
  mount(root, skeleton(5));
  let rec;
  try { rec = await api("GET", `/v1/names/${encodeURIComponent(name)}/records`); }
  catch (e) { return mount(root, h("div", { class: "page-head" }, h("h1", null, name)), alert("bad", e.message)); }
  const hist = await api("GET", `/v1/names/${encodeURIComponent(name)}/history`).catch(() => ({ events: [] }));
  const p = rec.profile || {};
  const active = rec.status === "active";
  const header = h("div", { class: "card" }, h("div", { class: "profile-head" },
    h("div", { class: "avatar" }, (rec.name[0] || "a").toUpperCase()),
    h("div", { class: "grow" },
      h("div", { class: "row tight" }, h("h1", { style: "font-size:clamp(21px,6.2vw,30px);margin:0;letter-spacing:-.02em;overflow-wrap:anywhere" }, rec.name), statusPill(rec.status)),
      p.display ? h("div", { style: "font-size:17px;margin-top:2px" }, p.display) : null,
      p.description ? h("p", { class: "muted", style: "margin:6px 0 0" }, p.description) : null),
    active ? h("div", { class: "row tight" }, h("a", { class: "btn", href: `/send?to=${rec.name}` }, icon("send", 16), "Send"), btn("Copy name", () => copy(rec.name), "ghost")) : null));
  const own = h("div", { class: "card" }, h("h3", null, h("span", { class: "row tight" }, icon("shield", 18), "Ownership, verified on-chain")), kv([
    ["Owner", h("span", { class: "mono" }, rec.owner || "-")],
    [rec.level === "sub" ? "Parent" : "Expires", rec.level === "sub" ? h("a", { href: `/name/${rec.parent}` }, rec.parent) : `${fmtDate(rec.expiresAt)}${rec.expiresAt ? ` (${daysLeft(rec.expiresAt)})` : ""}`],
    rec.lockedUntil ? ["Transfer lock", `until ${fmtDate(rec.lockedUntil)}`] : null,
    p.url ? ["Website", /^https?:\/\//.test(p.url) ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.url) : p.url] : null,
    ["Registry", h("span", { class: "mono" }, rec.contracts.registry)], ["Node", h("span", { class: "mono" }, rec.node)]], true));
  const notice = !active ? alert("warn", rec.status === "grace" ? "This name expired and is in its 30 day grace period. Resolution and sending are blocked until the owner renews it." : "This name is not active.") : null;

  const addrs = !rec.records.length
    ? empty("globe", "No addresses yet", active ? "The owner has not linked any addresses to this name." : "Records are hidden while a name is not active.")
    : h("div", { class: "grid two" }, rec.records.map((r) => {
      if (r.error) return alert("bad", `${r.network}: ${r.error}`);
      const net = getNetwork(r.network);
      const uri = paymentUri(net, net.assets[0], r.address);
      return h("div", { class: "card tight stack" },
        h("div", { class: "row between" }, h("div", { class: "row tight" }, coin(net.id, true), h("div", null, h("div", { style: "font-weight:700" }, r.networkName), h("div", { class: "muted", style: "font-size:12.5px" }, `Updated ${timeAgo(r.updatedAt)} (v${r.version})`))), r.recentlyChanged ? pill("changed < 24h", "warn", true) : null),
        h("div", { class: "row", style: "align-items:flex-start;flex-wrap:nowrap" }, qr(uri, 112), h("div", { class: "grow stack", style: "gap:8px" }, h("div", { class: "mono" }, r.address),
          h("div", { class: "muted", style: "font-size:12.5px" }, r.assets.map((a) => (a.standard === "native" ? a.symbol : `${a.symbol} ${a.standard}`)).join(", ")))),
        h("div", { class: "row tight" }, btn("Copy", () => copy(r.address), "ghost small"), h("a", { class: "btn ghost small", href: explorerAddressUrl(net, r.address), target: "_blank", rel: "noopener noreferrer" }, icon("ext", 14), "Explorer"), active ? h("a", { class: "btn secondary small", href: `/send?to=${rec.name}&network=${r.network}` }, "Send") : null));
    }));

  const ev = hist.events.filter((e) => EVENT_LABEL[e.type]);
  const timeline = ev.length ? h("div", { class: "card" }, h("div", { class: "timeline" }, ev.slice(0, 30).map((e) => h("div", { class: "ev" },
    h("div", { style: "font-weight:650" }, EVENT_LABEL[e.type]), h("div", { class: "muted", style: "font-size:13.5px" }, e.type === "record.changed" ? `${e.data.network || "coin " + e.data.coinType}: ${e.data.address || "cleared"}` : e.type === "name.transferred" ? `${short(e.data.from)} to ${short(e.data.to)}` : e.type === "text.changed" ? `${e.data.key}` : ""),
    h("div", { class: "faint", style: "font-size:12.5px" }, `${fmtTime(e.ts)}  ·  tx ${short(e.tx, 6)}`)))))
    : empty("list", "No indexed events yet", "History appears once the indexer has processed this name.");

  mount(root, header, notice ? h("div", { style: "margin-top:16px" }, notice) : null, h("div", { class: "stack lg", style: "margin-top:20px" }, own,
    h("div", null, h("h2", { style: "margin-top:8px" }, "Addresses"), addrs, h("p", { class: "muted", style: "margin-top:12px;font-size:13.5px" }, `Not supported yet: ${rec.unsupported.join(", ")}. Unsupported networks are never guessed.`)),
    h("div", null, h("h2", { style: "margin-top:8px" }, "Change history"), timeline)));
}
void copyLine;
