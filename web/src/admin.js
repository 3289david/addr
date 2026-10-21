import { h, mount, icon, btn, field, alert, api, pill, statusPill, tabs, table, skeleton, empty, fmtTime, timeAgo, short, toast, navigate, query, auth, copyLine, copy, kv } from "./lib.js";

// Base mainnet is live (deployments/8453.json), but ownership of registry/registrar is only *pending*
// acceptance by the timelock (Ownable2Step) — the Safe still needs to schedule() now and execute() after
// the 2-day delay. Hardcoded (not read from any API) since this is a one-time manual step. Remove this
// whole block once the handoff is confirmed complete (registry.owner() === registrar.owner() === timelock).
const BASE_DEPLOY = {
  adminMultisig: "0x08af8bc9d5b7f1DD0469c3A68DD40a26a05efb34", // your Safe on Base: admin + treasury
  deployer: "0x3F50d09906ddd2f6c14eA3594355AB79D169701b", // throwaway, single-use deploy key
  timelock: "0x6ce22A0c1bf0C021f9c3ae906F7Be77aD51e1679",
  registry: "0x2FDeE277BE3fAeCa14140617A90a71d8A903c78E",
  registrar: "0x0E0e5F4Db5aF477b42FAfBc6b14E31EF6FFE1386",
  // acceptOwnership() on each, pre-encoded for Safe's Transaction Builder app (To=timelock, Value=0, Data=below)
  scheduleRegistry: "0x01d5062a0000000000000000000000002fdee277be3faeca14140617a90a71d8a903c78e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a300000000000000000000000000000000000000000000000000000000000000000479ba509700000000000000000000000000000000000000000000000000000000",
  scheduleRegistrar: "0x01d5062a0000000000000000000000000e0e5f4db5af477b42fafbc6b14e31ef6ffe1386000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a300000000000000000000000000000000000000000000000000000000000000000479ba509700000000000000000000000000000000000000000000000000000000",
  executeRegistry: "0x134008d30000000000000000000000002fdee277be3faeca14140617a90a71d8a903c78e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000479ba509700000000000000000000000000000000000000000000000000000000",
  executeRegistrar: "0x134008d30000000000000000000000000e0e5f4db5af477b42fafbc6b14e31ef6ffe1386000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000479ba509700000000000000000000000000000000000000000000000000000000",
};

let tokenValue = ""; // optional static admin token, kept in memory only

const call = (m, p, b) => api(m, p, b, { bearer: tokenValue || undefined });

export async function admin(root) {
  const tab = query().tab || "stats";
  const go = (t) => navigate(`/admin?tab=${t}`);
  const tok = h("input", { type: "password", placeholder: "static admin token (optional)", autocomplete: "off", value: tokenValue, "aria-label": "Admin token" });
  mount(root, h("div", { class: "page-head" }, h("h1", null, "Admin"), h("p", null, "Operations view. Administrators cannot take names, edit records or change prices directly. Those changes go through the on-chain timelock and are listed here before they take effect.")),
    auth.isAdmin ? alert("ok", `Signed in as an administrator (${auth.user.email}).`) : h("div", { class: "card tight row", style: "margin-bottom:16px" }, h("div", { class: "grow" }, tok), btn("Use token", () => { tokenValue = tok.value; navigate("/admin", true); }), h("div", { class: "help" }, "Your email is not an administrator. Add it to ADMIN_EMAILS or use the static token.")),
    h("div", { style: "margin:18px 0 22px" }, tabs([["stats", "Overview"], ["infra", "Infrastructure"], ["timelock", "Timelock"], ["invoices", "Invoices"], ["mail", "Email"], ["reports", "Reports"], ["audit", "Audit log"]], tab, go)), h("div", { id: "adm" }, skeleton(4)));
  const body = root.querySelector("#adm");
  try { await ({ stats, infra, timelock, invoices, mail, reports, audit }[tab] || stats)(body); }
  catch (e) { mount(body, alert("bad", e.message)); }
}

const num = (l, v, sub) => h("div", { class: "card tight stat" }, h("div", { class: "l" }, l), h("div", { class: "v" }, String(v)), sub ? h("div", { class: "faint", style: "font-size:12.5px" }, sub) : null);

