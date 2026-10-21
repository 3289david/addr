import { h, mount, icon, btn, field, alert, api, auth, coin, pill, statusPill, kv, tabs, table, copy, copyLine, skeleton, empty, fmtTime, timeAgo, short, toast, confirmDialog, modal, navigate, query } from "./lib.js";
import { wallet, requireWallet, contracts } from "./wallet.js";
import { NETWORKS, validateAddress } from "../../packages/core/src/index.ts";

export async function enterprise(root) {
  const tab = query().tab || "overview";
  const go = (t) => navigate(t === "overview" ? "/enterprise" : `/enterprise?tab=${t}`);
  mount(root, h("div", { class: "page-head" }, h("h1", null, "Enterprise console"), h("p", null, "Issue names to your customers, attach deposit addresses, and get signed events. Customers always keep ownership of their names.")),
    h("div", { style: "margin-bottom:22px" }, tabs([["overview", "Overview"], ["namespaces", "Namespaces"], ["issue", "Issue names"], ["issued", "Issued"], ["webhooks", "Webhooks"], ["billing", "Plan and billing"]], tab, go)), h("div", { id: "ent" }, skeleton(4)));
  const body = root.querySelector("#ent");
  try { await ({ overview, namespaces, issue, issued, webhooks, billing }[tab] || overview)(body); }
  catch (e) { mount(body, alert("bad", e.message)); }
}

const stat = (v, l, sub) => h("div", { class: "card tight stat" }, h("div", { class: "l" }, l), h("div", { class: "v" }, String(v)), sub ? h("div", { class: "faint", style: "font-size:12.5px" }, sub) : null);

async function overview(body) {
  const [d, ns, exp] = await Promise.all([api("GET", "/v1/enterprise/dashboard"), api("GET", "/v1/enterprise/namespaces"), api("GET", "/v1/enterprise/expiring?days=60")]);
  const max = Math.max(1, ...d.usageByDay.map((x) => x.requests));
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "grid four" }, stat(d.plan.toUpperCase(), "Plan"), stat(d.issuedActive, "Active issued names", `${d.issuedTotal} total`), stat(d.customers, "Customers"), stat(d.issuedLast24h, "Issued in 24h"), stat(d.webhooks, "Webhooks", d.deliveriesFailed ? `${d.deliveriesFailed} failed deliveries` : "all delivering"), stat(d.openInvoices, "Open invoices")),
    exp.expiring.length ? alert("warn", h("b", null, "Namespaces expiring soon: "), exp.expiring.map((e) => `${e.name} (${e.status}, ${fmtTime(e.expiresAt)})`).join(", "), ". Renew them so subnames keep working.") : null,
    ns.namespaces.length ? null : alert("info", "Start by claiming a namespace you own. ", h("a", { href: "/enterprise?tab=namespaces" }, "Claim a namespace")),
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "API requests"), d.usageByDay.length ? h("div", { class: "bars" }, [...d.usageByDay].reverse().map((x) => h("div", { class: "b", title: `${x.day}: ${x.requests}`, style: `height:${Math.max(3, (x.requests / max) * 100)}%` }))) : h("div", { class: "muted" }, "No requests recorded yet."))));
}

async function namespaces(body) {
  const draw = async () => {
    const list = (await api("GET", "/v1/enterprise/namespaces")).namespaces;
    const name = h("input", { placeholder: "acme.addr", spellcheck: "false", autocapitalize: "off", "aria-label": "Namespace" });
    const claim = btn("Claim with wallet signature", async () => {
      if (!(await requireWallet())) return;
      const n = name.value.trim().toLowerCase();
      const { message } = await api("GET", `/v1/enterprise/claim-message?name=${encodeURIComponent(n)}`);
      const signature = await wallet.signer.signMessage(message);
      await api("POST", "/v1/enterprise/namespaces", { name: n, signature });
      toast("Namespace claimed"); draw();
    });
    mount(body, h("div", { class: "stack lg" },
      h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Claim a namespace"), h("p", { class: "muted", style: "margin:0" }, "Prove you control a name you own by signing a message with its owner wallet. No keys are shared. Then approve the relayer for that single name so it can create subnames on your behalf."),
        h("div", { class: "row", style: "align-items:flex-end" }, h("div", { class: "grow", style: "flex:2" }, field("Name you own", name)), claim)),
      list.length ? h("div", { class: "stack" }, list.map((n) => nsRow(n, draw))) : empty("layers", "No namespaces", "Claim one to issue subnames like alice.acme.addr.")));
  };
  await draw();
}

