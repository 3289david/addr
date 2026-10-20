import { h, mount, icon, btn, field, alert, api, auth, pill, kv, tabs, table, copy, copyLine, skeleton, empty, fmtTime, timeAgo, modal, confirmDialog, loadChain, toast, navigate, query, loadAuth } from "./lib.js";

export async function dev(root) {
  const tab = query().tab || "overview";
  const go = (t) => navigate(t === "overview" ? "/dev" : `/dev?tab=${t}`);
  mount(root, h("div", { class: "page-head" },
    h("div", { class: "row between" }, h("div", null, h("h1", null, "Developer console"), h("p", null, `Signed in as ${auth.user.email}. Manage API keys, watch usage and try the API.`)),
      h("div", { class: "row tight" }, h("a", { class: "btn ghost", href: "/docs/", target: "_blank", rel: "noopener" }, icon("code", 16), "Specification"), h("a", { class: "btn ghost", href: "/openapi.json", target: "_blank", rel: "noopener" }, "OpenAPI")))),
    h("div", { style: "margin-bottom:22px" }, tabs([["overview", "Overview"], ["keys", "API keys"], ["console", "API console"], ["sdk", "SDK and CLI"], ["account", "Account"]], tab, go)),
    h("div", { id: "dev-body" }, skeleton(4)));
  const body = root.querySelector("#dev-body");
  try {
    if (tab === "overview") await overview(body);
    else if (tab === "keys") await keys(body);
    else if (tab === "console") await consoleTab(body);
    else if (tab === "sdk") await sdk(body);
    else await account(body);
  } catch (e) { mount(body, alert("bad", e.message)); }
}

async function overview(body) {
  const u = await api("GET", "/v1/account/usage");
  const keys = (await api("GET", "/v1/account/keys")).keys.filter((k) => !k.revoked);
  const days = [...u.days].reverse();
  const today = u.days[0]?.requests ?? 0;
  const total30 = u.days.reduce((n, d) => n + d.requests, 0);
  const errs30 = u.days.reduce((n, d) => n + d.errors, 0);
  const max = Math.max(1, ...days.map((d) => d.requests));
  const stat = (v, l, sub) => h("div", { class: "card tight stat" }, h("div", { class: "l" }, l), h("div", { class: "v" }, String(v)), sub ? h("div", { class: "faint", style: "font-size:12.5px" }, sub) : null);
  const pct = Math.min(100, Math.round((today / u.dailyLimit) * 100));
  mount(body, h("div", { class: "stack lg" },
    h("div", { class: "grid four" }, stat(u.plan.toUpperCase(), "Plan", u.dailyLimit < 1e11 ? `${u.dailyLimit.toLocaleString()} requests/day` : "Custom limits"), stat(today.toLocaleString(), "Requests today", `${pct}% of daily limit`), stat(total30.toLocaleString(), "Requests (30 days)", `${errs30.toLocaleString()} errors`), stat(keys.length, "Active API keys")),
    h("div", { class: "card stack" }, h("div", { class: "row between" }, h("h3", { style: "margin:0" }, "Requests per day"), h("span", { class: "muted", style: "font-size:13px" }, "last 30 days")),
      days.length ? h("div", { class: "bars", role: "img", "aria-label": "Daily request chart" }, days.map((d) => h("div", { class: "b", title: `${d.day}: ${d.requests} requests, ${d.errors} errors`, style: `height:${Math.max(3, (d.requests / max) * 100)}%` })))
        : h("div", { class: "muted" }, "No requests yet. Create a key and make your first call.")),
    h("div", { class: "grid two" },
      h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Get started in a minute"), h("ol", { class: "muted", style: "margin:0;padding-left:20px;display:grid;gap:8px" },
        h("li", null, "Create an API key in ", h("a", { href: "/dev?tab=keys" }, "API keys"), "."),
        h("li", null, "Resolve a name: ", h("code", { class: "inline" }, "GET /v1/names/heelo.addr/resolve?network=bitcoin")),
        h("li", null, "Install the SDK or read the chain directly with the trustless resolver."))),
      h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Need more?"), h("p", { class: "muted", style: "margin:0" }, "Startup and Business plans add webhooks, batch lookups, bulk issuing and higher limits. The enterprise console issues names to your customers."),
        h("div", { class: "row" }, h("a", { class: "btn", href: "/enterprise" }, "Open enterprise console"))))));
}

