import crypto from "node:crypto";
import { Interface, getAddress, verifyMessage } from "ethers";
import {
  AddrError, NETWORKS, bytesToHex, encodeAddress, getNetwork, namehash, normalizeLabel, normalizeName, resolverAbi,
  validateAddress,
} from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { audit, db, now } from "./db.ts";
import { chainNow, deployment, enqueueTx, freeSigner, operator, operatorAddress, registry, registrar, resolver } from "./chain.ts";
import { getNameInfo } from "./resolve.ts";
import { clientIp, sha256 } from "./auth.ts";
import type { IncomingMessage } from "node:http";

const resolverIface = new Interface(resolverAbi);
const UINT = () => crypto.randomBytes(8).toString("hex");

export function claimMessage(name: string, tenantId: string): string {
  return `ADDR namespace claim\nname: ${name}\ntenant: ${tenantId}\nchain: ${config.chainId}`;
}

export async function claimNamespace(tenantId: string, nameIn: string, signature: string) {
  const name = normalizeName(nameIn);
  const node = namehash(name);
  const info = await getNameInfo(name);
  if (info.status !== "active" || !info.owner) throw new AddrError("name_not_active", `${name} is not an active name`, 409);
  let signer: string;
  try { signer = verifyMessage(claimMessage(name, tenantId), signature); } catch { throw new AddrError("bad_signature", "signature is invalid", 422); }
  if (getAddress(signer) !== getAddress(info.owner)) {
    throw new AddrError("not_owner", `signature must come from the current owner of ${name} (${info.owner})`, 403);
  }
  const taken = db.prepare("SELECT tenant_id FROM namespaces WHERE name = ?").get(name) as { tenant_id: string } | undefined;
  if (taken && taken.tenant_id !== tenantId) {
    // ownership may have moved on-chain; the on-chain owner proving control takes precedence over a stale claim
    db.prepare("DELETE FROM namespaces WHERE name = ?").run(name);
  }
  db.prepare("INSERT OR REPLACE INTO namespaces (tenant_id, name, node, owner_wallet, verified_at) VALUES (?,?,?,?,?)")
    .run(tenantId, name, node, getAddress(info.owner), now());
  audit(tenantId, "api", "namespace.claim", name);
  return namespaceStatus(tenantId, name);
}

export async function namespaceStatus(tenantId: string, name: string) {
  const ns = db.prepare("SELECT * FROM namespaces WHERE tenant_id = ? AND name = ?").get(tenantId, name) as any;
  if (!ns) throw new AddrError("namespace_not_found", "namespace not claimed by this tenant", 404);
  const info = await getNameInfo(name);
  const stillOwner = info.owner && getAddress(info.owner) === getAddress(ns.owner_wallet);
  const relayerApproved = operatorAddress ? ((await registry.isApprovedForName(ns.node, operatorAddress)) as boolean) : false;
  return {
    name, node: ns.node, ownerWallet: ns.owner_wallet, status: info.status, expiresAt: info.expiresAt,
    ownershipCurrent: Boolean(stillOwner), relayer: operatorAddress, relayerApproved,
    setup: relayerApproved ? null : {
      instruction: "Call registry.approveName(node, relayer, true) from the namespace owner wallet. The relayer can then create subnames but can never transfer the name or take over customer subnames.",
      registry: deployment.registry, node: ns.node, relayer: operatorAddress,
    },
  };
}

function buildRecordCalls(node: string, records: Record<string, string> | undefined, text?: Record<string, string>): string[] {
  const calls: string[] = [];
  for (const [netId, addr] of Object.entries(records ?? {})) {
    const net = getNetwork(netId);
    if (!net) throw new AddrError("network_unknown", `unknown network "${netId}"`, 422);
    const chk = validateAddress(net.id, addr);
    if (!chk.valid) throw new AddrError("invalid_address", `${net.name}: ${chk.error}`, 422);
    const raw = bytesToHex(encodeAddress(net, addr));
    calls.push(resolverIface.encodeFunctionData("setAddr(bytes32,uint256,bytes)", [node, net.coinType, raw]));
  }
  for (const [k, v] of Object.entries(text ?? {})) {
    calls.push(resolverIface.encodeFunctionData("setText", [node, k, v]));
  }
  return calls;
}

function planFor(tenantId: string) {
  const t = db.prepare("SELECT plan, plan_expires FROM tenants WHERE id = ?").get(tenantId) as any;
  const eff = t.plan === "free" ? "free" : t.plan_expires > now() ? t.plan : "free";
  return { ...config.plans[eff], id: eff };
}

export interface IssueInput {
  namespace: string;
  label: string;
  customerId: string;
  owner: string;
  records?: Record<string, string>;
  text?: Record<string, string>;
}

