// Passwordless email sign-in (one-time code or confirmed magic link), sessions, accounts and API keys.
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AddrError } from "../packages/core/src/index.ts";
import { clientIp, createKey, createTenant, sha256 } from "./auth.ts";
import { config } from "./config.ts";
import { audit, db, now } from "./db.ts";
import { sendMail } from "./mail.ts";

const COOKIE = "addr_session";
const EMAIL_RE = /^[^\s@<>()"',;:\\]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new AddrError("invalid_email", "email is required", 422);
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new AddrError("invalid_email", "enter a valid email address", 422);
  return e;
}

function rl(bucket: string, limit: number, windowSec: number, msg: string) {
  const t = now();
  const c = (db.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE bucket = ? AND ts > ?").get(bucket, t - windowSec) as any).c;
  if (c >= limit) throw new AddrError("rate_limited", msg, 429);
  db.prepare("INSERT INTO rate_events (bucket, ts) VALUES (?, ?)").run(bucket, t);
}

const timingEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ------------------------------------------------------------------ requesting a code

export function requestLogin(req: IncomingMessage, rawEmail: unknown, next?: string) {
  const email = normalizeEmail(rawEmail);
  const ip = sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24);
  rl(`login:email:${email}`, 5, 3600, "Too many sign-in emails for this address. Try again in an hour.");
  rl(`login:ip:${ip}`, config.loginIpPerHour, 3600, "Too many sign-in attempts from this network. Try again later.");
  rl("login:global", 600, 3600, "Sign-in is busy. Try again shortly.");

  db.prepare("UPDATE login_codes SET consumed = 1 WHERE email = ? AND consumed = 0").run(email); // only the newest code works
  const code = String(crypto.randomInt(100000, 1000000));
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomBytes(8).toString("hex");
  const expires = now() + config.loginCodeTtlSec;
  db.prepare("INSERT INTO login_codes (id, email, code_hash, token_hash, ip_hash, created, expires) VALUES (?,?,?,?,?,?,?)")
    .run(id, email, sha256(`${email}|${code}`), sha256(token), ip, now(), expires);

  const base = (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/$/, "");
  const safeNext = next && /^\/[a-zA-Z0-9/_\-.]*$/.test(next) && !next.startsWith("//") ? next : "/dev";
  const link = `${base}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext)}`;
  const mins = Math.round(config.loginCodeTtlSec / 60);
  sendMail({
    to: email,
    subject: `Your ADDR sign-in code: ${code}`,
    text: `Your ADDR sign-in code is ${code}\n\nIt expires in ${mins} minutes and works once.\n\nOr open this link on the same device and confirm:\n${link}\n\nIf you did not request this, ignore this email. Nobody can sign in without the code.\n`,
    html: emailHtml(code, link, mins),
  });
  return { sent: true, email, expiresInSeconds: config.loginCodeTtlSec, transport: config.mail.transport };
}

