import crypto from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  AddrError, DEFAULT_TIERS, NETWORKS, UNSUPPORTED_NETWORKS, findLookalikes, getNetwork, isValidLabel, namehash,
  normalizeLabel, normalizeName, quote, validateAddress, isMultiNetworkAsset,
} from "../packages/core/src/index.ts";
import {
  clientIp, createKey, createTenant, requireAdmin, requirePlan, requireTenant, sha256,
} from "./auth.ts";
import { config } from "./config.ts";
import { audit, db, now } from "./db.ts";
import { deployment, probeRpcs, registrar, registry, operatorAddress, enqueueTx, operator, freeSigner } from "./chain.ts";
import { route, created, idempotent } from "./http.ts";
import { allRecords, getNameInfo, resolveName, reverseLookup } from "./resolve.ts";
import {
  claimMessage, claimNamespace, customerNames, dashboard, expiringNamespaces, issueFreeVoucher, issueSubname,
  listIssued, namespaceStatus, removeIssued, setRecordsForIssued,
} from "./enterprise.ts";
import { createInvoice, finalize, paymentMethods, publicInvoice, submitPayment, usdPrices } from "./payments.ts";
import { assertSafeWebhookUrl, EVENT_TYPES, requeue } from "./webhooks.ts";
import { indexOnce } from "./indexer.ts";
import { accountUsage, createAccountKey, deleteAccount, exportAccount, isAdminEmail, listKeys, logout, requestLogin, revokeKey, verifyCode, verifyToken } from "./accounts.ts";
import { mailDnsStatus } from "./mail.ts";
import { runRetention } from "./retention.ts";
import type { Principal } from "./auth.ts";

function needSession(p: Principal): string {
  if (!p.session) throw new AddrError("login_required", "sign in to use this endpoint", 401);
  return p.session.tenantId;
}

const str = (v: unknown, name: string, max = 256): string => {
  if (typeof v !== "string" || !v || v.length > max) throw new AddrError("invalid_request", `${name} is required (string, max ${max})`, 422);
  return v;
};