export async function issueSubname(tenantId: string, input: IssueInput) {
  if (!operator || !operatorAddress) throw new AddrError("relayer_unavailable", "this deployment has no relayer key", 503);
  const plan = planFor(tenantId);
  const ns = normalizeName(input.namespace);
  const nsRow = db.prepare("SELECT * FROM namespaces WHERE tenant_id = ? AND name = ?").get(tenantId, ns) as any;
  if (!nsRow) throw new AddrError("namespace_not_found", `claim ${ns} first (POST /v1/enterprise/namespaces)`, 404);
  const label = normalizeLabel(input.label);
  if (!input.customerId || input.customerId.length > 128) throw new AddrError("invalid_customer", "customerId required (max 128 chars)", 422);
  if (!validateAddress("ethereum", input.owner).valid) throw new AddrError("invalid_owner", "owner must be a valid EVM wallet address", 422);
  const owner = getAddress(input.owner);
  const count = (db.prepare("SELECT COUNT(*) AS c FROM issued WHERE tenant_id = ? AND kind = 'subname'").get(tenantId) as any).c;
  if (count >= plan.maxSubnames) {
    throw new AddrError("plan_limit", `issuance limit of the ${plan.name} plan reached (${plan.maxSubnames}). Upgrade to issue more.`, 402);
  }
  const full = `${label}.${ns}`;
  const node = namehash(full);
  const parentInfo = await getNameInfo(ns);
  if (parentInfo.status !== "active") throw new AddrError("namespace_inactive", `${ns} is ${parentInfo.status}`, 409);
  if (!((await registry.isApprovedForName(nsRow.node, operatorAddress)) as boolean)) {
    throw new AddrError("relayer_not_approved", "the namespace owner has not approved the relayer", 409);
  }
  const existing = await getNameInfo(full);
  if (existing.status === "active") throw new AddrError("name_unavailable", `${full} already exists`, 409);

  const calls = buildRecordCalls(node, input.records, input.text);
  const reg = registry.connect(operator) as typeof registry;
  const receipt = await enqueueTx(async () => {
    const t = await reg.createSubname(nsRow.node, label, owner, deployment.resolver, calls);
    return t.wait();
  });
  const id = "iss_" + UINT();
  db.prepare("INSERT INTO issued (id, tenant_id, customer_id, name, node, kind, owner, tx, status, created) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, tenantId, input.customerId, full, node, "subname", owner, receipt!.hash, "active", now());
  audit(tenantId, "api", "subname.issue", full, { customerId: input.customerId, tx: receipt!.hash });
  return { id, name: full, node, owner, customerId: input.customerId, tx: receipt!.hash, records: Object.keys(input.records ?? {}) };
}

export async function setRecordsForIssued(tenantId: string, nameIn: string, records: Record<string, string>, text?: Record<string, string>) {
  if (!operator || !operatorAddress) throw new AddrError("relayer_unavailable", "this deployment has no relayer key", 503);
  const name = normalizeName(nameIn);
  const row = db.prepare("SELECT * FROM issued WHERE tenant_id = ? AND name = ?").get(tenantId, name) as any;
  if (!row) throw new AddrError("not_found", "name was not issued by this tenant", 404);
  const authorised = (await registry.isAuthorised(row.node, operatorAddress)) as boolean;
  if (!authorised) {
    throw new AddrError("customer_consent_required",
      "the customer owns this name and has not authorised the relayer. They can call registry.approveName(node, relayer, true) to let your platform manage records.", 409);
  }
  const calls = buildRecordCalls(row.node, records, text);
  if (!calls.length) throw new AddrError("nothing_to_do", "no records provided", 422);
  const res = resolver.connect(operator) as typeof resolver;
  const rc = await enqueueTx(async () => (await res.multicall(calls)).wait());
  audit(tenantId, "api", "records.set", name, { tx: rc!.hash });
  return { name, tx: rc!.hash, updated: Object.keys(records) };
}

export function customerNames(tenantId: string, customerId: string) {
  return db.prepare("SELECT id, name, node, kind, owner, tx, status, created FROM issued WHERE tenant_id = ? AND customer_id = ? ORDER BY created DESC").all(tenantId, customerId);
}

export function listIssued(tenantId: string, limit = 100, offset = 0) {
  return db.prepare("SELECT id, customer_id AS customerId, name, kind, owner, tx, status, created FROM issued WHERE tenant_id = ? ORDER BY created DESC LIMIT ? OFFSET ?").all(tenantId, limit, offset);
}

export async function removeIssued(tenantId: string, nameIn: string) {
  if (!operator) throw new AddrError("relayer_unavailable", "no relayer", 503);
  const name = normalizeName(nameIn);
  const row = db.prepare("SELECT * FROM issued WHERE tenant_id = ? AND name = ?").get(tenantId, name) as any;
  if (!row) throw new AddrError("not_found", "name was not issued by this tenant", 404);
  if ((await registry.parentControlBurned(row.node)) as boolean) {
    throw new AddrError("customer_sovereign", "the customer has made this name sovereign; the issuer can no longer remove it", 409);
  }
  const reg = registry.connect(operator) as typeof registry;
  const rc = await enqueueTx(async () => (await reg.removeSubname(row.node)).wait());
  db.prepare("UPDATE issued SET status = 'removed' WHERE id = ?").run(row.id);
  audit(tenantId, "api", "subname.remove", name, { tx: rc!.hash });
  return { name, tx: rc!.hash };
}

export function dashboard(tenantId: string) {
  const c = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).c as number;
  const keys = db.prepare("SELECT id FROM api_keys WHERE tenant_id = ?").all(tenantId) as { id: string }[];
  const ids = keys.map((k) => k.id);
  const days = ids.length
    ? db.prepare(`SELECT day, SUM(count) AS requests, SUM(errors) AS errors FROM usage WHERE subject IN (${ids.map(() => "?").join(",")}) GROUP BY day ORDER BY day DESC LIMIT 30`).all(...ids)
    : [];
  return {
    plan: planFor(tenantId).id,
    namespaces: c("SELECT COUNT(*) AS c FROM namespaces WHERE tenant_id = ?", tenantId),
    issuedTotal: c("SELECT COUNT(*) AS c FROM issued WHERE tenant_id = ?", tenantId),
    issuedActive: c("SELECT COUNT(*) AS c FROM issued WHERE tenant_id = ? AND status = 'active'", tenantId),
    issuedLast24h: c("SELECT COUNT(*) AS c FROM issued WHERE tenant_id = ? AND created > ?", tenantId, now() - 86400),
    customers: c("SELECT COUNT(DISTINCT customer_id) AS c FROM issued WHERE tenant_id = ?", tenantId),
    webhooks: c("SELECT COUNT(*) AS c FROM webhooks WHERE tenant_id = ? AND active = 1", tenantId),
    deliveriesFailed: c("SELECT COUNT(*) AS c FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.tenant_id = ? AND d.status = 'failed'", tenantId),
    openInvoices: c("SELECT COUNT(*) AS c FROM invoices WHERE tenant_id = ? AND status IN ('pending','confirming')", tenantId),
    usageByDay: days,
  };
}