function emailHtml(code: string, link: string, mins: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#10131c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e3e7f0">
<tr><td style="font-weight:800;letter-spacing:.14em;font-size:18px">ADDR</td></tr>
<tr><td style="padding-top:20px;font-size:16px">Your sign-in code</td></tr>
<tr><td style="padding:12px 0;font-size:38px;font-weight:700;letter-spacing:.22em;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(code)}</td></tr>
<tr><td style="font-size:14px;color:#5b6479">It expires in ${mins} minutes and works once.</td></tr>
<tr><td style="padding:22px 0"><a href="${esc(link)}" style="background:#4f7cff;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">Review and sign in</a></td></tr>
<tr><td style="font-size:12px;color:#7a849c;word-break:break-all">If the button does not work, paste this link into your browser:<br>${esc(link)}</td></tr>
<tr><td style="padding-top:20px;font-size:12px;color:#7a849c">If you did not request this email you can ignore it. Nobody can sign in without the code.</td></tr>
</table></td></tr></table></body></html>`;
}

// ------------------------------------------------------------------ verifying

function ensureUser(email: string): { id: string; tenantId: string; created: boolean } {
  const u = db.prepare("SELECT id, tenant_id FROM users WHERE email = ?").get(email) as any;
  if (u) return { id: u.id, tenantId: u.tenant_id, created: false };
  const tenantId = createTenant(email.split("@")[0]);
  const id = "usr_" + crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO users (id, email, tenant_id, created) VALUES (?,?,?,?)").run(id, email, tenantId, now());
  audit(tenantId, "system", "user.signup", id);
  return { id, tenantId, created: true };
}

function startSession(res: ServerResponse, req: IncomingMessage, userId: string) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const t = now();
  db.prepare("INSERT INTO sessions (id_hash, user_id, csrf, ua, created, last_seen, expires) VALUES (?,?,?,?,?,?,?)")
    .run(sha256(sid), userId, csrf, String(req.headers["user-agent"] || "").slice(0, 160), t, t, t + config.sessionTtlSec);
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(t, userId);
  setCookie(res, sid, config.sessionTtlSec);
}

function setCookie(res: ServerResponse, value: string, maxAge: number) {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (config.cookieSecure) parts.push("Secure");
  const prev = res.getHeader("set-cookie");
  res.setHeader("set-cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join("; ")]);
}

function failAttempt(id: string) {
  db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
}

export function verifyCode(req: IncomingMessage, res: ServerResponse, rawEmail: unknown, rawCode: unknown) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) throw new AddrError("invalid_code", "enter the 6 digit code from the email", 422);
  rl(`verify:ip:${sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24)}`, 40, 3600, "Too many attempts. Try again later.");
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ? AND consumed = 0 ORDER BY created DESC LIMIT 1").get(email) as any;
  if (!row || row.expires < now()) throw new AddrError("code_expired", "this code has expired or was already used; request a new one", 401);
  if (row.attempts >= 5) {
    db.prepare("UPDATE login_codes SET consumed = 1 WHERE id = ?").run(row.id);
    throw new AddrError("too_many_attempts", "too many wrong codes; request a new one", 429);
  }
  if (!timingEq(row.code_hash, sha256(`${email}|${code}`))) {
    failAttempt(row.id);
    throw new AddrError("wrong_code", `wrong code (${4 - row.attempts} attempts left)`, 401);
  }
  return finish(req, res, row.id, email);
}

export function verifyToken(req: IncomingMessage, res: ServerResponse, token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new AddrError("invalid_token", "invalid sign-in link", 422);
  rl(`verify:ip:${sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24)}`, 40, 3600, "Too many attempts. Try again later.");
  const row = db.prepare("SELECT * FROM login_codes WHERE token_hash = ? AND consumed = 0").get(sha256(token)) as any;
  if (!row || row.expires < now()) throw new AddrError("code_expired", "this sign-in link has expired or was already used", 401);
  return finish(req, res, row.id, row.email);
}

function finish(req: IncomingMessage, res: ServerResponse, codeId: string, email: string) {
  const r = db.prepare("UPDATE login_codes SET consumed = 1 WHERE id = ? AND consumed = 0").run(codeId);
  if (!Number(r.changes)) throw new AddrError("code_expired", "this code was already used", 401);
  const user = ensureUser(email);
  startSession(res, req, user.id);
  return { authenticated: true, newAccount: user.created, email };
}

// ------------------------------------------------------------------ sessions

export interface SessionInfo { userId: string; email: string; tenantId: string; csrf: string; idHash: string }

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionFrom(req: IncomingMessage): SessionInfo | null {
  const sid = parseCookies(req)[COOKIE];
  if (!sid || sid.length > 100) return null;
  const idHash = sha256(sid);
  const row = db.prepare("SELECT s.csrf, s.expires, s.last_seen, u.id AS uid, u.email, u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?").get(idHash) as any;
  if (!row || row.expires < now()) return null;
  if (now() - row.last_seen > 600) {
    // sliding expiry, written at most every 10 minutes
    db.prepare("UPDATE sessions SET last_seen = ?, expires = ? WHERE id_hash = ?").run(now(), now() + config.sessionTtlSec, idHash);
  }
  return { userId: row.uid, email: row.email, tenantId: row.tenant_id, csrf: row.csrf, idHash };
}

export function logout(req: IncomingMessage, res: ServerResponse, all = false) {
  const s = sessionFrom(req);
  if (s) {
    if (all) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(s.userId);
    else db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(s.idHash);
  }
  setCookie(res, "", 0);
}

export function isAdminEmail(email: string) {
  return config.adminEmails.includes(email.toLowerCase());
}

// ------------------------------------------------------------------ account keys

export function listKeys(tenantId: string) {
  return db.prepare("SELECT id, prefix, label, scopes, created, last_used AS lastUsed, revoked FROM api_keys WHERE tenant_id = ? ORDER BY created DESC").all(tenantId);
}

export function createAccountKey(tenantId: string, label: unknown, scopes: unknown) {
  const n = (db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE tenant_id = ? AND revoked = 0").get(tenantId) as any).c;
  if (n >= 20) throw new AddrError("key_limit", "you can have at most 20 active keys; revoke one first", 409);
  const sc = scopes === "read" ? "read" : "read,write";
  const k = createKey(tenantId, typeof label === "string" ? label : "", sc);
  audit(tenantId, "user", "key.create", k.id);
  return { apiKey: k.key, keyId: k.id, scopes: sc, note: "Store this key now. It cannot be shown again." };
}

export function revokeKey(tenantId: string, id: string) {
  const r = db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND tenant_id = ?").run(id, tenantId);
  if (!Number(r.changes)) throw new AddrError("not_found", "key not found", 404);
  audit(tenantId, "user", "key.revoke", id);
}

export function accountUsage(tenantId: string) {
  const ids = (db.prepare("SELECT id FROM api_keys WHERE tenant_id = ?").all(tenantId) as { id: string }[]).map((r) => r.id);
  const u = db.prepare("SELECT id FROM users WHERE tenant_id = ?").all(tenantId) as { id: string }[];
  const subjects = [...ids, ...u.map((x) => "u:" + x.id)];
  const rows = subjects.length
    ? db.prepare(`SELECT day, SUM(count) AS requests, SUM(errors) AS errors FROM usage WHERE subject IN (${subjects.map(() => "?").join(",")}) GROUP BY day ORDER BY day DESC LIMIT 30`).all(...subjects)
    : [];
  return rows;
}

// ------------------------------------------------------------ data rights

/** Everything the service holds about the signed-in account, as JSON. */
export function exportAccount(userId: string) {
  const u = db.prepare("SELECT id, email, tenant_id AS tenantId, created, last_login AS lastLogin FROM users WHERE id = ?").get(userId) as any;
  if (!u) throw new AddrError("not_found", "account not found", 404);
  const t = u.tenantId;
  return {
    exportedAt: now(),
    user: u,
    tenant: db.prepare("SELECT id, name, plan, plan_expires AS planExpires, created FROM tenants WHERE id = ?").get(t),
    sessions: db.prepare("SELECT ua, created, last_seen AS lastSeen, expires FROM sessions WHERE user_id = ?").all(userId),
    apiKeys: db.prepare("SELECT id, prefix, label, scopes, created, last_used AS lastUsed, revoked FROM api_keys WHERE tenant_id = ?").all(t),
    webhooks: db.prepare("SELECT id, url, events, scope, active, created FROM webhooks WHERE tenant_id = ?").all(t),
    namespaces: db.prepare("SELECT name, owner_wallet AS ownerWallet, verified_at AS verifiedAt FROM namespaces WHERE tenant_id = ?").all(t),
    issuedNames: db.prepare("SELECT customer_id AS customerId, name, kind, owner, tx, status, created FROM issued WHERE tenant_id = ?").all(t),
    invoices: db.prepare("SELECT id, kind, label, years, owner, plan, network, asset, standard, usd_micro AS usdMicro, amount, status, txid, created FROM invoices WHERE tenant_id = ?").all(t),
    usage: accountUsage(t),
    auditLog: db.prepare("SELECT ts, actor, action, target FROM audit WHERE tenant_id = ? ORDER BY ts DESC LIMIT 1000").all(t),
    note: "On-chain data (names, records, transactions) is public and lives on the blockchain; it is not part of this export and cannot be erased by us.",
  };
}

/**
 * Deletes the account and the data tied to it. Invoices are kept without any link to the person (retained for accounting
 * as required by law), and the audit trail is anonymised. Names on the blockchain are unaffected.
 */
export function deleteAccount(res: ServerResponse, userId: string, confirmEmail: unknown) {
  const u = db.prepare("SELECT id, email, tenant_id FROM users WHERE id = ?").get(userId) as any;
  if (!u) throw new AddrError("not_found", "account not found", 404);
  if (normalizeEmail(confirmEmail) !== u.email) throw new AddrError("confirmation_mismatch", "type your account email to confirm deletion", 422);
  const t = u.tenant_id;
  const keyIds = (db.prepare("SELECT id FROM api_keys WHERE tenant_id = ?").all(t) as { id: string }[]).map((k) => k.id);
  const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
  db.exec("BEGIN IMMEDIATE");
  try {
    run("DELETE FROM sessions WHERE user_id = ?", userId);
    run("DELETE FROM deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE tenant_id = ?)", t);
    run("DELETE FROM webhooks WHERE tenant_id = ?", t);
    run("DELETE FROM namespaces WHERE tenant_id = ?", t);
    run("DELETE FROM issued WHERE tenant_id = ?", t);
    run("DELETE FROM idempotency WHERE tenant_id = ?", t);
    for (const k of keyIds) run("DELETE FROM usage WHERE subject = ?", k);
    run("DELETE FROM usage WHERE subject = ?", "u:" + userId);
    run("DELETE FROM api_keys WHERE tenant_id = ?", t);
    run("DELETE FROM login_codes WHERE email = ?", u.email);
    run("DELETE FROM outbox WHERE to_addr = ?", u.email);
    run("DELETE FROM users WHERE id = ?", userId);
    run("UPDATE tenants SET name = 'deleted' WHERE id = ?", t);
    run("UPDATE audit SET detail = NULL WHERE tenant_id = ?", t);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  audit(t, "user", "account.delete", userId);
  setCookie(res, "", 0);
  return { deleted: true };
}
