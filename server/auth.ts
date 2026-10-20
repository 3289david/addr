import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AddrError } from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { isAdminEmail, sessionFrom, type SessionInfo } from "./accounts.ts";

export interface Principal {
  kind: "anon" | "key";
  subject: string;       // usage bucket
  tenantId?: string;
  keyId?: string;
  scopes: string[];
  plan: string;          // effective plan
  dailyLimit: number;
  session?: SessionInfo; // set when authenticated by browser session cookie
  email?: string;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createTenant(name: string, plan = "free"): string {
  const id = "ten_" + crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO tenants (id, name, plan, plan_expires, created) VALUES (?,?,?,?,?)")
    .run(id, name.slice(0, 80), plan, plan === "enterprise" ? 4102444800 : 0, now());
  return id;
}

export function createKey(tenantId: string, label = "", scopes = "read,write"): { key: string; id: string } {
  const secret = crypto.randomBytes(24).toString("base64url");
  const key = `addr_live_${secret}`;
  const id = "key_" + crypto.randomBytes(6).toString("hex");
  db.prepare("INSERT INTO api_keys (id, tenant_id, hash, prefix, label, scopes, created) VALUES (?,?,?,?,?,?,?)")
    .run(id, tenantId, sha256(key), key.slice(0, 14), label.slice(0, 60), scopes, now());
  return { key, id };
}

export function effectivePlan(t: { plan: string; plan_expires: number }): string {
  if (t.plan === "free") return "free";
  return t.plan_expires > now() ? t.plan : "free";
}

export function clientIp(req: IncomingMessage): string {
  // Only trust X-Forwarded-For when explicitly behind a proxy.
  if (process.env.TRUST_PROXY === "1") {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || "unknown";
}

// short-window burst limiter (in-memory) per subject
const bursts = new Map<string, { t: number; n: number }>();
function burst(subject: string, limitPerSec: number) {
  const sec = Math.floor(Date.now() / 1000);
  const b = bursts.get(subject);
  if (!b || b.t !== sec) {
    bursts.set(subject, { t: sec, n: 1 });
    if (bursts.size > 50_000) for (const k of bursts.keys()) { bursts.delete(k); break; }
    return;
  }
  b.n++;
  if (b.n > limitPerSec) throw new AddrError("rate_limited", "too many requests per second", 429);
}

const today = () => new Date().toISOString().slice(0, 10);

export function authenticate(req: IncomingMessage): Principal {
  const h = req.headers;
  const sess = sessionFrom(req);
  const bearerPresent = typeof h.authorization === "string" && h.authorization.startsWith("Bearer addr_live_");
  if (sess && !bearerPresent && !h["x-api-key"]) {
    const method = req.method || "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (h["x-csrf-token"] !== sess.csrf) throw new AddrError("csrf", "missing or invalid CSRF token", 403);
      const origin = h.origin;
      if (origin && h.host && new URL(origin).host !== h.host) throw new AddrError("csrf", "cross-origin request blocked", 403);
    }
    const t = db.prepare("SELECT plan, plan_expires FROM tenants WHERE id = ?").get(sess.tenantId) as any;
    const plan = effectivePlan(t);
    burst("u:" + sess.userId, 200);
    return { kind: "key", subject: "u:" + sess.userId, tenantId: sess.tenantId, scopes: ["read", "write"], plan, dailyLimit: config.plans[plan].dailyLimit, session: sess, email: sess.email };
  }
  const bearer = typeof h.authorization === "string" && h.authorization.startsWith("Bearer ") ? h.authorization.slice(7) : "";
  // admin routes use a static bearer token or an admin email session (checked by requireAdmin), not a tenant key
  const adminRoute = (req.url || "").startsWith("/v1/admin/");
  const raw = adminRoute ? "" : (h["x-api-key"] as string) || bearer;
  if (raw && raw.startsWith("addr_live_")) {
    const k = db.prepare("SELECT k.*, t.plan, t.plan_expires FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.hash = ? AND k.revoked = 0").get(sha256(raw)) as any;
    if (!k) throw new AddrError("invalid_api_key", "invalid or revoked API key", 401);
    const plan = effectivePlan(k);
    const p: Principal = {
      kind: "key", subject: k.id, tenantId: k.tenant_id, keyId: k.id, scopes: String(k.scopes).split(","),
      plan, dailyLimit: config.plans[plan].dailyLimit,
    };
    burst(p.subject, 200);
    if (!k.last_used || now() - k.last_used > 300) db.prepare("UPDATE api_keys SET last_used = ? WHERE id = ?").run(now(), k.id);
    return p;
  }
  if (raw) throw new AddrError("invalid_api_key", "invalid API key format", 401);
  const ipHash = "ip:" + sha256(clientIp(req) + "|" + today()).slice(0, 24); // salted by day: no long-term IP retention
  burst(ipHash, 30);
  return { kind: "anon", subject: ipHash, scopes: ["read"], plan: "anon", dailyLimit: config.anonDailyLimit };
}

/** Counts the request against the daily quota. Throws 429 when exceeded. */
export function meter(p: Principal): { used: number; limit: number } {
  const d = today();
  db.prepare("INSERT INTO usage (subject, day, count) VALUES (?,?,1) ON CONFLICT(subject, day) DO UPDATE SET count = count + 1").run(p.subject, d);
  const row = db.prepare("SELECT count FROM usage WHERE subject = ? AND day = ?").get(p.subject, d) as { count: number };
  if (row.count > p.dailyLimit) {
    throw new AddrError("quota_exceeded", `daily request limit (${p.dailyLimit}) reached. Get a free API key or upgrade for more.`, 429);
  }
  return { used: row.count, limit: p.dailyLimit };
}

export function countError(p: Principal) {
  db.prepare("UPDATE usage SET errors = errors + 1 WHERE subject = ? AND day = ?").run(p.subject, today());
}

export function requireTenant(p: Principal, scope = "read"): string {
  if (p.kind !== "key" || !p.tenantId) throw new AddrError("auth_required", "this endpoint requires an API key", 401);
  if (!p.scopes.includes(scope)) throw new AddrError("forbidden", `API key lacks the "${scope}" scope`, 403);
  return p.tenantId;
}

export function requirePlan(p: Principal, min: "startup" | "business") {
  const order = ["free", "startup", "business", "enterprise"];
  if (order.indexOf(p.plan) < order.indexOf(min)) {
    throw new AddrError("plan_required", `requires the ${min.toUpperCase()} plan or higher (current: ${p.plan.toUpperCase()})`, 402);
  }
}

export function requireAdmin(req: IncomingMessage, principal?: Principal) {
  if (principal?.session && isAdminEmail(principal.session.email)) return;
  const h = req.headers.authorization || "";
  if (!config.adminToken && !config.adminEmails.length) throw new AddrError("admin_disabled", "admin is disabled (set ADMIN_EMAILS or ADMIN_TOKEN)", 403);
  const given = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!config.adminToken || !given) throw new AddrError("forbidden", "admin access required", 403);
  const a = Buffer.from(sha256(given)), b = Buffer.from(sha256(config.adminToken));
  if (!crypto.timingSafeEqual(a, b)) throw new AddrError("forbidden", "invalid admin credentials", 403);
}