async function stats(body) {
  const s = await call("GET", "/v1/admin/stats");
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "grid four" }, num("Names", s.names.total), num("Active", s.names.active), num("Free tier", s.names.free), num("Subnames", s.names.subnames), num("Expiring in 30d", s.names.expiring30d), num("Registered 24h", s.registrations24h), num("Renewed 24h", s.renewals24h), num("Requests today", s.requestsToday)),
    h("div", { class: "grid four" }, num("Tenants", s.tenants), num("API keys", s.keys), num("Failed webhooks", s.webhookFailures)),
    s.invoices.length ? h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Invoices by status"), h("div", { class: "row tight" }, s.invoices.map((i) => pill(`${i.status}: ${i.c}`, i.status === "completed" ? "ok" : ["registration_failed", "needs_review", "underpaid"].includes(i.status) ? "bad" : "warn")))) : null));
}

function txField(label, data) {
  return h("div", { style: "margin-top:10px" },
    h("div", { class: "help", style: "margin:0 0 4px" }, label),
    h("pre", { style: "max-height:90px;font-size:11px;word-break:break-all;white-space:pre-wrap" }, data),
    btn("Copy data", () => copy(data, "Data copied"), "ghost small"));
}

async function infra(body) {
  const h2 = await call("GET", "/v1/admin/health");
  const safeUrl = `https://app.safe.global/home?safe=base:${BASE_DEPLOY.adminMultisig}`;
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "card stack" },
      h("div", { class: "row between" }, h("h3", { style: "margin:0" }, "Base mainnet: ownership handoff"), pill("pending", "warn", true)),
      h("p", { class: "muted", style: "margin:0" }, "Contracts are live. Registry and registrar ownership was transferred to the timelock but needs your Safe to accept it — a two-step process (Ownable2Step) via the timelock's schedule() then, after a 2-day delay, execute(). Until this completes the throwaway deployer key still holds admin rights over these two contracts."),
      kv([
        ["Your Safe (admin + treasury)", h("div", { class: "stack", style: "gap:6px" }, copyLine(BASE_DEPLOY.adminMultisig), h("a", { href: safeUrl, target: "_blank", rel: "noopener", class: "help" }, "Open in Safe →"))],
        ["Timelock", copyLine(BASE_DEPLOY.timelock)],
        ["Registry", copyLine(BASE_DEPLOY.registry)],
        ["Registrar", copyLine(BASE_DEPLOY.registrar)],
        ["Deployer (throwaway, holds admin until handoff completes)", copyLine(BASE_DEPLOY.deployer)],
      ])),
    h("div", { class: "card stack" },
      h("h3", { style: "margin:0" }, "Step 1 — schedule (do this now)"),
      h("p", { class: "muted", style: "margin:0" }, "In Safe → Apps → Transaction Builder: add both calls below as one batch, To = the timelock address above, Value = 0 for both, then send the batch and collect signatures."),
      txField("Data — accept registry ownership", BASE_DEPLOY.scheduleRegistry),
      txField("Data — accept registrar ownership", BASE_DEPLOY.scheduleRegistrar)),
    h("div", { class: "card stack" },
      h("h3", { style: "margin:0" }, "Step 2 — execute (wait 2 days after step 1, then do this)"),
      h("p", { class: "muted", style: "margin:0" }, "Same process: Transaction Builder, To = timelock, Value = 0, batch both. This finishes the handoff — after it executes, your Safe fully controls both contracts."),
      txField("Data — accept registry ownership", BASE_DEPLOY.executeRegistry),
      txField("Data — accept registrar ownership", BASE_DEPLOY.executeRegistrar)),
    h("div", { class: "stack" }, h("h3", { style: "margin:0" }, "RPC providers"), table(["Endpoint", "Status", "Latency", "Block", "Last hour OK / total"], h2.live.map((r) => { const s = h2.lastHour.find((x) => x.url === r.url);
      return h("tr", null, h("td", { class: "mono" }, r.url), h("td", null, pill(r.ok ? "up" : r.error || "down", r.ok ? "ok" : "bad", true)), h("td", null, `${r.ms} ms`), h("td", null, r.block ?? "-"), h("td", null, s ? `${s.ok} / ${s.n}` : "-")); })))));
}

async function timelock(body) {
  const t = await call("GET", "/v1/admin/timelock");
  mount(body, h("div", { class: "stack" }, h("div", { class: "mono muted" }, `Timelock ${t.timelock}`), t.operations.length ? table(["Time", "Operation", "Detail", "Tx"], t.operations.map((o) => h("tr", null, h("td", { class: "nowrap" }, fmtTime(o.ts)), h("td", null, o.type.replace("timelock.", "")), h("td", { class: "mono" }, JSON.stringify(o.data).slice(0, 140)), h("td", { class: "mono" }, short(o.tx, 6)))))
    : empty("shield", "No admin operations", "Scheduled and executed timelock actions appear here before they take effect.")));
}

