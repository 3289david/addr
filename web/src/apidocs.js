// Human-browsable reference for /openapi.json. Generated client-side from the same spec the server
// publishes (scripts/gen-openapi.cjs), so this page can never drift from the real, tested routes
// (see "openapi coverage" in test/addr.test.cjs).
import { h, mount, icon, copy, skeleton, pill, table, alert } from "./lib.js";

const GROUPS = [
  { key: "meta", label: "Search & resolution", desc: "Public, no account needed. Read names, records and prices from the chain.", match: (p) => /^\/v1\/(health|contracts|networks|pricing|prices|accounts\/|names\/|resolutions|addresses\/|validate|search)/.test(p) },
  { key: "free", label: "Free registration", desc: "On-chain free-tier voucher issuance.", match: (p) => p.startsWith("/v1/free-claims") },
  { key: "payments", label: "Payments & invoices", desc: "Pay for a name in BTC, LTC, TRON, Solana or other coins.", match: (p) => /^\/v1\/(payments|invoices)/.test(p) },
  { key: "auth", label: "Sign-in", desc: "Passwordless email sign-in: one-time code or confirmed link.", match: (p) => p.startsWith("/v1/auth/") },
  { key: "account", label: "Developer account", desc: "API keys and usage, once signed in.", match: (p) => /^\/v1\/(account|usage)/.test(p) },
  { key: "webhooks", label: "Webhooks", desc: "Signed delivery of name and invoice events.", match: (p) => p.startsWith("/v1/webhooks") },
  { key: "enterprise", label: "Enterprise", desc: "Namespace claims, relayer-issued subnames, bulk operations.", match: (p) => p.startsWith("/v1/enterprise") },
  { key: "legal", label: "Legal & reports", desc: "Operator identity, retention policy, abuse reports.", match: (p) => /^\/v1\/(legal|reports)/.test(p) },
  { key: "admin", label: "Admin", desc: "Requires the admin token or an admin-listed email session.", match: (p) => p.startsWith("/v1/admin") },
];

const METHOD_KIND = { get: "info", post: "ok", patch: "warn", delete: "bad" };

function authBadge(sec) {
  if (!sec || !sec.length) return pill("Public", "ok", true);
  const names = new Set();
  for (const s of sec) for (const k of Object.keys(s)) names.add(k);
  if (names.has("AdminToken")) return pill("Admin token", "bad", true);
  if (names.has("ApiKey")) return pill("API key", "warn", true);
  if (names.has("Session")) return pill("Session", "info", true);
  return pill("Auth required", "warn", true);
}

function exampleValue(type) {
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  return "...";
}

function curlFor(base, method, path, op) {
  let p = path;
  for (const param of op.parameters || []) if (param.in === "path") p = p.replace(`{${param.name}}`, `EXAMPLE_${param.name.toUpperCase()}`);
  const q = (op.parameters || []).filter((x) => x.in === "query" && x.required).map((x) => `${x.name}=...`).join("&");
  const lines = [`curl -X ${method.toUpperCase()} "${base}${p}${q ? `?${q}` : ""}"`];
  const sec = op.security || [];
  if (sec.some((s) => s.ApiKey)) lines.push(`  -H "Authorization: Bearer addr_live_..."`);
  if (sec.some((s) => s.AdminToken)) lines.push(`  -H "Authorization: Bearer <ADMIN_TOKEN>"`);
  if (sec.some((s) => s.Session)) lines.push(`  -H "Cookie: addr_session=..." -H "X-CSRF-Token: ..."`);
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  if (schema) {
    const body = {};
    for (const k of schema.required || []) body[k] = exampleValue(schema.properties?.[k]?.type);
    lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(body)}'`);
  }
  return lines.join(" \\\n");
}

function paramsTable(params) {
  if (!params?.length) return null;
  return table(["Name", "In", "Required", "Description"], params.map((p) =>
    h("tr", null, h("td", { class: "mono" }, p.name), h("td", null, p.in), h("td", null, p.required ? "yes" : ""), h("td", null, p.description || ""))));
}

function bodyTable(requestBody) {
  const schema = requestBody?.content?.["application/json"]?.schema;
  if (!schema?.properties) return null;
  const required = new Set(schema.required || []);
  return table(["Field", "Type", "Required"], Object.entries(schema.properties).map(([name, def]) =>
    h("tr", null, h("td", { class: "mono" }, name), h("td", null, def.type || ""), h("td", null, required.has(name) ? "yes" : ""))));
}

