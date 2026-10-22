// @addr/sdk: REST client + trustless on-chain resolver + webhook verification.
import { Contract, JsonRpcProvider, getBytes, type Provider } from "ethers";
import {
  AddrError, decodeAddress, explorerAddressUrl, getAsset, getNetwork, isMultiNetworkAsset, namehash, normalizeName,
  registryAbi, resolverAbi, validateAddress, type Network,
} from "../../core/src/index.ts";

export * from "../../core/src/index.ts";

export interface ResolveOptions {
  network?: string;
  asset?: string;
  standard?: string;
}

export interface ResolveResult {
  name: string;
  node: string;
  network: string;
  networkName: string;
  coinType: number;
  asset: string;
  standard: string;
  tokenContract?: string;
  address: string;
  verified: true;
  addressFormat: string;
  source: "record" | "fallback-ethereum";
  fallbackWarning?: string;
  updatedAt: number | null;
  updatedBlock: number | null;
  version: number;
  recentlyChanged: boolean;
  explorer: string;
}

export class AddrApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AddrApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Addr {
  readonly baseUrl: string;
  private apiKey?: string;
  private f: typeof fetch;
  private timeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const h: Record<string, string> = { accept: "application/json", ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    const res = await this.f(this.baseUrl + path, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      throw new AddrApiError(json?.error?.code ?? "http_error", json?.error?.message ?? `HTTP ${res.status}`, res.status);
    }
    return json as T;
  }