function nsRow(n, redraw) {
  const box = h("div", { class: "card stack" }, h("div", { class: "row between" }, h("div", { style: "font-size:18px;font-weight:700" }, n.name), h("span", { class: "muted" }, "checking...")));
  api("GET", `/v1/enterprise/namespaces/${encodeURIComponent(n.name)}`).then((s) => {
    mount(box, h("div", { class: "row between" }, h("div", { style: "font-size:18px;font-weight:700" }, s.name), h("div", { class: "row tight" }, statusPill(s.status), s.ownershipCurrent ? pill("ownership verified", "ok", true) : pill("owner changed", "bad", true), s.relayerApproved ? pill("relayer approved", "ok", true) : pill("relayer not approved", "warn", true))),
      kv([["Owner wallet", h("span", { class: "mono" }, s.ownerWallet)], ["Expires", fmtTime(s.expiresAt)], ["Relayer", h("span", { class: "mono" }, s.relayer || "none")]], true),
      !s.relayerApproved && s.setup ? h("div", { class: "stack" }, alert("warn", s.setup.instruction), btn("Approve relayer (wallet transaction)", async () => {
        if (!(await requireWallet())) return;
        const { registry } = await contracts();
        await (await registry.approveName(s.node, s.relayer, true)).wait();
        toast("Relayer approved"); redraw();
      })) : null);
  }).catch((e) => mount(box, alert("bad", e.message)));
  return box;
}

async function issue(body) {
  const list = (await api("GET", "/v1/enterprise/namespaces")).namespaces;
  if (!list.length) return mount(body, empty("layers", "Claim a namespace first", "You need a namespace you own before issuing subnames.", h("a", { class: "btn", href: "/enterprise?tab=namespaces" }, "Claim a namespace")));
  const ns = h("select", { "aria-label": "Namespace" }, list.map((n) => h("option", { value: n.name }, n.name)));
  const label = h("input", { placeholder: "alice", autocapitalize: "off" });
  const cust = h("input", { placeholder: "your customer id" });
  const owner = h("input", { placeholder: "customer wallet 0x...", spellcheck: "false" });
  const recs = Object.fromEntries(NETWORKS.map((n) => [n.id, h("input", { placeholder: `${n.name} deposit address (optional)`, spellcheck: "false", "aria-label": `${n.name} address` })]));
  const out = h("div");
  const go = btn("Issue subname", async () => {
    const records = {};
    for (const n of NETWORKS) { const v = recs[n.id].value.trim(); if (v) { const c = validateAddress(n.id, v); if (!c.valid) throw new Error(`${n.name}: ${c.error}`); records[n.id] = v; } }
    const r = await api("POST", "/v1/enterprise/subnames", { namespace: ns.value, label: label.value.trim().toLowerCase(), customerId: cust.value.trim(), owner: owner.value.trim(), records });
    mount(out, alert("ok", h("b", null, `Issued ${r.name}`), h("div", { class: "mono", style: "margin-top:4px" }, `tx ${r.tx}`)));
    label.value = "";
  });
  const csv = h("textarea", { placeholder: "label,customerId,ownerWallet[,bitcoinAddress[,ethereumAddress]]\nalice,c-1,0x...\nbob,c-2,0x...", "aria-label": "CSV rows" });
  const bout = h("div");
  const bulk = btn("Issue batch", async () => {
    const items = csv.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [label, customerId, o, bitcoin, ethereum] = l.split(",").map((s) => s.trim()); const records = {}; if (bitcoin) records.bitcoin = bitcoin; if (ethereum) records.ethereum = ethereum; return { namespace: ns.value, label, customerId, owner: o, records }; });
    const r = await api("POST", "/v1/enterprise/subnames/bulk", { items });
    mount(bout, alert(r.failed ? "warn" : "ok", `${r.succeeded} issued, ${r.failed} failed`, r.results.filter((x) => !x.ok).map((x) => h("div", { class: "bad" }, `${x.label}: ${x.error.message}`))));
  }, "secondary");
  mount(body, h("div", { class: "grid two" },
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Single subname"), field("Namespace", ns), h("div", { class: "grid" }, field("Label", label), field("Customer id", cust)), field("Customer wallet", owner, "This address becomes the on-chain owner."),
      h("div", { class: "stack" }, h("div", { class: "faint", style: "font-size:12.5px;font-weight:600" }, "DEPOSIT ADDRESS RECORDS (written in the same transaction)"), Object.values(recs)), go, out),
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Bulk issue (CSV)"), h("p", { class: "muted", style: "margin:0" }, "Uses the namespace selected on the left. One row per customer."), csv, bulk, bout)));
}

