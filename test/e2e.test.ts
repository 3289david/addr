// End-to-end: real EVM node (hardhat node on :8545, deployed via scripts/deploy.cjs), real API server process,
// real HTTP calls, real signed transactions. No stubbed responses.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { registryAbi, resolverAbi, registrarAbi, erc20Abi, namehash, encodeAddress, getNetwork, bytesToHex } from "../packages/core/src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", "31337.json"), "utf8"));
const PORT = 8799;
const API = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token";
const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, { staticNetwork: true });
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0 (operator + free signer)

const registry = new Contract(dep.registry, registryAbi, provider);
const resolverC = new Contract(dep.resolver, resolverAbi, provider);
const registrarC = new Contract(dep.registrar, registrarAbi, provider);

let server: ChildProcess;
let dbFile: string;
const rnd = (n = 6) => "t" + crypto.randomBytes(n).toString("hex").slice(0, n).replace(/[0-9]/g, (d) => "abcdefghij"[+d]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const key = (k: string) => ({ authorization: `Bearer ${k}` });

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15000, label = "condition"): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(250);
  }
}

const walletCache = new Map<number, ethers.Signer>();
/** Fresh funded wallet per index per run (the chain persists between runs, free-name quota is per wallet). */
async function wallet(i: number): Promise<ethers.Signer> {
  let w = walletCache.get(i);
  if (!w) {
    const raw = Wallet.createRandom();
    await provider.send("hardhat_setBalance", [raw.address, "0x" + (100n * 10n ** 18n).toString(16)]);
    w = new ethers.NonceManager(new Wallet(raw.privateKey, provider));
    walletCache.set(i, w);
  }
  return w;
}

async function registerOnChain(signer: ethers.Signer, label: string, voucher?: { deadline: number; signature: string }, years = 1, value = 0n, token = ethers.ZeroAddress) {
  const owner = await signer.getAddress();
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const reg = registrarC.connect(signer) as Contract;
  const c = await reg.makeCommitment(label, owner, secret);
  await (await reg.commit(c)).wait();
  await sleep(2600); // min commitment age on the local deployment is 2s (real wall-clock time)
  const tx = await reg.register({ label, owner, years_: years, token, secret, deadline: voucher?.deadline ?? 0, voucher: voucher?.signature ?? "0x" }, { value });
  return tx.wait();
}

