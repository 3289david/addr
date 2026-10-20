import crypto from "node:crypto";
import { JsonRpcProvider, id as keccakId, toUtf8Bytes, keccak256, zeroPadValue, getAddress } from "ethers";
import {
  AddrError, NETWORKS, base58CheckDecode, bytesToHex, encodeAddress, formatUnits, getAsset, getNetwork,
  normalizeLabel, paymentUri, usd, validateAddress, explorerTxUrl, type Asset, type Network,
} from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { audit, db, now } from "./db.ts";
import { enqueueTx, operator, registrar } from "./chain.ts";
import { emit } from "./webhooks.ts";

// ------------------------------------------------------------------ prices

const CG_ID: Record<string, string> = {
  BTC: "bitcoin", LTC: "litecoin", ETH: "ethereum", SOL: "solana", TRX: "tron",
  POL: "polygon-ecosystem-token", BNB: "binancecoin", USDT: "tether", USDC: "usd-coin",
};
let priceCache: { at: number; data: Record<string, number> } | null = null;

export async function usdPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.data;
  const ids = Object.values(CG_ID).join(",");
  const res = await fetch(`${config.priceApi}?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new AddrError("price_unavailable", `price source returned ${res.status}`, 503);
  const j = (await res.json()) as Record<string, { usd: number }>;
  const data: Record<string, number> = {};
  for (const [sym, id] of Object.entries(CG_ID)) if (j[id]?.usd > 0) data[sym] = j[id].usd;
  priceCache = { at: Date.now(), data };
  return data;
}

// -------------------------------------------------------------- methods

/** Allows pointing a token at a different contract (e.g. a local chain). Default is the real contract in the registry. */
export function assetContract(net: Network, a: Asset): string | undefined {
  return process.env[`ASSET_${net.id.toUpperCase()}_${a.symbol}`] || a.contract;
}

export function paymentMethods() {
  const out: { network: string; networkName: string; asset: string; standard: string; contract?: string; decimals: number; payTo: string; minConfirmations: number }[] = [];
  for (const net of NETWORKS) {
    const payTo = config.treasuries[net.id];
    if (!payTo) continue;
    if (!validateAddress(net.id, payTo).valid) continue;
    for (const a of net.assets) {
      out.push({
        network: net.id, networkName: net.name, asset: a.symbol, standard: a.standard, contract: assetContract(net, a),
        decimals: a.decimals, payTo, minConfirmations: minConf(net),
      });
    }
  }
  return out;
}

function minConf(net: Network): number {
  return net.id === "bitcoin" ? config.minConf.bitcoin : net.id === "litecoin" ? config.minConf.litecoin
    : net.id === "tron" ? config.minConf.tron : net.id === "solana" ? 1 : config.minConf.evm;
}

// ---------------------------------------------------------------- pricing

export async function onchainYearlyUsdMicro(label: string, renewal: boolean): Promise<bigint> {
  if (renewal) return (await registrar.renewalPriceFor(label)) as bigint;
  const lh = keccak256(toUtf8Bytes(label));
  const prem = (await registrar.premiumUsd(lh)) as bigint;
  if (prem > 0n) return prem;
  const len = label.length;
  const tier = (await registrar.tiers(len >= 5 ? 5 : len)) as [bigint, boolean];
  if (!tier[1] || (len < 5 && tier[0] === 0n)) throw new AddrError("length_not_open", "names of this length are not open for registration", 422);
  return tier[0];
}

// ---------------------------------------------------------------- invoices

export interface CreateInvoice {
  kind: "name" | "renew" | "plan";
  tenantId?: string | null;
  label?: string;
  years?: number;
  owner?: string;
  plan?: string;
  network: string;
  asset: string;
  standard?: string;
}

const newId = () => crypto.randomBytes(16).toString("hex");

export async function createInvoice(p: CreateInvoice) {
  const net = getNetwork(p.network.toLowerCase());
  if (!net) throw new AddrError("network_unknown", `unknown network ${p.network}`, 404);
  const payTo = config.treasuries[net.id];
  if (!payTo) throw new AddrError("network_not_payable", `${net.name} payments are not enabled on this deployment`, 422);
  const asset = getAsset(net, p.asset, p.standard);
  if (!asset) throw new AddrError("unsupported_asset", `${p.asset} (${p.standard ?? "any"}) is not available on ${net.name}`, 422);

  let usdMicro: bigint;
  let years = p.years ?? 1;
  let label: string | undefined;
  if (p.kind === "plan") {
    const plan = config.plans[p.plan ?? ""];
    if (!plan || plan.priceKrw <= 0) throw new AddrError("invalid_plan", "plan is not purchasable (free or contact sales)", 422);
    usdMicro = BigInt(Math.ceil((plan.priceKrw / config.krwPerUsd) * 1e6));
    years = 1;
  } else {
    if (!Number.isInteger(years) || years < 1 || years > 5) throw new AddrError("invalid_years", "years must be 1..5", 422);
    label = normalizeLabel(p.label ?? "");
    if (!p.owner || !validateAddress("ethereum", p.owner).valid) throw new AddrError("invalid_owner", "owner must be an EVM wallet address (the name is held on the registry chain)", 422);
    if (p.kind === "name") {
      const avail = (await registrar.available(label)) as boolean;
      if (!avail) throw new AddrError("name_unavailable", `${label}.addr is not available`, 409);
      const clash = db.prepare("SELECT 1 FROM invoices WHERE kind='name' AND label=? AND status IN ('pending','confirming') AND expires > ?").get(label, now());
      if (clash) throw new AddrError("name_pending", `${label}.addr has a pending payment; try again after it expires`, 409);
    }
    const per = await onchainYearlyUsdMicro(label, p.kind === "renew");
    usdMicro = per * BigInt(years);
    if (usdMicro === 0n) throw new AddrError("no_payment_needed", "this name is free: claim or renew it directly on-chain", 422);
  }

  const prices = await usdPrices();
  const rate = prices[asset.symbol];
  if (!rate) throw new AddrError("price_unavailable", `no price for ${asset.symbol}`, 503);
  const unit = 10n ** BigInt(asset.decimals);
  // amount = usd / rate * 10^dec, rounded up; rate carried as micro-USD per whole unit
  const rateMicro = BigInt(Math.round(rate * 1e6));
  let amount = (usdMicro * unit + rateMicro - 1n) / rateMicro;
  // unique low-order tag so each open invoice has a distinct exact amount
  const tagSpace = BigInt(Math.max(10, Math.min(9999, Number(unit / 100_000n) || 99)));
  for (let i = 0; i < 25; i++) {
    const cand = amount + 1n + BigInt(crypto.randomInt(0, Number(tagSpace)));
    const dup = db.prepare("SELECT 1 FROM invoices WHERE network=? AND asset=? AND standard=? AND amount=? AND pay_to=? AND status IN ('pending','confirming') AND expires > ?")
      .get(net.id, asset.symbol, asset.standard, cand.toString(), payTo, now());
    if (!dup) { amount = cand; break; }
    if (i === 24) throw new AddrError("busy", "could not allocate a unique payment amount, retry", 503);
  }
  const id = newId();
  const t = now();
  db.prepare(`INSERT INTO invoices (id, tenant_id, kind, label, years, owner, plan, network, asset, standard, usd_micro, rate, amount, pay_to, status, created, expires, updated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, p.tenantId ?? null, p.kind, label ?? null, years, p.owner ?? null, p.plan ?? null, net.id, asset.symbol, asset.standard,
      Number(usdMicro), String(rate), amount.toString(), payTo, "pending", t, t + config.quoteTtlSec, t);
  audit(p.tenantId ?? null, "system", "invoice.create", id, { kind: p.kind, label, network: net.id, asset: asset.symbol });
  return publicInvoice(id);
}

