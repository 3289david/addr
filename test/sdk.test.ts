// SDK + CLI + trustless on-chain resolver against the real local chain and a real server process.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, ethers } from "ethers";
import { Addr, AddrChainResolver, AddrApiError, verifyWebhook, registrarAbi, resolverAbi, namehash, encodeAddress, getNetwork, bytesToHex } from "../packages/sdk/src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", "31337.json"), "utf8"));
const PORT = 8798;
const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, { staticNetwork: true });
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let server: ChildProcess;
let dbFile: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addr = new Addr({ baseUrl: `http://127.0.0.1:${PORT}` });
const label = "sdk" + crypto.randomBytes(4).toString("hex").replace(/[0-9]/g, "k");
let owner: Wallet;
let signer: ethers.Signer;

before(async () => {
  dbFile = path.join(root, "data", `sdk-${Date.now()}.db`);
  server = spawn(process.execPath, ["--no-warnings", path.join(root, "server", "index.ts")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, FREE_SIGNER_KEY: DEV_KEY, OPERATOR_KEY: DEV_KEY, INDEX_INTERVAL_MS: "400", FREE_CLAIMS_PER_IP_PER_DAY: "50" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i++) { if (await addr.contracts().then(() => true, () => false)) break; await sleep(250); }

  owner = new Wallet(Wallet.createRandom().privateKey, provider);
  signer = new ethers.NonceManager(owner);
  await provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 20n).toString(16)]);
  const v = await addr.freeClaim(label, owner.address);
  const reg = new Contract(dep.registrar, registrarAbi, signer);
  const secret = ethers.hexlify(ethers.randomBytes(32));
  await (await reg.commit(await reg.makeCommitment(label, owner.address, secret))).wait();
  await sleep(2600);
  await (await reg.register({ label, owner: owner.address, years_: 1, token: ethers.ZeroAddress, secret, deadline: v.deadline, voucher: v.signature })).wait();
  const res = new Contract(dep.resolver, resolverAbi, signer);
  const tron = getNetwork("tron")!;
  await (await res["setAddr(bytes32,uint256,bytes)"](namehash(label + ".addr"), tron.coinType, bytesToHex(encodeAddress(tron, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")))).wait();
});

after(async () => {
  server?.kill();
  await sleep(300);
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) try { fs.unlinkSync(f); } catch { /* ignore */ }
});

test("REST SDK resolves, validates, and surfaces typed errors", async () => {
  const r = await addr.resolve(`${label}.addr`, { network: "tron", asset: "USDT", standard: "TRC20" });
  assert.equal(r.address, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(r.verified, true);
  await assert.rejects(() => addr.resolve(`${label}.addr`, { network: "bitcoin" }), (e: any) => e instanceof AddrApiError && e.code === "record_not_set");
  await assert.rejects(() => addr.resolve(`${label}.addr`, { asset: "USDT" }), (e: any) => e.code === "network_required");
  assert.equal((await addr.validate("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).valid, true);
  assert.equal((await addr.name(`${label}.addr`)).owner, owner.address);
});

test("on-chain resolver agrees with the API and needs no ADDR server", async () => {
  const chain = new AddrChainResolver(provider, { registry: dep.registry, resolver: dep.resolver });
  const c = await chain.resolve(`${label}.addr`, { network: "tron", asset: "USDT", standard: "TRC20" });
  const a = await addr.resolve(`${label}.addr`, { network: "tron" });
  assert.equal(c.address, a.address);
  assert.equal(c.version, a.version);
  await assert.rejects(() => chain.resolve(`${label}.addr`, { network: "bitcoin" }), (e: any) => e.code === "record_not_set");
  await assert.rejects(() => chain.resolve(`nobodyhasthis${label}.addr`, { network: "tron" }), (e: any) => e.code === "name_not_registered");
});

test("webhook signature verification accepts valid and rejects tampered or stale payloads", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "e1", type: "record.changed" });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  assert.equal((await verifyWebhook(body, `t=${t},v1=${sig}`, secret)).id, "e1");
  await assert.rejects(() => verifyWebhook(body + " ", `t=${t},v1=${sig}`, secret), /mismatch/);
  const old = t - 3600;
  const oldSig = crypto.createHmac("sha256", secret).update(`${old}.${body}`).digest("hex");
  await assert.rejects(() => verifyWebhook(body, `t=${old},v1=${oldSig}`, secret), /tolerance/);
});

test("CLI works end to end", () => {
  const run = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", path.join(root, "packages", "cli", "addr.ts"), ...a], { env: { ...process.env, ADDR_API: `http://127.0.0.1:${PORT}` }, encoding: "utf8" });
  assert.equal(JSON.parse(run("resolve", `${label}.addr`, "--network", "tron")).address, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(JSON.parse(run("resolve-onchain", `${label}.addr`, "--network", "tron", "--rpc", "http://127.0.0.1:8545")).address, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  assert.equal(JSON.parse(run("validate", "bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).valid, true);
  assert.throws(() => run("resolve", "missing-name-xyz.addr", "--network", "tron"), /name_not_registered/);
});