before(async () => {
  dbFile = path.join(root, "data", `e2e-${Date.now()}.db`);
  const env = {
    ...process.env,
    PORT: String(PORT), DB_PATH: dbFile, CHAIN_ID: "31337", RPC_URLS: "http://127.0.0.1:8545",
    FREE_SIGNER_KEY: DEV_KEY, OPERATOR_KEY: DEV_KEY, ADMIN_TOKEN: ADMIN, ALLOW_INSECURE_WEBHOOKS: "1",
    INDEX_INTERVAL_MS: "400", FREE_CLAIMS_PER_IP_PER_DAY: "50",
    TREASURY_ETHEREUM: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    EVM_RPC_ETHEREUM: "http://127.0.0.1:8545", PAYMENTS_SKIP_CHAINID_CHECK: "1",
    ASSET_ETHEREUM_USDT: dep.tokens.USDT, MINCONF_EVM: "1",
  };
  server = spawn(tsxBin, ["--no-warnings", path.join(root, "server", "index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr!.on("data", (d) => process.stderr.write("[server] " + d));
  await waitFor(async () => (await fetch(API + "/v1/contracts").then((r) => r.ok).catch(() => false)), 15000, "server start");
});

after(async () => {
  server?.kill();
  await sleep(300);
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) try { fs.unlinkSync(f); } catch { /* ignore */ }
});

test("health, contracts, networks, pricing come from the live chain", async () => {
  const h = await api("GET", "/v1/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.status, "ok");
  const c = await api("GET", "/v1/contracts");
  assert.equal(c.body.registry, dep.registry);
  const n = await api("GET", "/v1/networks");
  assert.ok(n.body.supported.find((x: any) => x.id === "tron"));
  assert.ok(n.body.unsupported.includes("dogecoin"));
  const p = await api("GET", "/v1/pricing");
  assert.equal(p.body.tiers["3"].usdPerYear, 50);
  assert.equal(p.body.tiers["1"].enabled, false);
});

let aliceLabel = rnd();
test("free claim -> on-chain commit/register -> resolution with every chain record", async () => {
  const alice = await wallet(3);
  const owner = await alice.getAddress();
  aliceLabel = rnd(8);

  const bad = await api("POST", "/v1/free-claims", { label: "abcd", owner });
  assert.equal(bad.status, 422); // < 5 chars is never free
  const v = await api("POST", "/v1/free-claims", { label: aliceLabel, owner });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  await registerOnChain(alice, aliceLabel, v.body);
  assert.equal(await registry["ownerOf(bytes32)"](namehash(aliceLabel + ".addr")), owner);

  // second free claim for the same wallet is refused by the API and by the contract
  const again = await api("POST", "/v1/free-claims", { label: rnd(8), owner });
  assert.equal(again.status, 409);

  const name = aliceLabel + ".addr";
  const node = namehash(name);
  const res = resolverC.connect(alice) as Contract;
  const eth = ethers.getAddress("0x" + "ab".repeat(20));
  const addrs: Record<string, string> = {
    bitcoin: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    litecoin: "", // set below from our own encoder
    solana: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    ethereum: eth,
  };
  const { decodeAddress } = await import("../packages/core/src/index.ts");
  addrs.litecoin = decodeAddress(getNetwork("litecoin")!, ethers.getBytes("0x0014" + "22".repeat(20)));
  for (const [netId, a] of Object.entries(addrs)) {
    const net = getNetwork(netId)!;
    await (await res["setAddr(bytes32,uint256,bytes)"](node, net.coinType, bytesToHex(encodeAddress(net, a)))).wait();
  }
  for (const [netId, a] of Object.entries(addrs)) {
    const r = await api("GET", `/v1/names/${name}/resolve?network=${netId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.address, a);
    assert.equal(r.body.verified, true);
    assert.equal(r.body.recentlyChanged, true);
  }
  // USDT requires an explicit network + standard, and standards must match the network
  assert.equal((await api("GET", `/v1/names/${name}/resolve?asset=USDT`)).body.error.code, "network_required");
  const usdtTron = await api("GET", `/v1/names/${name}/resolve?network=tron&asset=USDT&standard=TRC20`);
  assert.equal(usdtTron.body.address, addrs.tron);
  assert.equal(usdtTron.body.tokenContract, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal((await api("GET", `/v1/names/${name}/resolve?network=tron&asset=USDT&standard=ERC20`)).status, 422);
  assert.equal((await api("GET", `/v1/names/${name}/resolve?network=dogecoin`)).status, 501);
  // EVM chain without its own record falls back to the ETH record, flagged
  const base = await api("GET", `/v1/names/${name}/resolve?network=base&asset=USDC`);
  assert.equal(base.body.source, "fallback-ethereum");
  assert.ok(base.body.fallbackWarning);
  // not set
  assert.equal((await api("GET", `/v1/names/${name}/resolve?network=polygon`)).body.address, eth); // fallback too
  // all records
  const all = await api("GET", `/v1/names/${name}/records`);
  assert.equal(all.body.status, "active");
  assert.equal(all.body.records.length, 5);

  // reverse: primary name set by the wallet, verified on chain
  await (await res.setPrimaryName(name)).wait();
  const rev = await api("GET", `/v1/addresses/${owner}/reverse`);
  assert.equal(rev.body.primaryName, name);
  assert.equal(rev.body.verified, true);
  const strangers = await api("GET", `/v1/addresses/${await (await wallet(9)).getAddress()}/reverse`);
  assert.equal(strangers.body.primaryName, null);

  // indexer catches up: history + search + non-EVM reverse candidates
  const hist = await waitFor(async () => {
    const h = await api("GET", `/v1/names/${name}/history`);
    return h.body.events.filter((e: any) => e.type === "record.changed").length >= 5 ? h : false;
  }, 15000, "indexer history");
  assert.ok(hist.body.events.find((e: any) => e.type === "name.registered"));
  const s = await api("GET", `/v1/search?q=${aliceLabel.slice(0, 5)}`);
  assert.ok(s.body.matches.find((m: any) => m.name === name));
  const solRev = await waitFor(async () => {
    const r = await api("GET", `/v1/addresses/${addrs.solana}/reverse`);
    return r.body.recordMatches?.includes(name) ? r : false;
  }, 10000, "sol reverse index");
  assert.equal(solRev.body.verified, false);

  // batch
  const batch = await api("POST", "/v1/resolutions", { requests: [{ name, network: "bitcoin" }, { name: "nonexistentname.addr", network: "bitcoin" }, { name, network: "tron", asset: "USDT" }] });
  assert.equal(batch.body.results[0].ok, true);
  assert.equal(batch.body.results[1].error.code, "name_not_registered");
});

test("invalid input and address validation endpoints", async () => {
  assert.equal((await api("GET", "/v1/names/Bad_Name.addr")).status, 400);
  assert.equal((await api("GET", "/v1/names/foo.eth")).status, 400);
  const ok = await api("GET", "/v1/validate?network=bitcoin&address=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  assert.equal(ok.body.valid, true);
  assert.equal((await api("GET", "/v1/validate?network=bitcoin&address=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).body.valid, false);
  assert.equal((await api("GET", "/v1/nope")).status, 404);
});

test("expired names stop resolving (time travel on the local chain)", async () => {
  const s = await wallet(4);
  const label = rnd(8);
  const v = (await api("POST", "/v1/free-claims", { label, owner: await s.getAddress() })).body;
  await registerOnChain(s, label, v);
  await (await (resolverC.connect(s) as Contract)["setAddr(bytes32,address)"](namehash(label + ".addr"), await s.getAddress())).wait();
  assert.equal((await api("GET", `/v1/names/${label}.addr/resolve?network=ethereum`)).status, 200);
  await provider.send("evm_increaseTime", [366 * 86400]);
  await provider.send("evm_mine", []);
  const r = await api("GET", `/v1/names/${label}.addr/resolve?network=ethereum`);
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, "name_expired");
  assert.equal((await api("GET", `/v1/names/${label}.addr`)).body.status, "grace");
  // keep the oracle fresh for later tests
  const feed = new Contract(dep.ethUsdFeed, ["function set(int256)"], new Wallet(DEV_KEY, provider));
  await (await feed.set(2000n * 10n ** 8n)).wait();
});

test("API keys, usage metering, and daily quota", async () => {
  const k = await api("POST", "/v1/admin/tenants", { name: "e2e", plan: "free" }, key(ADMIN));
  assert.equal(k.status, 201);
  assert.ok(k.body.apiKey.startsWith("addr_live_"));
  const r = await api("GET", "/v1/usage", undefined, key(k.body.apiKey));
  assert.equal(r.body.plan, "free");
  assert.ok(r.headers.get("x-ratelimit-limit"));
  assert.equal((await api("GET", "/v1/usage", undefined, key("addr_live_wrong"))).status, 401);
  // enterprise endpoints require a paid plan
  const sub = await api("POST", "/v1/enterprise/subnames", {}, key(k.body.apiKey));
  assert.equal(sub.status, 402);
});

test("enterprise: namespace claim, relayer-issued subnames with atomic records, tenant isolation, idempotency, webhooks", async () => {
  // a real HTTP receiver for webhook deliveries
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const recv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((r) => recv.listen(0, "127.0.0.1", r));
  const recvPort = (recv.address() as any).port;

  const ent = await wallet(5);              // enterprise owner wallet
  const customer = await wallet(6);
  const created1 = await api("POST", "/v1/admin/tenants", { name: "Example Wallet", plan: "business" }, key(ADMIN));
  assert.equal(created1.status, 201, JSON.stringify(created1.body));
  const T1 = created1.body;
  const other = (await api("POST", "/v1/admin/tenants", { name: "Rival", plan: "business" }, key(ADMIN))).body;

  // enterprise registers its parent name (free tier, real tx)
  const parentLabel = rnd(8);
  const v = (await api("POST", "/v1/free-claims", { label: parentLabel, owner: await ent.getAddress() })).body;
  await registerOnChain(ent, parentLabel, v);
  const ns = parentLabel + ".addr";

  // claim requires a signature from the on-chain owner
  const msg = (await api("GET", `/v1/enterprise/claim-message?name=${ns}`, undefined, key(T1.apiKey))).body.message;
  const wrongSig = await (await wallet(7)).signMessage(msg);
  assert.equal((await api("POST", "/v1/enterprise/namespaces", { name: ns, signature: wrongSig }, key(T1.apiKey))).status, 403);
  const sig = await ent.signMessage(msg);
  const claimed = await api("POST", "/v1/enterprise/namespaces", { name: ns, signature: sig }, key(T1.apiKey));
  assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
  assert.equal(claimed.body.relayerApproved, false);

  // issuing before the owner approves the relayer must fail
  const body = { namespace: ns, label: "cust1", customerId: "c-1", owner: await customer.getAddress(), records: { bitcoin: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", ethereum: await customer.getAddress() } };
  assert.equal((await api("POST", "/v1/enterprise/subnames", body, key(T1.apiKey))).body.error.code, "relayer_not_approved");

  // owner approves the relayer for this one name (real tx)
  await ((registry.connect(ent) as Contract).approveName(namehash(ns), claimed.body.relayer, true).then((t: any) => t.wait()));

  // webhook scoped to the namespace
  const wh = await api("POST", "/v1/webhooks", { url: `http://127.0.0.1:${recvPort}/hook`, events: ["subname.created", "record.changed"], namespace: ns }, key(T1.apiKey));
  assert.equal(wh.status, 201, JSON.stringify(wh.body));
  // a tenant that has not claimed the namespace cannot scope to it
  assert.equal((await api("POST", "/v1/webhooks", { url: `http://127.0.0.1:${recvPort}/x`, namespace: ns }, key(other.apiKey))).status, 404);

  const idem = { ...key(T1.apiKey), "idempotency-key": "issue-cust1" };
  const issued = await api("POST", "/v1/enterprise/subnames", body, idem);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const replay = await api("POST", "/v1/enterprise/subnames", body, idem);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.tx, issued.body.tx); // replayed, not re-executed
  assert.equal((await api("POST", "/v1/enterprise/subnames", { ...body, label: "other" }, idem)).status, 422); // key reuse with different body

  const full = `cust1.${ns}`;
  assert.equal(await registry["ownerOf(bytes32)"](namehash(full)), await customer.getAddress()); // customer owns it, not the platform
  const r = await api("GET", `/v1/names/${full}/resolve?network=bitcoin`);
  assert.equal(r.body.address, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");

  // duplicate
  assert.equal((await api("POST", "/v1/enterprise/subnames", body, key(T1.apiKey))).body.error.code, "name_unavailable");
  // another tenant cannot issue under this namespace nor see these customers
  assert.equal((await api("POST", "/v1/enterprise/subnames", { ...body, label: "evil" }, key(other.apiKey))).body.error.code, "namespace_not_found");
  assert.equal((await api("GET", "/v1/enterprise/customers/c-1/names", undefined, key(other.apiKey))).body.names.length, 0);
  assert.equal((await api("GET", "/v1/enterprise/customers/c-1/names", undefined, key(T1.apiKey))).body.names.length, 1);

  // the platform cannot edit records until the customer consents on-chain
  const patch = { records: { solana: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } };
  assert.equal((await api("PATCH", `/v1/enterprise/names/${full}`, patch, key(T1.apiKey))).body.error.code, "customer_consent_required");
  await ((registry.connect(customer) as Contract).approveName(namehash(full), claimed.body.relayer, true).then((t: any) => t.wait()));
  const patched = await api("PATCH", `/v1/enterprise/names/${full}`, patch, key(T1.apiKey));
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal((await api("GET", `/v1/names/${full}/resolve?network=solana`)).body.address, patch.records.solana);

  // invalid record data is rejected before any transaction
  const badRec = await api("PATCH", `/v1/enterprise/names/${full}`, { records: { bitcoin: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb" } }, key(T1.apiKey));
  assert.equal(badRec.status, 422);

  // bulk
  const bulk = await api("POST", "/v1/enterprise/subnames/bulk", { items: [1, 2, 3].map((i) => ({ namespace: ns, label: `bulk${String.fromCharCode(96 + i)}`, customerId: `b-${i}`, owner: ethers.Wallet.createRandom().address })) }, key(T1.apiKey));
  assert.equal(bulk.body.succeeded, 3, JSON.stringify(bulk.body));

  // sovereign subname cannot be removed by issuer
  await ((registry.connect(customer) as Contract).burnParentControl(namehash(full)).then((t: any) => t.wait()));
  assert.equal((await api("DELETE", `/v1/enterprise/names/${full}`, undefined, key(T1.apiKey))).body.error.code, "customer_sovereign");
  const removable = await api("DELETE", `/v1/enterprise/names/bulka.${ns}`, undefined, key(T1.apiKey));
  assert.equal(removable.status, 200, JSON.stringify(removable.body));
  assert.equal((await api("GET", `/v1/names/bulka.${ns}`)).body.status, "available");

  // webhook deliveries arrive signed and verifiable
  await waitFor(async () => received.length >= 4, 20000, "webhook deliveries");
  const d = received.find((x) => JSON.parse(x.body).type === "subname.created")!;
  const sigHdr = String(d.headers["x-addr-signature"]);
  const t = /t=(\d+)/.exec(sigHdr)![1], v1 = /v1=([0-9a-f]+)/.exec(sigHdr)![1];
  const expect = crypto.createHmac("sha256", wh.body.secret).update(`${t}.${d.body}`).digest("hex");
  assert.equal(v1, expect);
  assert.equal(JSON.parse(d.body).data.parent, ns);
  // delivery log visible to the tenant only
  const dl = await api("GET", `/v1/webhooks/${wh.body.id}/deliveries`, undefined, key(T1.apiKey));
  assert.ok(dl.body.deliveries.some((x: any) => x.status === "delivered"));
  assert.equal((await api("GET", `/v1/webhooks/${wh.body.id}/deliveries`, undefined, key(other.apiKey))).status, 404);

  const dash = await api("GET", "/v1/enterprise/dashboard", undefined, key(T1.apiKey));
  assert.equal(dash.body.issuedActive >= 3, true);
  assert.equal(dash.body.plan, "business");

  // global issuance ticket: voucher for an eligible customer wallet
  const g = await api("POST", "/v1/enterprise/names", { label: rnd(8), owner: ethers.Wallet.createRandom().address, customerId: "g-1" }, key(T1.apiKey));
  assert.equal(g.body.mode, "free_claim");
  assert.ok(g.body.voucher.signature);
  await new Promise((r) => recv.close(r));
});

test("webhook URLs: SSRF protection is on unless explicitly relaxed (checked via the pure function)", async () => {
  process.env.ALLOW_INSECURE_WEBHOOKS = "0";
  const { assertSafeWebhookUrl } = await import("../server/webhooks.ts");
  // module reads config at import: ALLOW_INSECURE_WEBHOOKS is unset in the test process
  await assert.rejects(() => assertSafeWebhookUrl("http://example.com/x"), /https/);
  await assert.rejects(() => assertSafeWebhookUrl("https://127.0.0.1/x"), /private/);
  await assert.rejects(() => assertSafeWebhookUrl("https://169.254.169.254/latest"), /private/);
  await assert.rejects(() => assertSafeWebhookUrl("https://user:pw@example.com/"), /credentials/);
});

test("admin endpoints require the admin token", async () => {
  assert.equal((await api("GET", "/v1/admin/stats")).status, 403);
  assert.equal((await api("GET", "/v1/admin/stats", undefined, key("nope"))).status, 403);
  const s = await api("GET", "/v1/admin/stats", undefined, key(ADMIN));
  assert.equal(s.status, 200);
  assert.ok(s.body.names.total >= 3);
  const tl = await api("GET", "/v1/admin/timelock", undefined, key(ADMIN));
  assert.equal(tl.status, 200);
});

test("crypto payments: ETH and ERC20 invoices are verified on-chain and complete with a real registration", async (t) => {
  const prices = await api("GET", "/v1/prices");
  if (prices.status !== 200) { t.skip("live price API unreachable: " + JSON.stringify(prices.body)); return; }
  const payer = await wallet(8);
  const payerAddr = await payer.getAddress();
  const treasury = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const methods = await api("GET", "/v1/payments/methods");
  assert.ok(methods.body.methods.find((m: any) => m.network === "ethereum" && m.asset === "USDT"));

  // --- native ETH
  const label = "z" + rnd(2); // 4 chars => $15 per year
  const inv = await api("POST", "/v1/invoices", { label, owner: payerAddr, years: 1, network: "ethereum", asset: "ETH" });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.status, "pending");
  assert.equal(inv.body.usdMicro, 15_000_000);
  // underpaying is refused and not credited
  const short = await (await payer.sendTransaction({ to: treasury, value: BigInt(inv.body.amountBaseUnits) - 1n })).wait();
  const u = await api("POST", `/v1/invoices/${inv.body.id}/payment`, { txid: short!.hash });
  assert.equal(u.status, 422);
  assert.equal(u.body.error.code, "underpaid");
  // a payment to the wrong address does not count
  const wrong = await (await payer.sendTransaction({ to: await (await wallet(2)).getAddress(), value: BigInt(inv.body.amountBaseUnits) })).wait();
  assert.equal((await api("POST", `/v1/invoices/${inv.body.id}/payment`, { txid: wrong!.hash })).body.error.code, "wrong_recipient");
  // the exact payment
  const paidTx = await (await payer.sendTransaction({ to: treasury, value: BigInt(inv.body.amountBaseUnits) })).wait();
  await provider.send("evm_mine", []);
  const ok = await api("POST", `/v1/invoices/${inv.body.id}/payment`, { txid: paidTx!.hash });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const done = await waitFor(async () => {
    const g = await api("GET", `/v1/invoices/${inv.body.id}`);
    return g.body.status === "completed" ? g : false;
  }, 15000, "invoice completion");
  assert.ok(done.body.regTx);
  assert.equal(await registry["ownerOf(bytes32)"](namehash(label + ".addr")), payerAddr);
  // the same txid can't pay a second invoice
  const inv2 = await api("POST", "/v1/invoices", { label: "y" + rnd(3), owner: payerAddr, years: 1, network: "ethereum", asset: "ETH" });
  assert.equal((await api("POST", `/v1/invoices/${inv2.body.id}/payment`, { txid: paidTx!.hash })).body.error.code, "txid_used");

  // --- ERC20 (USDT contract deployed on the local chain, mapped via ASSET_ETHEREUM_USDT)
  const label2 = "w" + rnd(3);
  const inv3 = await api("POST", "/v1/invoices", { label: label2, owner: payerAddr, years: 2, network: "ethereum", asset: "USDT", standard: "ERC20" });
  assert.equal(inv3.status, 201, JSON.stringify(inv3.body));
  assert.equal(inv3.body.contract, dep.tokens.USDT);
  const usdt = new Contract(dep.tokens.USDT, ["function mint(address,uint256)", ...erc20Abi], new Wallet(DEV_KEY, provider));
  await (await usdt.mint(payerAddr, 1_000_000_000n)).wait();
  const tr = await (await (usdt.connect(payer) as Contract).transfer(treasury, BigInt(inv3.body.amountBaseUnits))).wait();
  await provider.send("evm_mine", []);
  const ok3 = await api("POST", `/v1/invoices/${inv3.body.id}/payment`, { txid: tr!.hash });
  assert.equal(ok3.status, 200, JSON.stringify(ok3.body));
  const st3 = await waitFor(async () => {
    const g = await api("GET", `/v1/invoices/${inv3.body.id}`);
    return ["completed", "registration_failed", "needs_review"].includes(g.body.status) ? g : false;
  }, 15000, "erc20 settlement");
  assert.equal(st3.body.status, "completed", JSON.stringify(st3.body));
  const info = await api("GET", `/v1/names/${label2}.addr`);
  assert.equal(info.body.status, "active");
  assert.equal(info.body.owner, payerAddr);
  assert.ok(info.body.expiresAt - Math.floor(Date.now() / 1000) > 365 * 86400); // 2 years bought
});

test("on-chain ETH registration and renewal using the oracle price", async () => {
  const w = await wallet(1);
  const label = "q" + rnd(1); // 3 chars: $50
  const need: bigint = await registrarC.ethForUsd(50_000_000n);
  await registerOnChain(w, label, undefined, 1, need + 10n ** 15n);
  assert.equal(await registry["ownerOf(bytes32)"](namehash(label + ".addr")), await w.getAddress());
  const info = await api("GET", `/v1/names/${label}.addr`);
  assert.equal(info.body.status, "active");
  const r = await api("GET", `/v1/search?q=${label}`);
  assert.equal(r.body.exact.available, false);
});