export function publicInvoice(id: string) {
  const r = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as any;
  if (!r) throw new AddrError("invoice_not_found", "invoice not found", 404);
  const net = getNetwork(r.network)!;
  const asset = getAsset(net, r.asset, r.standard)!;
  const amountStr = formatUnits(BigInt(r.amount), asset.decimals);
  let status = r.status;
  if ((status === "pending") && r.expires < now()) status = "expired";
  return {
    id: r.id, kind: r.kind, status, label: r.label, name: r.label ? `${r.label}.addr` : null, years: r.years, owner: r.owner, plan: r.plan,
    network: r.network, asset: r.asset, standard: r.standard, contract: assetContract(net, asset) ?? null,
    priceUsd: usd(r.usd_micro), usdMicro: r.usd_micro, rateUsdPerUnit: r.rate,
    amount: amountStr, amountBaseUnits: r.amount, decimals: asset.decimals,
    payTo: r.pay_to, paymentUri: paymentUri(net, asset, r.pay_to, amountStr),
    note: "Send exactly this amount in a single transaction. The tiny extra digits identify your payment. Network fees are paid by you in addition.",
    minConfirmations: minConf(net),
    txid: r.txid, confirmations: r.confirmations, regTx: r.reg_tx, error: r.error,
    expiresAt: r.expires, createdAt: r.created, explorer: r.txid ? explorerTxUrl(net, r.txid) : null,
  };
}