async function keys(body) {
  const draw = async () => {
    const list = (await api("GET", "/v1/account/keys")).keys;
    const label = h("input", { placeholder: "Label, e.g. production backend", maxlength: 60, "aria-label": "Key label" });
    const scope = h("select", { "aria-label": "Scope" }, h("option", { value: "read,write" }, "Read and write"), h("option", { value: "read" }, "Read only"));
    const create = btn(h("span", { class: "row tight" }, icon("plus", 16), "Create key"), async () => {
      const r = await api("POST", "/v1/account/keys", { label: label.value.trim(), scopes: scope.value });
      const m = modal({ title: "Your new API key", body: h("div", { class: "stack" }, alert("warn", "Copy this key now. For your security it cannot be shown again."), copyLine(r.apiKey, "Copy key"), h("div", { class: "help" }, "Use it as ", h("code", { class: "inline" }, "Authorization: Bearer <key>"), " or the ", h("code", { class: "inline" }, "X-API-Key"), " header.")),
        footer: [btn("Done", () => m.close(true))] });
      m.onClose = () => draw();
    });
    const rows = list.map((k) => h("tr", null, h("td", null, h("div", { style: "font-weight:600" }, k.label || "Unnamed key"), h("div", { class: "mono faint" }, `${k.prefix}…`)), h("td", null, k.scopes.split(",").map((s) => pill(s, "info"))), h("td", { class: "nowrap" }, timeAgo(k.created)), h("td", { class: "nowrap" }, k.lastUsed ? timeAgo(k.lastUsed) : h("span", { class: "faint" }, "never")),
      h("td", null, k.revoked ? pill("revoked", "bad") : pill("active", "ok", true)),
      h("td", { class: "right" }, k.revoked ? null : btn("Revoke", async () => { if (await confirmDialog("Revoke this key?", "Apps using it will stop working immediately.", "Revoke", true)) { await api("DELETE", `/v1/account/keys/${k.id}`); toast("Key revoked"); draw(); } }, "ghost small"))));
    mount(body, h("div", { class: "stack lg" },
      h("div", { class: "card" }, h("div", { class: "row", style: "align-items:flex-end" }, h("div", { class: "grow", style: "flex:2" }, field("New key", label)), h("div", { style: "width:180px" }, field("Access", scope)), create)),
      list.length ? table(["Key", "Access", "Created", "Last used", "Status", ""], rows) : empty("key", "No API keys yet", "Create a key to use the API from your server or app.")));
  };
  await draw();
}

async function consoleTab(body) {
  const info = await loadChain().catch(() => null);
  const path = h("input", { value: "/v1/names/heelo.addr/resolve?network=bitcoin", spellcheck: "false", "aria-label": "Request path" });
  const key = h("input", { placeholder: "optional: addr_live_... (default: your session)", spellcheck: "false", autocomplete: "off", "aria-label": "API key" });
  const out = h("pre", { "aria-live": "polite" }, "Send a request to see the response.");
  const status = h("div", { class: "row tight" });
  const run = btn(h("span", { class: "row tight" }, icon("bolt", 15), "Send request"), async () => {
    const t = performance.now();
    const headers = key.value.trim() ? { authorization: `Bearer ${key.value.trim()}` } : {};
    const res = await fetch(path.value, { headers, credentials: "same-origin" });
    const txt = await res.text();
    let pretty = txt; try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* not JSON */ }
    mount(status, pill(`HTTP ${res.status}`, res.ok ? "ok" : "bad", true), pill(`${Math.round(performance.now() - t)} ms`), pill(`${res.headers.get("x-ratelimit-remaining") ?? "n/a"} requests left today`));
    out.textContent = pretty;
  });
  path.addEventListener("keydown", (e) => { if (e.key === "Enter") run.click(); });
  const ex = [["Resolve Bitcoin", "/v1/names/heelo.addr/resolve?network=bitcoin"], ["USDT on TRON", "/v1/names/heelo.addr/resolve?network=tron&asset=USDT&standard=TRC20"], ["All records", "/v1/names/heelo.addr/records"], ["Name state", "/v1/names/heelo.addr"], ["Search", "/v1/search?q=heelo"], ["Validate address", "/v1/validate?network=bitcoin&address=bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"], ["Networks", "/v1/networks"], ["Pricing", "/v1/pricing"], ["Contracts", "/v1/contracts"], ["Health", "/v1/health"]];
  mount(body, h("div", { class: "stack lg" }, h("div", { class: "card stack" },
    h("div", { class: "row tight" }, ex.map(([n, p]) => h("button", { class: "chip", type: "button", onclick: () => { path.value = p; run.click(); } }, n))),
    h("div", { class: "row", style: "flex-wrap:nowrap" }, h("div", { class: "pill", style: "height:42px" }, "GET"), h("div", { class: "grow" }, path), run), field("Authentication", key, "Leave empty to use your signed-in session."), status, out)));
  void info;
}