export async function expiringNamespaces(tenantId: string, withinDays = 60) {
  const rows = db.prepare("SELECT name FROM namespaces WHERE tenant_id = ?").all(tenantId) as { name: string }[];
  const out: { name: string; status: string; expiresAt: number }[] = [];
  for (const r of rows) {
    const info = await getNameInfo(r.name);
    if (info.expiresAt && info.expiresAt - now() < withinDays * 86400) out.push({ name: r.name, status: info.status, expiresAt: info.expiresAt });
  }
  return out;
}

// -------------------------------------------------------------- free-claim vouchers

function rateCheck(bucket: string, limit: number, windowSec = 86400) {
  const t = now();
  db.prepare("DELETE FROM rate_events WHERE ts < ?").run(t - 2 * 86400);
  const c = (db.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE bucket = ? AND ts > ?").get(bucket, t - windowSec) as any).c;
  if (c >= limit) throw new AddrError("rate_limited", "free claim limit reached for now; try again later", 429);
  db.prepare("INSERT INTO rate_events (bucket, ts) VALUES (?, ?)").run(bucket, t);
}

export async function issueFreeVoucher(req: IncomingMessage, labelIn: string, ownerIn: string) {
  if (!freeSigner) throw new AddrError("claims_unavailable", "free claims are not enabled on this server", 503);
  const label = normalizeLabel(labelIn);
  if (label.length < 5) throw new AddrError("not_free", "free names must be at least 5 characters", 422);
  if (!validateAddress("ethereum", ownerIn).valid) throw new AddrError("invalid_owner", "owner must be a valid EVM wallet address", 422);
  const owner = getAddress(ownerIn);
  if ((await registrar.freeClaimed(owner)) as boolean) throw new AddrError("free_already_claimed", "this wallet already claimed its free name", 409);
  if (!((await registrar.available(label)) as boolean)) throw new AddrError("name_unavailable", `${label}.addr is not available`, 409);
  rateCheck("freeclaim:ip:" + sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24), config.freeClaimsPerIpPerDay);
  rateCheck("freeclaim:owner:" + owner, 5);
  const deadline = (await chainNow(true)) + 3600;
  const domain = { name: "AddrRegistrar", version: "1", chainId: config.chainId, verifyingContract: deployment.registrar };
  const types = { FreeClaim: [{ name: "owner", type: "address" }, { name: "labelhash", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
  const labelhash = (await import("ethers")).keccak256((await import("ethers")).toUtf8Bytes(label));
  const signature = await freeSigner.signTypedData(domain, types, { owner, labelhash, deadline });
  return { label, owner, deadline, signature, expiresInSeconds: 3600, note: "Use with registrar.commit/register (commit-reveal). One free name per wallet; the voucher is single-use per wallet." };
}

export { NETWORKS };