// ---------------------------------------------------------------- verification

interface Observed { received: bigint; confirmations: number; found: boolean; failed?: boolean }

const evmProviders = new Map<string, JsonRpcProvider>();
function evmProvider(net: Network): JsonRpcProvider {
  let p = evmProviders.get(net.id);
  if (!p) {
    const url = config.evmRpc[net.id] || (net.id === "ethereum" && process.env.EVM_RPC_URL) || "";
    if (!url) throw new AddrError("verifier_unavailable", `no RPC configured for ${net.name} (set EVM_RPC_${net.id.toUpperCase()})`, 503);
    p = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
    evmProviders.set(net.id, p);
  }
  return p;
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new AddrError("verifier_unavailable", `upstream ${new URL(url).host} returned ${res.status}`, 503);
  return res.json();
}

export async function observeEsplora(api: string, txid: string, payTo: string): Promise<Observed> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new AddrError("invalid_txid", "txid must be 64 hex characters", 422);
  const t = await getJson(`${api}/tx/${txid}`);
  if (!t) return { received: 0n, confirmations: 0, found: false };
  let received = 0n;
  for (const o of t.vout ?? []) {
    if (o.scriptpubkey_address && o.scriptpubkey_address.toLowerCase() === payTo.toLowerCase()) received += BigInt(o.value);
  }
  let conf = 0;
  if (t.status?.confirmed) {
    const tip = Number(await (await fetch(`${api}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) })).text());
    conf = tip - t.status.block_height + 1;
  }
  return { received, confirmations: conf, found: true };
}

function tronHex20(addr: string): string {
  return bytesToHex(base58CheckDecode(addr).slice(1)).slice(2);
}

export async function observeTron(txid: string, payTo: string, asset: Asset, contract?: string): Promise<Observed> {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new AddrError("invalid_txid", "txid must be 64 hex characters", 422);
  const h: Record<string, string> = { "content-type": "application/json" };
  if (config.tronApiKey) h["TRON-PRO-API-KEY"] = config.tronApiKey;
  const post = (p: string, body: unknown) => getJson(`${config.tronApi}${p}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const info = await post("/wallet/gettransactioninfobyid", { value: txid });
  if (!info || !info.blockNumber) return { received: 0n, confirmations: 0, found: !!info?.id };
  const raw = await post("/wallet/gettransactionbyid", { value: txid, visible: true });
  const cr = raw?.ret?.[0]?.contractRet;
  if (cr && cr !== "SUCCESS") return { received: 0n, confirmations: 0, found: true, failed: true };
  let received = 0n;
  if (asset.standard === "native") {
    const c = raw?.raw_data?.contract?.[0];
    if (c?.type === "TransferContract" && c.parameter.value.to_address === payTo) received = BigInt(c.parameter.value.amount);
  } else {
    if (info.receipt?.result && info.receipt.result !== "SUCCESS") return { received: 0n, confirmations: 0, found: true, failed: true };
    const tokenHex = tronHex20(contract!);
    const toHex = tronHex20(payTo);
    const sig = keccakId("Transfer(address,address,uint256)").slice(2);
    for (const l of info.log ?? []) {
      if (l.address.toLowerCase() === tokenHex && l.topics?.[0] === sig && l.topics[2].slice(-40).toLowerCase() === toHex) {
        received += BigInt("0x" + l.data);
      }
    }
  }
  const nowBlock = await post("/wallet/getnowblock", {});
  const tip = Number(nowBlock?.block_header?.raw_data?.number ?? 0);
  return { received, confirmations: tip ? tip - Number(info.blockNumber) + 1 : 1, found: true };
}

export async function observeSolana(sig: string, payTo: string, asset: Asset, contract?: string): Promise<Observed> {
  const res = await fetch(config.solanaRpc, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }] }),
  });
  if (!res.ok) throw new AddrError("verifier_unavailable", `solana rpc returned ${res.status}`, 503);
  const j: any = await res.json();
  if (j.error) throw new AddrError("verifier_unavailable", `solana rpc: ${j.error.message}`, 503);
  const t = j.result;
  if (!t) return { received: 0n, confirmations: 0, found: false };
  if (t.meta?.err) return { received: 0n, confirmations: 1, found: true, failed: true };
  let received = 0n;
  if (asset.standard === "native") {
    const keys: any[] = t.transaction.message.accountKeys;
    const idx = keys.findIndex((k) => (k.pubkey ?? k) === payTo);
    if (idx >= 0) received = BigInt(t.meta.postBalances[idx]) - BigInt(t.meta.preBalances[idx]);
  } else {
    const sum = (arr: any[]) =>
      (arr ?? []).filter((b) => b.owner === payTo && b.mint === contract).reduce<bigint>((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    received = sum(t.meta.postTokenBalances) - sum(t.meta.preTokenBalances);
  }
  return { received: received < 0n ? 0n : received, confirmations: 1, found: true };
}

async function observeEvm(net: Network, txid: string, payTo: string, asset: Asset, contract?: string): Promise<Observed> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txid)) throw new AddrError("invalid_txid", "txid must be 0x + 64 hex characters", 422);
  const p = evmProvider(net);
  if (!process.env.PAYMENTS_SKIP_CHAINID_CHECK) {
    const cid = Number((await p.getNetwork()).chainId);
    if (cid !== net.chainId) throw new AddrError("verifier_unavailable", `RPC for ${net.name} reports chain ${cid}`, 503);
  }
  const rc = await p.getTransactionReceipt(txid);
  if (!rc) return { received: 0n, confirmations: 0, found: !!(await p.getTransaction(txid)) };
  if (rc.status !== 1) return { received: 0n, confirmations: 0, found: true, failed: true };
  const head = await p.getBlockNumber();
  const conf = head - rc.blockNumber + 1;
  let received = 0n;
  if (asset.standard === "native") {
    const t = await p.getTransaction(txid);
    if (t && t.to && getAddress(t.to) === getAddress(payTo)) received = t.value;
  } else {
    const sig = keccakId("Transfer(address,address,uint256)");
    const toTopic = zeroPadValue(payTo, 32).toLowerCase();
    for (const l of rc.logs) {
      if (getAddress(l.address) === getAddress(contract!) && l.topics[0] === sig && l.topics[2]?.toLowerCase() === toTopic) {
        received += BigInt(l.data);
      }
    }
  }
  return { received, confirmations: conf, found: true };
}