async function issued(body) {
  const list = (await api("GET", "/v1/enterprise/names?limit=200")).names;
  if (!list.length) return mount(body, empty("inbox", "Nothing issued yet", "Names you issue to customers show up here.", h("a", { class: "btn", href: "/enterprise?tab=issue" }, "Issue a name")));
  mount(body, table(["Name", "Customer", "Owner", "Kind", "Status", "Created"], list.map((n) => h("tr", null, h("td", null, h("a", { href: `/name/${n.name}` }, n.name)), h("td", null, n.customerId), h("td", { class: "mono" }, short(n.owner, 6)), h("td", null, n.kind), h("td", null, statusPill(n.status)), h("td", { class: "nowrap" }, timeAgo(n.created))))));
}

async function webhooks(body) {
  const draw = async () => {
    const [{ webhooks: list }, { namespaces: nss }] = await Promise.all([api("GET", "/v1/webhooks"), api("GET", "/v1/enterprise/namespaces")]);
    const url = h("input", { placeholder: "https://your-service.example/addr-webhook", spellcheck: "false", "aria-label": "Endpoint URL" });
    const scope = h("select", { "aria-label": "Scope" }, h("option", { value: "" }, "All my names and invoices"), nss.map((n) => h("option", { value: n.name }, n.name)));
    const events = h("input", { value: "*", "aria-label": "Events" });
    const add = btn("Add webhook", async () => {
      const r = await api("POST", "/v1/webhooks", { url: url.value.trim(), events: events.value.split(",").map((s) => s.trim()).filter(Boolean), namespace: scope.value || undefined });
      const m = modal({ title: "Webhook created", body: h("div", { class: "stack" }, alert("warn", "Copy the signing secret now. It is shown once."), copyLine(r.secret, "Copy secret"), h("div", { class: "help" }, "Verify the X-Addr-Signature header (HMAC-SHA256 over timestamp.body) with the SDK's verifyWebhook.")), footer: [btn("Done", () => m.close(true))] });
      m.onClose = () => draw();
    });
    mount(body, h("div", { class: "stack lg" },
      h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Add a webhook"), h("div", { class: "grid" }, field("Endpoint (https)", url), field("Scope", scope), field("Events", events, "* or comma-separated: subname.created, record.changed, name.transferred, invoice.paid ...")), h("div", null, add)),
      list.length ? h("div", { class: "stack" }, list.map((w) => h("div", { class: "card tight stack" }, h("div", { class: "row between" }, h("div", { class: "mono" }, w.url), h("div", { class: "row tight" }, pill(w.namespace || "all names", "info"), pill(w.active ? "active" : "disabled", w.active ? "ok" : "bad", true))),
        h("div", { class: "row tight" }, btn("Delivery log", async () => {
          const d = (await api("GET", `/v1/webhooks/${w.id}/deliveries`)).deliveries;
          const m = modal({ title: "Recent deliveries", wide: true, body: d.length ? table(["Event", "Status", "Attempts", "Error", ""], d.slice(0, 30).map((x) => h("tr", null, h("td", null, x.type), h("td", null, statusPill(x.status === "failed" ? "failed" : x.status === "delivered" ? "sent" : "pending")), h("td", null, x.attempts), h("td", { class: "muted" }, x.lastError || "-"), h("td", null, x.status === "failed" ? btn("Replay", async () => { await api("POST", `/v1/webhooks/${w.id}/deliveries/${x.id}/retry`, {}); toast("Queued for retry"); m.close(true); }, "ghost small") : null)))) : h("div", { class: "muted" }, "No deliveries yet.") });
        }, "ghost small"), btn("Remove", async () => { if (await confirmDialog("Remove webhook?", "No further events will be sent to this URL.", "Remove", true)) { await api("DELETE", `/v1/webhooks/${w.id}`); draw(); } }, "ghost small")))))
        : empty("bolt", "No webhooks", "Receive signed events when names are issued, change owner or update records.")));
  };
  await draw();
}