  private qs(o: Record<string, string | undefined>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  // ---- public reads
  resolve(name: string, opts: ResolveOptions = {}): Promise<ResolveResult> {
    return this.req("GET", `/v1/names/${encodeURIComponent(name)}/resolve${this.qs({ network: opts.network, asset: opts.asset, standard: opts.standard })}`);
  }
  name(name: string) { return this.req<any>("GET", `/v1/names/${encodeURIComponent(name)}`); }
  records(name: string) { return this.req<any>("GET", `/v1/names/${encodeURIComponent(name)}/records`); }
  history(name: string) { return this.req<any>("GET", `/v1/names/${encodeURIComponent(name)}/history`); }
  reverse(address: string) { return this.req<any>("GET", `/v1/addresses/${encodeURIComponent(address)}/reverse`); }
  search(q: string, owner?: string) { return this.req<any>("GET", `/v1/search${this.qs({ q, owner })}`); }
  validate(network: string, address: string) { return this.req<any>("GET", `/v1/validate${this.qs({ network, address })}`); }
  networks() { return this.req<any>("GET", "/v1/networks"); }
  pricing() { return this.req<any>("GET", "/v1/pricing"); }
  contracts() { return this.req<any>("GET", "/v1/contracts"); }
  health() { return this.req<any>("GET", "/v1/health"); }
  usage() { return this.req<any>("GET", "/v1/usage"); }
  resolveBatch(requests: ({ name: string } & ResolveOptions)[]) {
    return this.req<{ results: any[] }>("POST", "/v1/resolutions", { requests });
  }

  // ---- registration helpers
  freeClaim(label: string, owner: string) { return this.req<any>("POST", "/v1/free-claims", { label, owner }); }
  createInvoice(p: { label: string; owner: string; years?: number; network: string; asset: string; standard?: string; kind?: "name" | "renew" }) {
    return this.req<any>("POST", "/v1/invoices", p);
  }
  invoice(id: string) { return this.req<any>("GET", `/v1/invoices/${id}`); }
  submitPayment(id: string, txid: string) { return this.req<any>("POST", `/v1/invoices/${id}/payment`, { txid }); }

  // ---- enterprise
  readonly enterprise = {
    claimMessage: (name: string) => this.req<any>("GET", `/v1/enterprise/claim-message${this.qs({ name })}`),
    claimNamespace: (name: string, signature: string) => this.req<any>("POST", "/v1/enterprise/namespaces", { name, signature }),
    namespace: (name: string) => this.req<any>("GET", `/v1/enterprise/namespaces/${encodeURIComponent(name)}`),
    issueSubname: (input: { namespace: string; label: string; customerId: string; owner: string; records?: Record<string, string>; text?: Record<string, string> }, idempotencyKey?: string) =>
      this.req<any>("POST", "/v1/enterprise/subnames", input, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    issueBulk: (items: unknown[], idempotencyKey?: string) =>
      this.req<any>("POST", "/v1/enterprise/subnames/bulk", { items }, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    issueGlobal: (input: { label: string; owner: string; customerId: string; years?: number; network?: string; asset?: string; standard?: string }, idempotencyKey?: string) =>
      this.req<any>("POST", "/v1/enterprise/names", input, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    names: (limit = 100, offset = 0) => this.req<any>("GET", `/v1/enterprise/names?limit=${limit}&offset=${offset}`),
    customerNames: (customerId: string) => this.req<any>("GET", `/v1/enterprise/customers/${encodeURIComponent(customerId)}/names`),
    setRecords: (name: string, records: Record<string, string>, text?: Record<string, string>) =>
      this.req<any>("PATCH", `/v1/enterprise/names/${encodeURIComponent(name)}`, { records, text }),
    removeSubname: (name: string) => this.req<any>("DELETE", `/v1/enterprise/names/${encodeURIComponent(name)}`),
    renew: (name: string, years = 1, pay?: { network: string; asset: string; standard?: string }) =>
      this.req<any>("POST", "/v1/enterprise/renewals", { name, years, ...pay }),
    expiring: (days = 60) => this.req<any>("GET", `/v1/enterprise/expiring?days=${days}`),
    dashboard: () => this.req<any>("GET", "/v1/enterprise/dashboard"),
    buyPlan: (plan: string, pay: { network: string; asset: string; standard?: string }) =>
      this.req<any>("POST", "/v1/enterprise/plan", { plan, ...pay }),
    invoices: () => this.req<any>("GET", "/v1/enterprise/invoices"),
  };

  readonly webhooks = {
    create: (url: string, events: string[] = ["*"], namespace?: string) => this.req<any>("POST", "/v1/webhooks", { url, events, namespace }),
    list: () => this.req<any>("GET", "/v1/webhooks"),
    delete: (id: string) => this.req<any>("DELETE", `/v1/webhooks/${id}`),
    deliveries: (id: string) => this.req<any>("GET", `/v1/webhooks/${id}/deliveries`),
    retry: (id: string, deliveryId: string) => this.req<any>("POST", `/v1/webhooks/${id}/deliveries/${deliveryId}/retry`, {}),
  };
}

// ------------------------------------------------------------------ webhooks
/** Verifies the X-Addr-Signature header. Pass the raw request body string. Returns the parsed event. */
export async function verifyWebhook(rawBody: string, signatureHeader: string, secret: string, toleranceSec = 300) {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(signatureHeader || "");
  if (!m) throw new Error("malformed signature header");
  const ts = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) throw new Error("signature timestamp outside tolerance");
  const expect = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
  const given = Buffer.from(m[2], "hex");
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) throw new Error("signature mismatch");
  return JSON.parse(rawBody);
}

// -------------------------------------------------------------- on-chain mode
export interface ChainConfig {
  registry: string;
  resolver: string;
}

/**
 * Resolves names straight from the chain with no ADDR server involved. This is the trust-minimized path
 * wallets should use: the only trusted data is the RPC's view of the registry and resolver contracts.
 */
export class AddrChainResolver {
  private registry: Contract;
  private resolver: Contract;

  constructor(provider: Provider | string, cfg: ChainConfig) {
    const p = typeof provider === "string" ? new JsonRpcProvider(provider) : provider;
    this.registry = new Contract(cfg.registry, registryAbi, p);
    this.resolver = new Contract(cfg.resolver, resolverAbi, p);
  }

  async status(name: string) {
    const n = normalizeName(name);
    const node = namehash(n);
    const s = Number(await this.registry.statusOf(node));
    return { name: n, node, status: (["available", "active", "grace", "expired"] as const)[s], owner: s === 1 ? ((await this.registry["ownerOf(bytes32)"](node)) as string) : null };
  }

  async resolve(name: string, opts: ResolveOptions): Promise<Pick<ResolveResult, "name" | "node" | "network" | "asset" | "standard" | "address" | "source" | "fallbackWarning" | "version" | "updatedAt" | "explorer">> {
    const n = normalizeName(name);
    if (!opts.network) {
      if (opts.asset && isMultiNetworkAsset(opts.asset)) throw new AddrError("network_required", `${opts.asset} exists on several networks; pass network`, 422);
      throw new AddrError("network_required", "network is required", 422);
    }
    const net = getNetwork(opts.network.toLowerCase()) as Network | undefined;
    if (!net) throw new AddrError("network_unknown", `unknown or unsupported network "${opts.network}"`, 404);
    const asset = opts.asset ? getAsset(net, opts.asset, opts.standard) : net.assets[0];
    if (!asset) throw new AddrError("unsupported_asset", `${opts.asset} is not supported on ${net.name}`, 422);
    const st = await this.status(n);
    if (st.status !== "active") throw new AddrError(st.status === "available" ? "name_not_registered" : "name_expired", `${n} is ${st.status}`, 404);
    const read = async (coin: number) => {
      const [raw, meta] = await Promise.all([this.resolver["addr(bytes32,uint256)"](st.node, coin) as Promise<string>, this.resolver.addrMeta(st.node, coin) as Promise<bigint[]>]);
      return { raw, ts: Number(meta[0]), version: Number(meta[2]) };
    };
    let rec = await read(net.coinType);
    let source: "record" | "fallback-ethereum" = "record";
    let warn: string | undefined;
    if (rec.raw === "0x" && net.family === "evm" && net.coinType !== 60) {
      const eth = await read(60);
      if (eth.raw !== "0x") { rec = eth; source = "fallback-ethereum"; warn = `No ${net.name}-specific address set; using the Ethereum address. Confirm with the recipient.`; }
    }
    if (rec.raw === "0x") throw new AddrError("record_not_set", `${n} has no ${net.name} record`, 404);
    const address = decodeAddress(net, getBytes(rec.raw));
    if (!validateAddress(net.id, address).valid) throw new AddrError("record_invalid", "record failed validation", 502);
    return { name: n, node: st.node, network: net.id, asset: asset.symbol, standard: asset.standard, address, source, fallbackWarning: warn, version: rec.version, updatedAt: rec.ts || null, explorer: explorerAddressUrl(net, address) };
  }

  async reverse(address: string): Promise<{ name: string | null }> {
    const [name] = (await this.resolver.reverse(address)) as [string, string];
    return { name: name || null };
  }
}