async function observe(inv: any): Promise<Observed> {
  const net = getNetwork(inv.network)!;
  const asset = getAsset(net, inv.asset, inv.standard)!;
  const contract = assetContract(net, asset);
  const txid = inv.txid as string;
  switch (net.family) {
    case "btc": return observeEsplora(config.btcApi, txid, inv.pay_to);
    case "ltc": return observeEsplora(config.ltcApi, txid, inv.pay_to);
    case "tron": return observeTron(txid, inv.pay_to, asset, contract);
    case "solana": return observeSolana(txid, inv.pay_to, asset, contract);
    case "evm": return observeEvm(net, txid, inv.pay_to, asset, contract);
  }
}

/** Attach a txid to an invoice (only if it pays this invoice exactly) and advance its state. */
export async function submitPayment(invoiceId: string, txid: string) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as any;
  if (!inv) throw new AddrError("invoice_not_found", "invoice not found", 404);
  if (["completed", "paid"].includes(inv.status)) return publicInvoice(invoiceId);
  if (inv.txid && inv.txid !== txid) throw new AddrError("txid_mismatch", "a different transaction is already attached to this invoice", 409);
  const used = db.prepare("SELECT id FROM invoices WHERE network = ? AND txid = ? AND id != ?").get(inv.network, txid, invoiceId);
  if (used) throw new AddrError("txid_used", "this transaction was already used for another invoice", 409);

  const probe = { ...inv, txid };
  const obs = await observe(probe);
  const expired = inv.expires < now() && !inv.txid;
  if (!obs.found) {
    throw new AddrError("tx_not_found", "transaction not found yet; wait for it to appear on the network and retry", 404);
  }
  if (obs.failed) {
    throw new AddrError("tx_failed", "transaction failed on-chain", 422);
  }
  const need = BigInt(inv.amount);
  if (obs.received !== need) {
    if (obs.received === 0n) throw new AddrError("wrong_recipient", "transaction does not pay this invoice's address/asset", 422);
    if (obs.received < need) {
      throw new AddrError("underpaid", `received ${obs.received} but ${need} (base units) was required. Underpayments are not credited; contact support with this invoice id for a refund`, 422);
    }
    // overpaid or unrelated exact-amount mismatch: do not attach, never let someone else claim it
    db.prepare("UPDATE invoices SET status='needs_review', error=?, updated=? WHERE id=? AND status='pending'")
      .run(`txid ${txid} paid ${obs.received}, expected ${need}`, now(), invoiceId);
    throw new AddrError("amount_mismatch", `received ${obs.received} but exactly ${need} (base units) is required. The transaction was not applied; contact support with this invoice id`, 422);
  }
  db.prepare("UPDATE invoices SET txid=?, received=?, confirmations=?, status=?, updated=? WHERE id=?")
    .run(txid, obs.received.toString(), obs.confirmations, expired ? "needs_review" : "confirming", now(), invoiceId);
  if (expired) {
    db.prepare("UPDATE invoices SET error=? WHERE id=?").run("payment arrived after the quote expired; manual review/refund", invoiceId);
    return publicInvoice(invoiceId);
  }
  await advance(invoiceId);
  return publicInvoice(invoiceId);
}