async function sdk(body) {
  const info = await loadChain().catch(() => null);
  const base = location.origin;
  const code = `import { Addr, AddrChainResolver } from "@addr/sdk";

// REST: fast, cached index, free tier
const addr = new Addr({ baseUrl: "${base}", apiKey: process.env.ADDR_API_KEY });
const r = await addr.resolve("heelo.addr", { network: "bitcoin" });
console.log(r.address, r.verified, r.recentlyChanged);

// Trustless: read the chain directly, no ADDR server involved
const chain = new AddrChainResolver("${info?.chain?.rpcUrl ?? "https://your-rpc"}", {
  registry: "${info?.registry ?? "0x..."}",
  resolver: "${info?.resolver ?? "0x..."}",
});
console.log(await chain.resolve("heelo.addr", { network: "tron", asset: "USDT", standard: "TRC20" }));`;
  const curl = `curl -H "Authorization: Bearer $ADDR_API_KEY" \\\n  "${base}/v1/names/heelo.addr/resolve?network=bitcoin"`;
  const react = `import { Addr } from "@addr/sdk";\nimport { useAddrResolve } from "@addr/sdk/react";\n\nconst client = new Addr({ baseUrl: "${base}" });\nfunction Recipient({ name }) {\n  const { data, error, loading } = useAddrResolve(client, name, { network: "ethereum" });\n  if (loading) return "Resolving...";\n  return error ? error.message : data.address;\n}`;
  const hook = `import { verifyWebhook } from "@addr/sdk";\n\napp.post("/addr-webhook", express.raw({ type: "*/*" }), async (req, res) => {\n  const event = await verifyWebhook(req.body.toString(), req.headers["x-addr-signature"], process.env.WEBHOOK_SECRET);\n  // de-duplicate on event.id, then handle event.type\n  res.sendStatus(200);\n});`;
  const block = (title, text) => h("div", { class: "card stack" }, h("div", { class: "row between" }, h("h3", { style: "margin:0" }, title), btn("Copy", () => copy(text), "ghost small")), h("pre", null, text));
  mount(body, h("div", { class: "stack lg" }, block("TypeScript SDK", code), h("div", { class: "grid two" }, block("curl", curl), block("CLI", `npx addr resolve heelo.addr --network bitcoin\nnpx addr resolve-onchain heelo.addr --network tron --asset USDT --standard TRC20 \\\n  --rpc ${info?.chain?.rpcUrl ?? "https://your-rpc"}`)), block("React hook", react), block("Webhook verification", hook),
    h("div", { class: "card" }, h("h3", null, "Contracts"), info ? kv([["Chain", `${info.chain.name} (${info.chain.id})`], ["Registry", h("span", { class: "mono" }, info.registry)], ["Resolver", h("span", { class: "mono" }, info.resolver)], ["Registrar", h("span", { class: "mono" }, info.registrar)], ["Timelock", h("span", { class: "mono" }, info.timelock)]], true) : h("div", { class: "muted" }, "unavailable"))));
}

async function account(body) {
  const exp = btn("Download my data (JSON)", async () => {
    const d = await api("GET", "/v1/account/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    a.download = "addr-account-export.json"; a.click(); URL.revokeObjectURL(a.href);
  }, "ghost");
  const confirmEmail = h("input", { placeholder: auth.user.email, autocomplete: "off", "aria-label": "Type your email to confirm" });
  const del = btn("Delete my account", async () => {
    if (!(await confirmDialog("Delete this account?", "Your API keys, webhooks, claimed namespaces and issued-name records are deleted and cannot be restored. Names on the blockchain are not affected.", "Delete account", true))) return;
    await api("POST", "/v1/account/delete", { email: confirmEmail.value.trim() });
    await loadAuth(); toast("Account deleted"); navigate("/", true);
  }, "danger");
  const out = btn("Sign out everywhere", async () => {
    if (!(await confirmDialog("Sign out of all devices?", "Every active session for this account will end.", "Sign out all", true))) return;
    await api("POST", "/v1/auth/logout", { all: true });
    await loadAuth(); navigate("/", true);
  }, "danger");
  mount(body, h("div", { class: "card stack", style: "max-width:640px" }, h("h3", { style: "margin:0" }, "Account"),
    kv([["Email", auth.user.email], ["Account id", h("span", { class: "mono" }, auth.tenant?.id)], ["Plan", (auth.tenant?.plan || "free").toUpperCase()], ["Daily limit", Number(auth.tenant?.dailyLimit).toLocaleString()]], true),
    h("div", { class: "help" }, "Sign-in uses one-time codes sent to your email. There is no password to leak."), h("div", null, out)),
    h("div", { class: "card stack", style: "max-width:640px;margin-top:16px" }, h("h3", { style: "margin:0" }, "Your data"), h("p", { class: "muted", style: "margin:0" }, "Download everything we hold about this account, or delete the account. See the ", h("a", { href: "/legal/privacy" }, "Privacy Policy"), "."), h("div", null, exp),
      h("div", { class: "divider", style: "margin:4px 0" }), field("Type your email to enable deletion", confirmEmail), h("div", null, del)));
}
void fmtTime;
