import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- index of on-chain state (search/cache only; resolution always re-reads the chain)
CREATE TABLE IF NOT EXISTS names (
  node TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  parent TEXT,
  owner TEXT,
  resolver TEXT,
  expires INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  free INTEGER NOT NULL DEFAULT 0,
  created_block INTEGER,
  updated_block INTEGER
);
CREATE INDEX IF NOT EXISTS names_label ON names(label);
CREATE INDEX IF NOT EXISTS names_owner ON names(owner);
CREATE INDEX IF NOT EXISTS names_parent ON names(parent);

CREATE TABLE IF NOT EXISTS records (
  node TEXT NOT NULL,
  coin_type INTEGER NOT NULL,
  address TEXT NOT NULL,       -- human form; '' when cleared
  raw TEXT NOT NULL,
  version INTEGER NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (node, coin_type)
);
CREATE INDEX IF NOT EXISTS records_addr ON records(address);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  contract TEXT NOT NULL,
  type TEXT NOT NULL,
  node TEXT,
  data TEXT NOT NULL,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS events_node ON events(node, id);

-- tenants, api keys, usage
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT,
  scopes TEXT NOT NULL DEFAULT 'read',
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage (
  subject TEXT NOT NULL,       -- key id or 'ip:<hash>'
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);

CREATE TABLE IF NOT EXISTS namespaces (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL UNIQUE,
  node TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS issued (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  node TEXT NOT NULL,
  kind TEXT NOT NULL,           -- subname | global
  owner TEXT NOT NULL,
  tx TEXT,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS issued_customer ON issued(tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS idempotency (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tenant_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

-- webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,         -- JSON array, or ["*"]
  scope TEXT NOT NULL,          -- namespace name this webhook is limited to ('' = tenant-owned names/invoices)
  active INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,         -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt);

-- payments
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  kind TEXT NOT NULL,           -- name | renew | plan
  label TEXT,
  years INTEGER,
  owner TEXT,
  plan TEXT,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  standard TEXT NOT NULL,
  usd_micro INTEGER NOT NULL,
  rate TEXT NOT NULL,           -- USD per unit used for the quote
  amount TEXT NOT NULL,         -- base units, string bigint (includes unique tag)
  pay_to TEXT NOT NULL,
  status TEXT NOT NULL,         -- pending | confirming | paid | completed | expired | underpaid | needs_review | registration_failed
  txid TEXT,
  received TEXT,
  confirmations INTEGER,
  reg_tx TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_txid ON invoices(network, txid) WHERE txid IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email, created);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  ua TEXT,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  last_error TEXT,
  delivered_via TEXT,
  created INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_bucket ON rate_events(bucket, ts);

CREATE TABLE IF NOT EXISTS rpc_health (
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  block INTEGER
);
`);

export function getMeta(k: string): string | undefined {
  const r = db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
  return r?.v;
}
export function setMeta(k: string, v: string) {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const now = () => Math.floor(Date.now() / 1000);
export function audit(tenantId: string | null, actor: string, action: string, target?: string, detail?: unknown) {
  db.prepare("INSERT INTO audit (ts, tenant_id, actor, action, target, detail) VALUES (?,?,?,?,?,?)")
    .run(now(), tenantId, actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail));
}

try { db.exec("ALTER TABLE api_keys ADD COLUMN last_used INTEGER"); } catch { /* column already exists */ }