/** Re-check a confirming invoice; once confirmations suffice, finalize it. */
export async function advance(invoiceId: string) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as any;
  if (!inv || inv.status !== "confirming") return;
  const obs = await observe(inv);
  if (!obs.found || obs.failed || obs.received !== BigInt(inv.amount)) {
    db.prepare("UPDATE invoices SET status='needs_review', error=?, updated=? WHERE id=?")
      .run("transaction disappeared or changed (possible reorg)", now(), invoiceId);
    return;
  }
  db.prepare("UPDATE invoices SET confirmations=?, updated=? WHERE id=?").run(obs.confirmations, now(), invoiceId);
  const net = getNetwork(inv.network)!;
  if (obs.confirmations < minConf(net)) return;
  const upd = db.prepare("UPDATE invoices SET status='paid', updated=? WHERE id=? AND status='confirming'").run(now(), invoiceId);
  if (Number(upd.changes) === 0) return;
  emit({ id: `invoice:${invoiceId}:paid`, type: "invoice.paid", tenantId: inv.tenant_id, name: inv.label ? `${inv.label}.addr` : null, data: { invoice: invoiceId } });
  await finalize(invoiceId);
}

const refOf = (invoiceId: string) => keccakId(`invoice:${invoiceId}`);

export async function finalize(invoiceId: string) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId) as any;
  if (!inv || !["paid", "registration_failed"].includes(inv.status)) return;
  try {
    if (inv.kind === "plan") {
      const t = db.prepare("SELECT * FROM tenants WHERE id = ?").get(inv.tenant_id) as any;
      const base = t && t.plan === inv.plan && t.plan_expires > now() ? t.plan_expires : now();
      db.prepare("UPDATE tenants SET plan = ?, plan_expires = ? WHERE id = ?").run(inv.plan, base + 30 * 86400, inv.tenant_id);
      db.prepare("UPDATE invoices SET status='completed', updated=? WHERE id=?").run(now(), invoiceId);
    } else {
      if (!operator) throw new Error("no operator key configured on this server");
      const reg = registrar.connect(operator) as typeof registrar;
      const hash = await enqueueTx(async () => {
        const txr = inv.kind === "name"
          ? await reg.registerPaid(inv.label, inv.owner, inv.years, refOf(invoiceId))
          : await reg.renewPaid(inv.label, inv.years, refOf(invoiceId));
        const rc = await txr.wait();
        return rc!.hash as string;
      });
      db.prepare("UPDATE invoices SET status='completed', reg_tx=?, error=NULL, updated=? WHERE id=?").run(hash, now(), invoiceId);
    }
    emit({ id: `invoice:${invoiceId}:completed`, type: "invoice.completed", tenantId: inv.tenant_id, name: inv.label ? `${inv.label}.addr` : null, data: { invoice: invoiceId } });
  } catch (e) {
    const msg = ((e as any).shortMessage || (e as Error).message || "failed").slice(0, 300);
    db.prepare("UPDATE invoices SET status='registration_failed', error=?, updated=? WHERE id=?").run(msg, now(), invoiceId);
    emit({ id: `invoice:${invoiceId}:failed:${now()}`, type: "invoice.failed", tenantId: inv.tenant_id, name: inv.label ? `${inv.label}.addr` : null, data: { invoice: invoiceId, error: msg } });
  }
}

export async function paymentsTick() {
  const rows = db.prepare("SELECT id FROM invoices WHERE status = 'confirming' LIMIT 50").all() as { id: string }[];
  for (const r of rows) {
    try { await advance(r.id); } catch (e) { console.error("payments tick", r.id, (e as Error).message); }
  }
  const retry = db.prepare("SELECT id FROM invoices WHERE status = 'registration_failed' AND updated < ? LIMIT 10").all(now() - 120) as { id: string }[];
  for (const r of retry) {
    const inv = db.prepare("SELECT label, kind FROM invoices WHERE id = ?").get(r.id) as any;
    // never retry when the name was taken by someone else: that needs a refund, not a retry
    if (inv.kind === "name" && !((await registrar.available(inv.label)) as boolean)) continue;
    await finalize(r.id);
  }
}

export function startPaymentsWorker() {
  setInterval(() => paymentsTick().catch((e) => console.error("payments worker", e)), 10_000).unref();
}

export { encodeAddress };