async function invoices(body) {
  const draw = async () => {
    const r = await call("GET", "/v1/admin/invoices");
    mount(body, r.invoices.length ? table(["Id", "Kind", "For", "Amount", "Status", ""], r.invoices.slice(0, 100).map((i) => h("tr", null, h("td", { class: "mono" }, short(i.id, 5)), h("td", null, i.kind), h("td", null, i.name || i.plan || "-"), h("td", null, `${i.amount} ${i.asset}`), h("td", null, statusPill(i.status)),
      h("td", { class: "right" }, ["registration_failed", "paid"].includes(i.status) ? btn("Retry", async () => { await call("POST", `/v1/admin/invoices/${i.id}/retry`, {}); toast("Retried"); draw(); }, "ghost small") : null)))) : empty("list", "No invoices", ""));
  };
  await draw();
}

async function mail(body) {
  const m = await call("GET", "/v1/admin/mail");
  const d = m.dns;
  const row = (l, ok, text) => h("tr", null, h("td", null, l), h("td", null, pill(ok ? "found" : "missing", ok ? "ok" : "warn", true)), h("td", { class: "mono muted" }, text));
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, `Deliverability for ${d.domain}`), h("p", { class: "muted", style: "margin:0" }, `Transport: ${d.transport}. DKIM key configured: ${d.dkimConfigured ? "yes" : "no"}. Receivers reject or spam-folder unsigned mail from unknown hosts, so publish these records.`),
      table(["Record", "State", "Value"], [row("SPF (TXT)", d.spf?.length, d.spf?.join(" ") || "v=spf1 ip4:YOUR.SERVER.IP -all"), row(`DKIM (${d.domain})`, d.dkim?.length, d.dkim?.length ? (d.dkimMatchesKey === false ? "published key does not match DKIM_PRIVATE_KEY" : "matches") : "run: node scripts/mail-keys.cjs"), row("DMARC (TXT)", d.dmarc?.length, d.dmarc?.join(" ") || "v=DMARC1; p=quarantine"), row("MX", d.mx?.length, (d.mx || []).map((x) => x.exchange).join(", ") || "-")])),
    h("div", null, h("h3", null, "Outbox"), m.outbox.length ? table(["Time", "To", "Subject", "Status", "Attempts", "Via / error"], m.outbox.map((o) => h("tr", null, h("td", { class: "nowrap" }, timeAgo(o.created)), h("td", null, o.to), h("td", null, o.subject), h("td", null, statusPill(o.status)), h("td", null, o.attempts), h("td", { class: "muted" }, o.lastError || o.via || "-")))) : empty("mail", "No mail yet", ""))));
}

async function reports(body) {
  const draw = async () => {
    const r = (await call("GET", "/v1/admin/reports")).reports;
    mount(body, r.length ? table(["When", "Category", "Name", "Details", "Contact", "Status", ""], r.map((x) => h("tr", null, h("td", { class: "nowrap" }, timeAgo(x.created)), h("td", null, x.category), h("td", { class: "mono" }, x.name || "-"), h("td", { style: "max-width:320px" }, x.details), h("td", null, x.contact || "-"), h("td", null, statusPill(x.status === "closed" ? "sent" : x.status === "reviewing" ? "pending" : "failed")),
      h("td", { class: "right nowrap" }, x.status !== "reviewing" ? btn("Review", async () => { await call("PATCH", "/v1/admin/reports/" + x.id, { status: "reviewing" }); draw(); }, "ghost small") : null, " ", x.status !== "closed" ? btn("Close", async () => { await call("PATCH", "/v1/admin/reports/" + x.id, { status: "closed", note: prompt("Note (optional)") || undefined }); draw(); }, "ghost small") : null)))) : empty("inbox", "No reports", "Reports from the public form appear here."));
  };
  await draw();
}

async function audit(body) {
  const a = await call("GET", "/v1/admin/audit");
  mount(body, a.entries.length ? table(["Time", "Actor", "Action", "Target"], a.entries.map((e) => h("tr", null, h("td", { class: "nowrap" }, fmtTime(e.ts)), h("td", null, e.actor), h("td", null, e.action), h("td", { class: "mono" }, e.target || "-")))) : empty("list", "Empty audit log", ""));
}
void icon; void field;