function endpoint(base, path, method, op) {
  const summary = h("summary", null,
    h("span", { class: "row tight", style: "flex-wrap:nowrap" },
      pill(method.toUpperCase(), METHOD_KIND[method] || ""), h("span", { class: "mono", style: "font-size:13.5px" }, path),
      h("span", { class: "muted", style: "font-size:13.5px;font-weight:400" }, op.summary || "")));
  const curl = curlFor(base, method, path, op);
  return h("details", { class: "q api-endpoint" }, summary,
    h("div", { class: "stack", style: "margin-top:12px" },
      h("div", { class: "row tight" }, authBadge(op.security)),
      paramsTable(op.parameters),
      bodyTable(op.requestBody),
      h("div", null,
        h("div", { class: "row between", style: "margin-bottom:6px" }, h("span", { class: "help", style: "margin:0" }, "Example request"),
          h("button", { class: "btn ghost small", type: "button", onclick: () => copy(curl, "curl command copied") }, icon("copy", 14), "Copy")),
        h("pre", null, curl))));
}

export async function apidocs(root) {
  mount(root, h("div", { class: "legal" }, h("h1", null, "API reference"), skeleton(6)));
  let spec;
  try {
    spec = await (await fetch("/openapi.json")).json();
  } catch {
    mount(root, h("div", { class: "legal" }, h("h1", null, "API reference"), alert("bad", "Could not load /openapi.json.")));
    return;
  }
  const base = location.origin;
  const entries = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) entries.push({ path, method, op });
  }
  const grouped = GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => g.match(e.path)) }));

  const search = h("input", { placeholder: "Filter by path or description…", "aria-label": "Filter endpoints", autocomplete: "off" });
  const sections = h("div", { class: "stack lg" });
  const navChips = h("div", { class: "legal-nav" }, grouped.map((g) => h("a", { class: "chip", href: `#api-${g.key}` }, `${g.label} (${g.entries.length})`)));

  mount(root, h("div", { class: "legal" },
    h("h1", null, "API reference"),
    h("p", { class: "meta" }, spec.info?.description || "", " Generated from the same spec the server publishes — see also ",
      h("a", { href: "/openapi.json", target: "_blank", rel: "noopener" }, "raw OpenAPI JSON"), " and the ",
      h("a", { href: "/docs/", target: "_blank", rel: "noopener" }, "protocol specification"), "."),
    h("div", { class: "stack", style: "margin-top:22px" },
      h("div", { class: "card tight" },
        h("h3", null, "Authentication"),
        h("div", { class: "stack" },
          h("div", null, pill("API key", "warn", true), " developer/enterprise key as ", h("code", { class: "inline" }, "Authorization: Bearer addr_live_..."), " or ", h("code", { class: "inline" }, "X-API-Key")),
          h("div", null, pill("Admin token", "bad", true), " operator-only, as ", h("code", { class: "inline" }, "Authorization: Bearer <ADMIN_TOKEN>")),
          h("div", null, pill("Session", "info", true), " browser cookie from signing in; state-changing requests also need ", h("code", { class: "inline" }, "X-CSRF-Token"), " (from ", h("code", { class: "inline" }, "GET /v1/auth/me"), ")"),
          h("div", null, pill("Public", "ok", true), " no authentication"))),
      field_("Filter", search),
      navChips),
    sections));

  function field_(label, input) { return h("label", { class: "field" }, h("span", { class: "lab" }, label), input); }

  for (const g of grouped) {
    if (!g.entries.length) continue;
    sections.append(h("section", { id: `api-${g.key}` },
      h("h2", null, g.label), h("p", { class: "muted", style: "margin:0 0 14px" }, g.desc),
      h("div", { class: "stack" }, g.entries.map((e) => endpoint(base, e.path, e.method, e.op)))));
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const el of root.querySelectorAll(".api-endpoint")) {
      const text = el.textContent.toLowerCase();
      el.classList.toggle("hide", !!q && !text.includes(q));
    }
    for (const sec of root.querySelectorAll("section[id^='api-']")) {
      const anyVisible = [...sec.querySelectorAll(".api-endpoint")].some((el) => !el.classList.contains("hide"));
      sec.classList.toggle("hide", !anyVisible);
    }
  });
}
