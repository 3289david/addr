// Generates docs/openapi.json. Every route registered in server/routes.ts must appear here (checked by test/openapi.test.cjs).
const fs = require("fs");
const path = require("path");

const err = { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const ok = (d = "OK") => ({ "200": { description: d, content: { "application/json": { schema: { type: "object" } } } }, default: err });
const created = { "201": { description: "Created", content: { "application/json": { schema: { type: "object" } } } }, default: err };
const q = (name, d, required = false) => ({ name, in: "query", required, description: d, schema: { type: "string" } });
const p = (name, d) => ({ name, in: "path", required: true, description: d, schema: { type: "string" } });
const body = (props, required = []) => ({ required: true, content: { "application/json": { schema: { type: "object", required, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, typeof v === "string" ? { type: v } : v])) } } } });

const key = [{ ApiKey: [] }];
const admin = [{ AdminToken: [] }, { Session: [] }];

const paths = {
  "/v1/health": { get: { summary: "RPC and indexer health", responses: ok() } },
  "/v1/contracts": { get: { summary: "Deployed contract addresses and chain info", responses: ok() } },
  "/v1/networks": { get: { summary: "Supported and unsupported networks and assets", responses: ok() } },
  "/v1/pricing": { get: { summary: "On-chain price tiers, plans and payment methods", responses: ok() } },
  "/v1/prices": { get: { summary: "USD prices used for coin invoices", responses: ok() } },
  "/v1/accounts/{address}/names": { get: { summary: "Names owned by an EVM address (indexed)", parameters: [p("address", "EVM address")], responses: ok() } },
  "/v1/names/{name}": { get: { summary: "Registration state read from chain", parameters: [p("name", "e.g. heelo.addr")], responses: ok() } },
  "/v1/names/{name}/records": { get: { summary: "All address records and profile for an active name", parameters: [p("name", "name")], responses: ok() } },
  "/v1/names/{name}/resolve": { get: { summary: "Resolve to one network address", parameters: [p("name", "name"), q("network", "network id (required for multi-network tokens)"), q("asset", "BTC, ETH, USDT, USDC ..."), q("standard", "ERC20, TRC20, SPL, BEP20")], responses: ok() } },
  "/v1/names/{name}/history": { get: { summary: "Indexed change history", parameters: [p("name", "name")], responses: ok() } },
  "/v1/resolutions": { post: { summary: "Batch resolve", requestBody: body({ requests: { type: "array", items: { type: "object" } } }, ["requests"]), responses: ok() } },
  "/v1/addresses/{address}/reverse": { get: { summary: "Verified primary name (EVM) or record matches", parameters: [p("address", "address")], responses: ok() } },
  "/v1/validate": { get: { summary: "Validate an address for a network", parameters: [q("network", "network id", true), q("address", "address", true)], responses: ok() } },
  "/v1/search": { get: { summary: "Availability, price, matches and look-alikes", parameters: [q("q", "name or prefix", true), q("owner", "wallet to evaluate free-tier eligibility")], responses: ok() } },
  "/v1/free-claims": { post: { summary: "Issue a single-use free-name voucher (EIP-712)", requestBody: body({ label: "string", owner: "string" }, ["label", "owner"]), responses: ok() } },
  "/v1/auth/email": { post: { summary: "Email a one-time sign-in code and link (open to anyone, creates the account on first sign-in)", requestBody: body({ email: "string", next: "string" }, ["email"]), responses: ok() } },
  "/v1/auth/verify": { post: { summary: "Exchange email + 6 digit code for a session cookie", requestBody: body({ email: "string", code: "string" }, ["email", "code"]), responses: ok() } },
  "/v1/auth/verify-token": { post: { summary: "Confirm a magic-link token and start a session", requestBody: body({ token: "string" }, ["token"]), responses: ok() } },
  "/v1/auth/logout": { post: { summary: "End the session (all=true ends every session)", requestBody: body({ all: "boolean" }), responses: ok() } },
  "/v1/auth/me": { get: { summary: "Current session, CSRF token, plan", responses: ok() } },
  "/v1/account/keys": {
    get: { summary: "List API keys (session)", responses: ok() },
    post: { summary: "Create an API key (session)", requestBody: body({ label: "string", scopes: "string" }), responses: created },
  },
  "/v1/account/keys/{id}": { delete: { summary: "Revoke an API key (session)", parameters: [p("id", "key id")], responses: ok() } },
  "/v1/account/usage": { get: { summary: "Request usage of the account (session)", responses: ok() } },
  "/v1/admin/mail": { get: { summary: "Outbox and DNS (SPF/DKIM/DMARC) status for email delivery", security: admin, responses: ok() } },
  "/v1/usage": { get: { summary: "Usage of the calling key or IP", security: key, responses: ok() } },
  "/v1/payments/methods": { get: { summary: "Enabled coin payment methods", responses: ok() } },
  "/v1/invoices": { post: { summary: "Create a coin payment invoice for a name or renewal", requestBody: body({ label: "string", owner: "string", years: "integer", network: "string", asset: "string", standard: "string", kind: "string" }, ["label", "owner", "network", "asset"]), responses: created } },
  "/v1/invoices/{id}": { get: { summary: "Invoice status", parameters: [p("id", "invoice id")], responses: ok() } },
  "/v1/invoices/{id}/payment": { post: { summary: "Attach and verify the paying transaction", parameters: [p("id", "invoice id")], requestBody: body({ txid: "string" }, ["txid"]), responses: ok() } },
  "/v1/webhooks": {
    get: { summary: "List webhooks", security: key, responses: ok() },
    post: { summary: "Create a webhook (secret returned once)", security: key, requestBody: body({ url: "string", events: { type: "array", items: { type: "string" } }, namespace: "string" }, ["url"]), responses: created },
  },
  "/v1/webhooks/{id}": { delete: { summary: "Disable a webhook", security: key, parameters: [p("id", "webhook id")], responses: ok() } },
  "/v1/webhooks/{id}/deliveries": { get: { summary: "Delivery log", security: key, parameters: [p("id", "webhook id")], responses: ok() } },
  "/v1/webhooks/{id}/deliveries/{did}/retry": { post: { summary: "Replay a delivery", security: key, parameters: [p("id", "webhook id"), p("did", "delivery id")], responses: ok() } },
  "/v1/enterprise/claim-message": { get: { summary: "Message the namespace owner must sign", security: key, parameters: [q("name", "name", true)], responses: ok() } },
  "/v1/enterprise/namespaces": {
    get: { summary: "Claimed namespaces", security: key, responses: ok() },
    post: { summary: "Claim a namespace with an owner signature", security: key, requestBody: body({ name: "string", signature: "string" }, ["name", "signature"]), responses: created },
  },
  "/v1/enterprise/namespaces/{name}": { get: { summary: "Namespace status and relayer approval", security: key, parameters: [p("name", "namespace")], responses: ok() } },
  "/v1/enterprise/subnames": { post: { summary: "Issue a subname owned by the customer wallet, with records", security: key, requestBody: body({ namespace: "string", label: "string", customerId: "string", owner: "string", records: "object", text: "object" }, ["namespace", "label", "customerId", "owner"]), responses: created } },
  "/v1/enterprise/subnames/bulk": { post: { summary: "Issue many subnames", security: key, requestBody: body({ items: { type: "array", items: { type: "object" } } }, ["items"]), responses: ok() } },
  "/v1/enterprise/names": {
    get: { summary: "Names issued by the tenant", security: key, parameters: [q("limit", "max 500"), q("offset", "offset")], responses: ok() },
    post: { summary: "Issue a global name ticket (free voucher or invoice)", security: key, requestBody: body({ label: "string", owner: "string", customerId: "string", years: "integer", network: "string", asset: "string" }, ["label", "owner", "customerId"]), responses: created },
  },
  "/v1/enterprise/names/{name}": {
    patch: { summary: "Update records of an issued subname (needs customer consent on-chain)", security: key, parameters: [p("name", "name")], requestBody: body({ records: "object", text: "object" }), responses: ok() },
    delete: { summary: "Remove an issued subname (unless the customer made it sovereign)", security: key, parameters: [p("name", "name")], responses: ok() },
  },
  "/v1/enterprise/records": { post: { summary: "Set records for an issued name", security: key, requestBody: body({ name: "string", records: "object", text: "object" }, ["name"]), responses: ok() } },
  "/v1/enterprise/customers/{id}/names": { get: { summary: "Names issued for a customer id", security: key, parameters: [p("id", "customer id")], responses: ok() } },
  "/v1/enterprise/renewals": { post: { summary: "Renew a global name (free tier on-chain, or invoice)", security: key, requestBody: body({ name: "string", years: "integer", network: "string", asset: "string" }, ["name"]), responses: ok() } },
  "/v1/enterprise/plan": { post: { summary: "Create an invoice for a plan", security: key, requestBody: body({ plan: "string", network: "string", asset: "string" }, ["plan", "network", "asset"]), responses: created } },
  "/v1/enterprise/dashboard": { get: { summary: "Issuance, usage and webhook health", security: key, responses: ok() } },
  "/v1/enterprise/expiring": { get: { summary: "Namespaces expiring soon", security: key, parameters: [q("days", "window in days")], responses: ok() } },
  "/v1/enterprise/invoices": { get: { summary: "Tenant invoices", security: key, responses: ok() } },
  "/v1/admin/stats": { get: { summary: "Operational statistics", security: admin, responses: ok() } },
  "/v1/admin/health": { get: { summary: "RPC provider health", security: admin, responses: ok() } },
  "/v1/admin/timelock": { get: { summary: "Timelock operations (scheduled/executed)", security: admin, responses: ok() } },
  "/v1/admin/audit": { get: { summary: "Audit log", security: admin, responses: ok() } },
  "/v1/admin/invoices": { get: { summary: "Invoices", security: admin, parameters: [q("status", "filter")], responses: ok() } },
  "/v1/admin/invoices/{id}/retry": { post: { summary: "Retry settlement", security: admin, parameters: [p("id", "invoice id")], responses: ok() } },
  "/v1/admin/tenants": { post: { summary: "Create tenant and key", security: admin, requestBody: body({ name: "string", plan: "string" }, ["name"]), responses: created } },
  "/v1/admin/tenants/{id}": { patch: { summary: "Change plan", security: admin, parameters: [p("id", "tenant id")], requestBody: body({ plan: "string", days: "integer" }, ["plan"]), responses: ok() } },
  "/v1/admin/tenants/{id}/keys": { post: { summary: "Issue an API key", security: admin, parameters: [p("id", "tenant id")], responses: created } },
  "/v1/admin/reindex": { post: { summary: "Run an indexer pass", security: admin, responses: ok() } },
};

const spec = {
  openapi: "3.0.3",
  info: { title: "ADDR API", version: "1.0.0", description: "Human-readable Web3 names. The API indexes and caches; ownership and records are read from the chain. `verified` means format/checksum valid and read from an active name, not a statement about the recipient." },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      ApiKey: { type: "http", scheme: "bearer", description: "addr_live_... key (also accepted as X-API-Key)" },
      AdminToken: { type: "http", scheme: "bearer" },
      Session: { type: "apiKey", in: "cookie", name: "addr_session", description: "Browser session; state-changing requests also need X-CSRF-Token from /v1/auth/me" },
    },
    schemas: { Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } },
  },
};
fs.writeFileSync(path.join(__dirname, "..", "docs", "openapi.json"), JSON.stringify(spec, null, 2));
console.log("docs/openapi.json written:", Object.keys(paths).length, "paths");
module.exports = { paths };