async function billing(body) {
  const [pricing, d, inv] = await Promise.all([api("GET", "/v1/pricing"), api("GET", "/v1/enterprise/dashboard"), api("GET", "/v1/enterprise/invoices")]);
  const methods = pricing.acceptedPaymentMethods || [];
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "grid four" }, pricing.plans.map((p) => {
      const cur = p.id === d.plan;
      const sel = h("select", { "aria-label": "Pay with" }, methods.map((m, i) => h("option", { value: i }, `${m.asset}${m.standard !== "native" ? " " + m.standard : ""} on ${m.networkName}`)));
      return h("div", { class: "card stack" + (cur ? " soft" : ""), style: cur ? "outline:2px solid var(--accent)" : "" }, h("div", { class: "row between" }, h("h3", { style: "margin:0" }, p.name), cur ? pill("current", "ok", true) : null),
        h("div", { class: "price-big", style: "font-size:24px" }, p.priceUsdPerMonth ? `$${p.priceUsdPerMonth.toLocaleString()}` : p.id === "enterprise" ? "Custom" : "Free", p.priceUsdPerMonth ? h("span", { class: "muted", style: "font-size:14px;font-weight:500" }, " / month") : null),
        h("div", { class: "muted", style: "font-size:13.5px" }, p.dailyRequests ? `${p.dailyRequests.toLocaleString()} requests per day` : "Negotiated limits", h("br"), p.maxSubnames ? `${p.maxSubnames.toLocaleString()} issued names` : "Unlimited issuing"),
        p.priceUsdPerMonth && methods.length ? h("div", { class: "stack" }, sel, btn("Pay for 30 days", async () => { const m = methods[Number(sel.value)]; const i = await api("POST", "/v1/enterprise/plan", { plan: p.id, network: m.network, asset: m.asset, standard: m.standard }); navigate(`/invoice/${i.id}`); }, "small"))
          : p.priceUsdPerMonth ? h("div", { class: "help" }, "No payment network is enabled on this deployment.") : null);
    })),
    h("div", null, h("h2", { style: "margin-top:0" }, "Invoices"), inv.invoices.length ? table(["Id", "For", "Amount", "Status", "Created"], inv.invoices.map((i) => h("tr", null, h("td", null, h("a", { href: `/invoice/${i.id}`, class: "mono" }, short(i.id, 5))), h("td", null, i.name || i.plan || i.kind), h("td", null, `${i.amount} ${i.asset}`), h("td", null, statusPill(i.status)), h("td", { class: "nowrap" }, timeAgo(i.createdAt))))) : empty("list", "No invoices", "Plan and name payments are listed here."))));
}
void coin; void auth; void copy;
