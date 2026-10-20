// Enforces the retention periods published in the privacy policy (config.retentionDays).
import fs from "node:fs";
import { config } from "./config.ts";
import { db, now } from "./db.ts";

const DAY = 86400;

export function runRetention(): Record<string, number> {
  const r = config.retentionDays;
  const t = now();
  const n = (sql: string, ...args: any[]) => Number(db.prepare(sql).run(...args).changes);
  const out: Record<string, number> = {};
  out.loginCodes = n("DELETE FROM login_codes WHERE created < ?", t - r.loginCodes * DAY);
  out.rateEvents = n("DELETE FROM rate_events WHERE ts < ?", t - r.rateEvents * DAY);
  // message bodies contain one-time codes: blank them soon after delivery, keep delivery metadata longer
  out.mailBodies = n("UPDATE outbox SET raw = '' WHERE raw != '' AND ((status = 'sent' AND sent_at < ?) OR (status = 'failed' AND created < ?))", t - r.sentMailBodies * DAY, t - r.sentMailBodies * DAY);
  out.mailLog = n("DELETE FROM outbox WHERE created < ?", t - r.mailLog * DAY);
  out.sessions = n("DELETE FROM sessions WHERE expires < ?", t - r.sessionsAfterExpiry * DAY);
  out.ipUsage = n("DELETE FROM usage WHERE subject LIKE 'ip:%' AND day < ?", new Date((t - r.ipUsage * DAY) * 1000).toISOString().slice(0, 10));
  out.deliveries = n("DELETE FROM deliveries WHERE created < ? AND status != 'pending'", t - r.webhookDeliveries * DAY);
  out.idempotency = n("DELETE FROM idempotency WHERE created < ?", t - r.idempotency * DAY);
  out.rpcHealth = n("DELETE FROM rpc_health WHERE ts < ?", t - r.rpcHealth * DAY);
  out.audit = n("DELETE FROM audit WHERE ts < ?", t - r.audit * DAY);
  out.reports = n("DELETE FROM reports WHERE status = 'closed' AND updated < ?", t - r.closedReports * DAY);
  // development mail files
  try {
    for (const f of fs.readdirSync(config.mail.outboxDir)) {
      const p = config.mail.outboxDir + "/" + f;
      if (fs.statSync(p).mtimeMs < (t - r.sentMailBodies * DAY) * 1000) fs.unlinkSync(p);
    }
  } catch { /* no outbox directory */ }
  return out;
}

export function startRetention() {
  const tick = () => { try { runRetention(); } catch (e) { console.error("retention", e); } };
  tick();
  setInterval(tick, 6 * 3600 * 1000).unref();
}