export function registerRoutes() {
  // ------------------------------------------------------------- meta
  route("GET", "/v1/health", async () => {
    const rpc = await probeRpcs();
    const last = db.prepare("SELECT v FROM meta WHERE k='last_block'").get() as { v: string } | undefined;
    const head = rpc.find((r) => r.ok)?.block ?? null;
    return {
      status: rpc.some((r) => r.ok) ? "ok" : "degraded", chainId: config.chainId, rpc,
      indexedBlock: last ? Number(last.v) : null, headBlock: head, indexLag: head !== null && last ? head - Number(last.v) : null,
    };
  });

  route("GET", "/v1/contracts", () => ({
    chainId: deployment.chainId, registry: deployment.registry, resolver: deployment.resolver,
    registrar: deployment.registrar, timelock: deployment.timelock, ethUsdFeed: deployment.ethUsdFeed,
    acceptedTokens: deployment.tokens, treasury: deployment.treasury, startBlock: deployment.startBlock, relayer: operatorAddress,
    tld: "addr",
    chain: { id: deployment.chainId, name: process.env.CHAIN_NAME || (deployment.chainId === 31337 ? "ADDR Local" : `Chain ${deployment.chainId}`), rpcUrl: process.env.PUBLIC_RPC_URL || config.rpcUrls[0], explorer: process.env.CHAIN_EXPLORER || "", currency: process.env.CHAIN_CURRENCY || "ETH", minCommitmentAge: undefined },
  }));

  route("GET", "/v1/accounts/:address/names", (c) => {
    if (!validateAddress("ethereum", c.params.address).valid) throw new AddrError("invalid_address", "invalid address", 422);
    const a = getAddress(c.params.address);
    const rows = db.prepare("SELECT name, parent, expires, free, locked_until AS lockedUntil FROM names WHERE lower(owner) = lower(?) ORDER BY parent IS NOT NULL, name LIMIT 500").all(a) as any[];
    return { address: a, names: rows.map((r) => ({ name: r.name, level: r.parent ? "sub" : "second", expiresAt: r.parent ? null : r.expires, free: !!r.free, lockedUntil: r.lockedUntil || null })) };
  });

  route("GET", "/v1/networks", () => ({
    supported: NETWORKS.map((n) => ({
      id: n.id, name: n.name, family: n.family, coinType: n.coinType, chainId: n.chainId ?? null, nativeSymbol: n.nativeSymbol,
      assets: n.assets.map((a) => ({ symbol: a.symbol, standard: a.standard, contract: a.contract ?? null, decimals: a.decimals })),
    })),
    unsupported: UNSUPPORTED_NETWORKS,
    multiNetworkAssets: ["USDT", "USDC"].filter(isMultiNetworkAsset),
  }));

  route("GET", "/v1/pricing", async () => {
    const tiers: Record<string, unknown> = {};
    for (let l = 1; l <= 5; l++) {
      const [price, enabled] = (await registrar.tiers(l)) as [bigint, boolean];
      tiers[l === 5 ? "5+ (additional)" : String(l)] = { usdPerYear: Number(price) / 1e6, enabled };
    }
    return {
      currency: "USD", unit: "per year", source: "on-chain registrar", tiers, defaults: DEFAULT_TIERS,
      freeTier: "1 name of 5+ characters per wallet, renewals free",
      maxYears: 5, gracePeriodDays: 30,
      plans: Object.entries(config.plans).map(([id, p]) => ({ id, name: p.name, priceKrwPerMonth: p.priceKrw, dailyRequests: p.dailyLimit < 1e11 ? p.dailyLimit : null, maxSubnames: p.maxSubnames < 1e11 ? p.maxSubnames : null })),
      acceptedPaymentMethods: paymentMethods(),
      onchainTokens: deployment.tokens,
    };
  });

  route("GET", "/v1/prices", async () => ({ usdPerUnit: await usdPrices(), source: config.priceApi }));

  // ------------------------------------------------------- names + resolution
  route("GET", "/v1/names/:name", async (c) => getNameInfo(c.params.name));

  route("GET", "/v1/names/:name/records", async (c) => allRecords(c.params.name));

  route("GET", "/v1/names/:name/resolve", async (c) => {
    const q = c.query;
    return resolveName(c.params.name, q.get("network") ?? undefined, q.get("asset") ?? undefined, q.get("standard") ?? undefined);
  });

  route("GET", "/v1/names/:name/history", async (c) => {
    const name = normalizeName(c.params.name);
    const node = namehash(name);
    const rows = db.prepare("SELECT tx, block, ts, contract, type, data FROM events WHERE node = ? AND type NOT LIKE 'registrar.%' ORDER BY id DESC LIMIT 200").all(node) as any[];
    return { name, node, events: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) };
  });

  route("POST", "/v1/resolutions", async (c) => {
    const reqs = c.body?.requests;
    const max = config.plans[c.principal.plan === "anon" ? "free" : c.principal.plan].batch;
    if (!Array.isArray(reqs) || reqs.length === 0 || reqs.length > max) throw new AddrError("invalid_request", `requests must be an array of 1..${max}`, 422);
    const results = await Promise.all(reqs.map(async (r: any) => {
      try { return { ok: true, ...(await resolveName(str(r.name, "name"), r.network, r.asset, r.standard)) }; }
      catch (e) {
        if (e instanceof AddrError) return { ok: false, name: r?.name, error: { code: e.code, message: e.message } };
        throw e;
      }
    }));
    return { results };
  });

  route("GET", "/v1/addresses/:address/reverse", async (c) => reverseLookup(c.params.address));

  route("GET", "/v1/validate", (c) => {
    const network = str(c.query.get("network"), "network");
    return { network, address: c.query.get("address"), ...validateAddress(network, c.query.get("address") ?? "") };
  });

  route("GET", "/v1/search", async (c) => {
    const raw = (c.query.get("q") ?? "").trim().toLowerCase().replace(/\.addr$/, "");
    if (!raw) throw new AddrError("invalid_request", "q is required", 422);
    const label = raw;
    const valid = isValidLabel(label);
    const like = label.replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const matches = db.prepare("SELECT name, owner, expires, parent FROM names WHERE label LIKE ? ESCAPE '\\' AND parent IS NULL ORDER BY length(label), label LIMIT 20").all(like) as any[];
    let exact: any = null;
    if (valid) {
      const owner = c.query.get("owner");
      const avail = (await registrar.available(label)) as boolean;
      const claimed = owner && validateAddress("ethereum", owner).valid ? ((await registrar.freeClaimed(getAddress(owner))) as boolean) : false;
      const tiers: Record<number, { priceUsdMicro: number; enabled: boolean }> = {};
      for (let l = 1; l <= 5; l++) { const [p, e] = (await registrar.tiers(l)) as [bigint, boolean]; tiers[l] = { priceUsdMicro: Number(p), enabled: e }; }
      const prem = Number((await registrar.premiumUsd(keccak256(toUtf8Bytes(label)))) as bigint);
      const reserved = (await registrar.reserved(keccak256(toUtf8Bytes(label)))) as boolean;
      const q = quote(label, 1, claimed, tiers, prem);
      const info = await getNameInfo(label + ".addr");
      exact = {
        name: `${label}.addr`, available: avail, status: info.status, reserved, owner: info.owner,
        expiresAt: info.expiresAt, gracePeriodEndsAt: info.gracePeriodEndsAt,
        price: { free: q.free && !reserved, usdPerYear: q.usdPerYearMicro / 1e6, available: q.available },
        premium: prem > 0,
      };
    }
    const candidates = (db.prepare("SELECT label FROM names WHERE parent IS NULL AND length(label) BETWEEN ? AND ? LIMIT 5000").all(label.length - 1, label.length + 1) as any[]).map((r) => r.label);
    return { query: label, valid, exact, matches, lookalikes: valid ? findLookalikes(label, candidates).map((l) => ({ ...l, name: l.name + ".addr" })) : [] };
  });

  route("POST", "/v1/free-claims", async (c) => issueFreeVoucher(c.req, str(c.body?.label, "label"), str(c.body?.owner, "owner")));

  // --------------------------------------------------------------- keys + usage
  // --------------------------------------------------------------- sign-in (email, passwordless)
  route("POST", "/v1/auth/email", (c) => requestLogin(c.req, c.body?.email, typeof c.body?.next === "string" ? c.body.next : undefined));
  route("POST", "/v1/auth/verify", (c) => verifyCode(c.req, c.res, c.body?.email, c.body?.code));
  route("POST", "/v1/auth/verify-token", (c) => verifyToken(c.req, c.res, c.body?.token));
  route("POST", "/v1/auth/logout", (c) => { logout(c.req, c.res, !!c.body?.all); return { ok: true }; });
  route("GET", "/v1/auth/me", (c) => {
    const s = c.principal.session;
    if (!s) return { authenticated: false, signupOpen: true };
    return { authenticated: true, user: { id: s.userId, email: s.email }, csrf: s.csrf, tenant: { id: s.tenantId, plan: c.principal.plan, dailyLimit: c.principal.dailyLimit }, isAdmin: isAdminEmail(s.email) };
  });
  route("GET", "/v1/account/keys", (c) => ({ keys: listKeys(needSession(c.principal)) }));
  route("POST", "/v1/account/keys", (c) => created(createAccountKey(needSession(c.principal), c.body?.label, c.body?.scopes)));
  route("DELETE", "/v1/account/keys/:id", (c) => { revokeKey(needSession(c.principal), c.params.id); return { ok: true }; });
  route("GET", "/v1/account/usage", (c) => {
    const t = needSession(c.principal);
    return { plan: c.principal.plan, dailyLimit: c.principal.dailyLimit, days: accountUsage(t) };
  });
  route("GET", "/v1/account/export", (c) => { needSession(c.principal); return exportAccount(c.principal.session!.userId); });
  route("POST", "/v1/account/delete", (c) => { needSession(c.principal); return deleteAccount(c.res, c.principal.session!.userId, c.body?.email); });
  route("POST", "/v1/admin/retention/run", (c) => { requireAdmin(c.req, c.principal); return runRetention(); });
  route("GET", "/v1/admin/mail", async (c) => {
    requireAdmin(c.req, c.principal);
    const rows = db.prepare("SELECT id, to_addr AS \"to\", subject, status, attempts, last_error AS lastError, delivered_via AS via, created, sent_at AS sentAt FROM outbox ORDER BY created DESC LIMIT 50").all();
    return { dns: await mailDnsStatus(), outbox: rows };
  });

  route("GET", "/v1/usage", (c) => {
    const keyId = c.principal.keyId;
    const rows = db.prepare("SELECT day, count, errors FROM usage WHERE subject = ? ORDER BY day DESC LIMIT 30").all(c.principal.subject);
    return { plan: c.principal.plan, dailyLimit: c.principal.dailyLimit, keyId: keyId ?? null, days: rows };
  });

  // ------------------------------------------------------------------ legal and reports
  route("GET", "/v1/legal", () => ({
    ...config.legal,
    configured: Boolean(config.legal.entity && config.legal.email),
    retentionDays: config.retentionDays,
    cookies: ["addr_session (strictly necessary: keeps you signed in)"],
  }));

  route("POST", "/v1/reports", (c) => {
    const ip = sha256(clientIp(c.req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24);
    const t = now();
    const n = (db.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE bucket = ? AND ts > ?").get("report:" + ip, t - 86400) as any).c;
    if (n >= 5) throw new AddrError("rate_limited", "Too many reports from this network today.", 429);
    db.prepare("INSERT INTO rate_events (bucket, ts) VALUES (?, ?)").run("report:" + ip, t);
    const category = String(c.body?.category ?? "");
    if (!["impersonation", "trademark", "scam", "illegal", "abuse", "other"].includes(category)) throw new AddrError("invalid_request", "choose a category", 422);
    const details = str(c.body?.details, "details", 4000);
    const name = c.body?.name ? normalizeName(String(c.body.name)) : null;
    const contact = c.body?.contact ? String(c.body.contact).slice(0, 200) : null;
    const id = "rep_" + crypto.randomBytes(6).toString("hex");
    db.prepare("INSERT INTO reports (id, category, name, details, contact, created, updated) VALUES (?,?,?,?,?,?,?)").run(id, category, name, details, contact, t, t);
    return created({ id, status: "open", note: "Report received. Names are not removed by ADDR: ownership lives in the registry contract. Reports are used to warn users and to inform the owner, and to act on API and website listings." });
  });

  route("GET", "/v1/admin/reports", (c) => {
    requireAdmin(c.req, c.principal);
    return { reports: db.prepare("SELECT * FROM reports ORDER BY created DESC LIMIT 200").all() };
  });
  route("PATCH", "/v1/admin/reports/:id", (c) => {
    requireAdmin(c.req, c.principal);
    const status = str(c.body?.status, "status");
    if (!["open", "reviewing", "closed"].includes(status)) throw new AddrError("invalid_request", "bad status", 422);
    const r = db.prepare("UPDATE reports SET status = ?, note = ?, updated = ? WHERE id = ?").run(status, c.body?.note ? String(c.body.note).slice(0, 2000) : null, now(), c.params.id);
    if (!Number(r.changes)) throw new AddrError("not_found", "report not found", 404);
    audit(null, "admin", "report." + status, c.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ payments
  route("GET", "/v1/payments/methods", () => ({ methods: paymentMethods() }));

  route("POST", "/v1/invoices", async (c) => {
    const b = c.body ?? {};
    const kind = b.kind ?? "name";
    if (!["name", "renew"].includes(kind)) throw new AddrError("invalid_request", "kind must be name or renew (plans: POST /v1/enterprise/plan)", 422);
    return created(await createInvoice({
      kind, label: str(b.label, "label"), years: b.years, owner: str(b.owner, "owner"),
      network: str(b.network, "network"), asset: str(b.asset, "asset"), standard: b.standard,
    }));
  });
  route("GET", "/v1/invoices/:id", (c) => publicInvoice(c.params.id));
  route("POST", "/v1/invoices/:id/payment", async (c) => submitPayment(c.params.id, str(c.body?.txid, "txid", 130)));

  // -------------------------------------------------------------------- webhooks
  route("POST", "/v1/webhooks", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    const plan = config.plans[c.principal.plan];
    const count = (db.prepare("SELECT COUNT(*) AS c FROM webhooks WHERE tenant_id = ? AND active = 1").get(tenantId) as any).c;
    if (plan.webhooks === 0) requirePlan(c.principal, "startup");
    if (count >= plan.webhooks) throw new AddrError("plan_limit", `webhook limit reached (${plan.webhooks})`, 402);
    const url = str(c.body?.url, "url", 500);
    await assertSafeWebhookUrl(url);
    const events: string[] = Array.isArray(c.body?.events) && c.body.events.length ? c.body.events : ["*"];
    for (const e of events) if (e !== "*" && !(EVENT_TYPES as readonly string[]).includes(e)) throw new AddrError("invalid_event", `unknown event ${e}`, 422);
    let scope = "";
    if (c.body?.namespace) {
      scope = normalizeName(c.body.namespace);
      if (!db.prepare("SELECT 1 FROM namespaces WHERE tenant_id = ? AND name = ?").get(tenantId, scope)) {
        throw new AddrError("namespace_not_found", "claim the namespace first to scope a webhook to it", 404);
      }
    }
    const id = "wh_" + crypto.randomBytes(8).toString("hex");
    const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO webhooks (id, tenant_id, url, secret, events, scope, active, created) VALUES (?,?,?,?,?,?,1,?)")
      .run(id, tenantId, url, secret, JSON.stringify(events), scope, now());
    audit(tenantId, "api", "webhook.create", id, { url });
    return created({ id, url, events, namespace: scope || null, secret, note: "Verify X-Addr-Signature: t=<ts>,v1=HMAC_SHA256(secret, `${t}.${body}`). The secret is shown once." });
  });
  route("GET", "/v1/webhooks", (c) => {
    const tenantId = requireTenant(c.principal);
    const rows = db.prepare("SELECT id, url, events, scope, active, created FROM webhooks WHERE tenant_id = ?").all(tenantId) as any[];
    return { webhooks: rows.map((r) => ({ ...r, events: JSON.parse(r.events), namespace: r.scope || null })) };
  });
  route("DELETE", "/v1/webhooks/:id", (c) => {
    const tenantId = requireTenant(c.principal, "write");
    const r = db.prepare("UPDATE webhooks SET active = 0 WHERE id = ? AND tenant_id = ?").run(c.params.id, tenantId);
    if (!Number(r.changes)) throw new AddrError("not_found", "webhook not found", 404);
    return { ok: true };
  });
  route("GET", "/v1/webhooks/:id/deliveries", (c) => {
    const tenantId = requireTenant(c.principal);
    if (!db.prepare("SELECT 1 FROM webhooks WHERE id = ? AND tenant_id = ?").get(c.params.id, tenantId)) throw new AddrError("not_found", "webhook not found", 404);
    return { deliveries: db.prepare("SELECT id, event_id AS eventId, type, status, attempts, last_status AS lastStatus, last_error AS lastError, next_attempt AS nextAttempt, created FROM deliveries WHERE webhook_id = ? ORDER BY created DESC LIMIT 100").all(c.params.id) };
  });
  route("POST", "/v1/webhooks/:id/deliveries/:did/retry", (c) => {
    const tenantId = requireTenant(c.principal, "write");
    if (!db.prepare("SELECT 1 FROM webhooks WHERE id = ? AND tenant_id = ?").get(c.params.id, tenantId)) throw new AddrError("not_found", "webhook not found", 404);
    if (!requeue(c.params.did, c.params.id)) throw new AddrError("not_found", "delivery not found", 404);
    return { ok: true };
  });

  // ------------------------------------------------------------------ enterprise
  route("GET", "/v1/enterprise/claim-message", (c) => {
    const tenantId = requireTenant(c.principal);
    const name = normalizeName(str(c.query.get("name"), "name"));
    return { name, message: claimMessage(name, tenantId), method: "personal_sign (EIP-191) by the current owner wallet" };
  });

  route("POST", "/v1/enterprise/namespaces", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    return created(await claimNamespace(tenantId, str(c.body?.name, "name"), str(c.body?.signature, "signature", 300)));
  });
  route("GET", "/v1/enterprise/namespaces/:name", async (c) => namespaceStatus(requireTenant(c.principal), normalizeName(c.params.name)));
  route("GET", "/v1/enterprise/namespaces", (c) => {
    const tenantId = requireTenant(c.principal);
    return { namespaces: db.prepare("SELECT name, node, owner_wallet AS ownerWallet, verified_at AS verifiedAt FROM namespaces WHERE tenant_id = ?").all(tenantId) };
  });

  route("POST", "/v1/enterprise/subnames", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    return idempotent(c, tenantId, async () => created(await issueSubname(tenantId, c.body)));
  });

  route("POST", "/v1/enterprise/subnames/bulk", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    const items = c.body?.items;
    const max = config.plans[c.principal.plan].batch;
    if (!Array.isArray(items) || !items.length || items.length > max) throw new AddrError("invalid_request", `items must be 1..${max}`, 422);
    return idempotent(c, tenantId, async () => {
      const results: any[] = [];
      for (const it of items) {
        try { results.push({ ok: true, ...(await issueSubname(tenantId, it)) }); }
        catch (e) {
          if (e instanceof AddrError) results.push({ ok: false, label: it?.label, error: { code: e.code, message: e.message } });
          else throw e;
        }
      }
      return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    });
  });

  route("GET", "/v1/enterprise/names", (c) => {
    const tenantId = requireTenant(c.principal);
    reconcileGlobal(tenantId);
    const limit = Math.min(Number(c.query.get("limit") ?? 100), 500);
    return { names: listIssued(tenantId, limit, Number(c.query.get("offset") ?? 0)) };
  });

  route("PATCH", "/v1/enterprise/names/:name", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    return idempotent(c, tenantId, () => setRecordsForIssued(tenantId, c.params.name, c.body?.records ?? {}, c.body?.text));
  });

  route("POST", "/v1/enterprise/records", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    return idempotent(c, tenantId, () => setRecordsForIssued(tenantId, str(c.body?.name, "name"), c.body?.records ?? {}, c.body?.text));
  });

  route("DELETE", "/v1/enterprise/names/:name", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    return removeIssued(tenantId, c.params.name);
  });

  route("GET", "/v1/enterprise/customers/:id/names", (c) => {
    const tenantId = requireTenant(c.principal);
    reconcileGlobal(tenantId);
    return { customerId: c.params.id, names: customerNames(tenantId, c.params.id) };
  });

  // global (alice.addr) issuance for a customer: free voucher when eligible, otherwise a payable invoice
  route("POST", "/v1/enterprise/names", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    return idempotent(c, tenantId, async () => {
      const b = c.body ?? {};
      const label = normalizeLabel(str(b.label, "label"));
      const owner = getAddress(str(b.owner, "owner"));
      const customerId = str(b.customerId, "customerId", 128);
      const years = b.years ?? 1;
      const freeEligible = label.length >= 5 && !((await registrar.freeClaimed(owner)) as boolean) && !b.network;
      const id = "iss_" + crypto.randomBytes(8).toString("hex");
      const node = namehash(label + ".addr");
      let out: any;
      if (freeEligible) {
        out = { mode: "free_claim", voucher: await issueFreeVoucher(c.req, label, owner), note: "The customer wallet signs the commit/register transactions itself; the name is owned by them from the first block." };
      } else {
        out = { mode: "invoice", invoice: await createInvoice({ kind: "name", tenantId, label, years, owner, network: str(b.network, "network"), asset: str(b.asset, "asset"), standard: b.standard }) };
      }
      db.prepare("INSERT INTO issued (id, tenant_id, customer_id, name, node, kind, owner, tx, status, created) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, tenantId, customerId, label + ".addr", node, "global", owner, null, "ticket", now());
      audit(tenantId, "api", "global.ticket", label + ".addr", { mode: out.mode });
      return created({ id, name: label + ".addr", owner, customerId, ...out });
    });
  });

  route("POST", "/v1/enterprise/renewals", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    requirePlan(c.principal, "startup");
    return idempotent(c, tenantId, async () => {
      const name = normalizeName(str(c.body?.name, "name"));
      if (name.split(".").length !== 2) throw new AddrError("invalid_request", "only second-level names are renewed here", 422);
      const label = name.slice(0, -5);
      const years = c.body?.years ?? 1;
      const price = (await registrar.renewalPriceFor(label)) as bigint;
      if (price === 0n) {
        if (!operator) throw new AddrError("relayer_unavailable", "no relayer", 503);
        const reg = registrar.connect(operator) as typeof registrar;
        const rc = await enqueueTx(async () => (await reg.renew(label, years, "0x0000000000000000000000000000000000000000")).wait());
        audit(tenantId, "api", "renew.free", name, { tx: rc!.hash });
        return { mode: "free_renewal", name, tx: rc!.hash };
      }
      const info = await getNameInfo(name);
      return created({ mode: "invoice", invoice: await createInvoice({ kind: "renew", tenantId, label, years, owner: info.owner ?? deployment.treasury, network: str(c.body?.network, "network"), asset: str(c.body?.asset, "asset"), standard: c.body?.standard }) });
    });
  });

  route("POST", "/v1/enterprise/plan", async (c) => {
    const tenantId = requireTenant(c.principal, "write");
    return created(await createInvoice({ kind: "plan", tenantId, plan: str(c.body?.plan, "plan"), network: str(c.body?.network, "network"), asset: str(c.body?.asset, "asset"), standard: c.body?.standard }));
  });

  route("GET", "/v1/enterprise/dashboard", (c) => dashboard(requireTenant(c.principal)));
  route("GET", "/v1/enterprise/expiring", async (c) => ({ expiring: await expiringNamespaces(requireTenant(c.principal), Number(c.query.get("days") ?? 60)) }));
  route("GET", "/v1/enterprise/invoices", (c) => {
    const tenantId = requireTenant(c.principal);
    const ids = db.prepare("SELECT id FROM invoices WHERE tenant_id = ? ORDER BY created DESC LIMIT 100").all(tenantId) as { id: string }[];
    return { invoices: ids.map((r) => publicInvoice(r.id)) };
  });

  // ---------------------------------------------------------------------- admin
  route("GET", "/v1/admin/stats", async (c) => {
    requireAdmin(c.req, c.principal);
    const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).c as number;
    const t = now();
    return {
      names: { total: n("SELECT COUNT(*) AS c FROM names WHERE parent IS NULL"), active: n("SELECT COUNT(*) AS c FROM names WHERE parent IS NULL AND expires > ?", t), free: n("SELECT COUNT(*) AS c FROM names WHERE free = 1"), subnames: n("SELECT COUNT(*) AS c FROM names WHERE parent IS NOT NULL"), expiring30d: n("SELECT COUNT(*) AS c FROM names WHERE parent IS NULL AND expires BETWEEN ? AND ?", t, t + 30 * 86400) },
      registrations24h: n("SELECT COUNT(*) AS c FROM events WHERE type = 'name.registered' AND ts > ?", t - 86400),
      renewals24h: n("SELECT COUNT(*) AS c FROM events WHERE type = 'name.renewed' AND ts > ?", t - 86400),
      tenants: n("SELECT COUNT(*) AS c FROM tenants"), keys: n("SELECT COUNT(*) AS c FROM api_keys WHERE revoked = 0"),
      requestsToday: n("SELECT COALESCE(SUM(count),0) AS c FROM usage WHERE day = ?", new Date().toISOString().slice(0, 10)),
      invoices: db.prepare("SELECT status, COUNT(*) AS c FROM invoices GROUP BY status").all(),
      webhookFailures: n("SELECT COUNT(*) AS c FROM deliveries WHERE status = 'failed'"),
    };
  });
  route("GET", "/v1/admin/health", async (c) => {
    requireAdmin(c.req, c.principal);
    const samples = db.prepare("SELECT url, COUNT(*) AS n, SUM(ok) AS ok, AVG(ms) AS avgMs, MAX(ms) AS maxMs FROM rpc_health WHERE ts > ? GROUP BY url").all(now() - 3600);
    return { live: await probeRpcs(), lastHour: samples };
  });
  route("GET", "/v1/admin/timelock", (c) => {
    requireAdmin(c.req, c.principal);
    const rows = db.prepare("SELECT tx, block, ts, type, data FROM events WHERE contract = 'timelock' ORDER BY id DESC LIMIT 100").all() as any[];
    return { timelock: deployment.timelock, operations: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) };
  });
  route("GET", "/v1/admin/audit", (c) => {
    requireAdmin(c.req, c.principal);
    return { entries: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200").all() };
  });
  route("GET", "/v1/admin/invoices", (c) => {
    requireAdmin(c.req, c.principal);
    const st = c.query.get("status");
    const rows = (st ? db.prepare("SELECT id FROM invoices WHERE status = ? ORDER BY created DESC LIMIT 200").all(st) : db.prepare("SELECT id FROM invoices ORDER BY created DESC LIMIT 200").all()) as { id: string }[];
    return { invoices: rows.map((r) => publicInvoice(r.id)) };
  });
  route("POST", "/v1/admin/invoices/:id/retry", async (c) => {
    requireAdmin(c.req, c.principal);
    await finalize(c.params.id);
    return publicInvoice(c.params.id);
  });
  route("POST", "/v1/admin/tenants", (c) => {
    requireAdmin(c.req, c.principal);
    const plan = c.body?.plan ?? "free";
    if (!config.plans[plan]) throw new AddrError("invalid_plan", "unknown plan", 422);
    const id = createTenant(str(c.body?.name, "name"), plan);
    if (plan !== "free" && plan !== "enterprise") db.prepare("UPDATE tenants SET plan_expires = ? WHERE id = ?").run(now() + 30 * 86400, id);
    const key = createKey(id, "admin-issued");
    audit(id, "admin", "tenant.create", id, { plan });
    return created({ tenantId: id, plan, apiKey: key.key, keyId: key.id });
  });
  route("PATCH", "/v1/admin/tenants/:id", (c) => {
    requireAdmin(c.req, c.principal);
    const plan = str(c.body?.plan, "plan");
    if (!config.plans[plan]) throw new AddrError("invalid_plan", "unknown plan", 422);
    const days = Number(c.body?.days ?? 30);
    db.prepare("UPDATE tenants SET plan = ?, plan_expires = ? WHERE id = ?").run(plan, plan === "enterprise" ? 4102444800 : now() + days * 86400, c.params.id);
    audit(c.params.id, "admin", "tenant.plan", c.params.id, { plan, days });
    return { ok: true };
  });
  route("POST", "/v1/admin/tenants/:id/keys", (c) => {
    requireAdmin(c.req, c.principal);
    if (!db.prepare("SELECT 1 FROM tenants WHERE id = ?").get(c.params.id)) throw new AddrError("not_found", "tenant not found", 404);
    return created(createKey(c.params.id, c.body?.label ?? "admin-issued"));
  });
  route("POST", "/v1/admin/reindex", async (c) => {
    requireAdmin(c.req, c.principal);
    return indexOnce();
  });
  void freeSigner; void getNetwork; void registry;
}

/** Marks free/invoice-ticket global names active once the registration appears on-chain for the intended owner. */
function reconcileGlobal(tenantId: string) {
  db.prepare(
    `UPDATE issued SET status = 'active' WHERE tenant_id = ? AND kind = 'global' AND status = 'ticket'
     AND EXISTS (SELECT 1 FROM names n WHERE n.node = issued.node AND n.parent IS NULL AND lower(n.owner) = lower(issued.owner))`,
  ).run(tenantId);
}
