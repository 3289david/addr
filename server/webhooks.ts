import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { AddrError } from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { db, now } from "./db.ts";

export const EVENT_TYPES = [
  "name.registered", "name.renewed", "name.transferred", "name.resolver_changed", "name.locked",
  "record.changed", "text.changed", "records.cleared", "subname.created", "subname.removed",
  "invoice.paid", "invoice.completed", "invoice.failed",
] as const;

const BACKOFF = [60, 300, 1800, 7200, 43200]; // seconds; 6 attempts total

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
}

/** Throws unless the URL is https (or http on loopback when explicitly allowed) and not pointing at internal addresses. */
export async function assertSafeWebhookUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AddrError("invalid_url", "invalid webhook url"); }
  if (u.username || u.password) throw new AddrError("invalid_url", "credentials in url are not allowed");
  if (config.allowInsecureWebhooks) return;
  if (u.protocol !== "https:") throw new AddrError("invalid_url", "webhook url must use https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new AddrError("invalid_url", "webhook url resolves to a private or unreachable address");
  }
}

export function sign(secret: string, ts: number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export interface EmitInput {
  id: string;
  type: string;
  name?: string | null;      // full dotted name, used for namespace scoping
  tenantId?: string | null;  // direct tenant attribution (invoices)
  data: unknown;
}

export function emit(ev: EmitInput) {
  const hooks = db.prepare("SELECT * FROM webhooks WHERE active = 1").all() as any[];
  const created = now();
  for (const h of hooks) {
    const events: string[] = JSON.parse(h.events);
    if (!events.includes("*") && !events.includes(ev.type)) continue;
    let match = false;
    if (h.scope) {
      match = !!ev.name && (ev.name === h.scope || ev.name.endsWith("." + h.scope));
    } else if (ev.tenantId) {
      match = ev.tenantId === h.tenant_id;
    } else if (ev.name) {
      match = !!db.prepare("SELECT 1 FROM issued WHERE tenant_id = ? AND name = ?").get(h.tenant_id, ev.name);
    }
    if (!match) continue;
    const payload = JSON.stringify({ id: ev.id, type: ev.type, created, data: ev.data });
    const did = crypto.randomUUID();
    try {
      db.prepare("INSERT INTO deliveries (id, webhook_id, event_id, type, payload, status, attempts, next_attempt, created) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(did, h.id, ev.id, ev.type, payload, "pending", 0, created, created);
    } catch { /* duplicate re-index of same event */ }
  }
}

async function deliverOne(d: any) {
  const h = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(d.webhook_id) as any;
  if (!h) return;
  const ts = now();
  let status = 0;
  let err: string | null = null;
  try {
    await assertSafeWebhookUrl(h.url);
    const res = await fetch(h.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ADDR-Webhooks/1",
        "x-addr-event": d.type,
        "x-addr-delivery": d.id,
        "x-addr-signature": `t=${ts},v1=${sign(h.secret, ts, d.payload)}`,
      },
      body: d.payload,
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });
    status = res.status;
    if (status < 200 || status >= 300) err = `http ${status}`;
  } catch (e) {
    err = (e as Error).message.slice(0, 200);
  }
  const attempts = d.attempts + 1;
  if (!err) {
    db.prepare("UPDATE deliveries SET status='delivered', attempts=?, last_status=?, last_error=NULL WHERE id=?").run(attempts, status, d.id);
  } else if (attempts > BACKOFF.length) {
    db.prepare("UPDATE deliveries SET status='failed', attempts=?, last_status=?, last_error=? WHERE id=?").run(attempts, status || null, err, d.id);
  } else {
    db.prepare("UPDATE deliveries SET attempts=?, next_attempt=?, last_status=?, last_error=? WHERE id=?")
      .run(attempts, now() + BACKOFF[attempts - 1], status || null, err, d.id);
  }
}

let running = false;
export async function runDeliveries() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare("SELECT * FROM deliveries WHERE status='pending' AND next_attempt <= ? ORDER BY next_attempt LIMIT 25").all(now()) as any[];
    await Promise.all(due.map(deliverOne));
  } finally {
    running = false;
  }
}

/** Manual replay (e.g. after the receiver was down longer than the retry window). */
export function requeue(deliveryId: string, webhookId: string): boolean {
  const r = db.prepare("UPDATE deliveries SET status='pending', attempts=0, next_attempt=? WHERE id=? AND webhook_id=?").run(now(), deliveryId, webhookId);
  return Number(r.changes) > 0;
}

export function startWebhookWorker() {
  setInterval(() => runDeliveries().catch((e) => console.error("webhook worker", e)), 2000).unref();
}
