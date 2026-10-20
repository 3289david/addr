// Exercises the BTC/LTC (esplora) payment verifier against REAL mainnet data (read-only, public APIs).
// The 2010 pizza transaction (block 57043): 10,000 BTC to 17SkEw2md5avVNyYgj6RiXuQKNwkXaxFyQ.
import assert from "node:assert/strict";
import { observeEsplora } from "../server/payments.ts";

const tx = "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d";
const r = await observeEsplora("https://mempool.space/api", tx, "17SkEw2md5avVNyYgj6RiXuQKNwkXaxFyQ");
console.log(r);
assert.equal(r.found, true);
assert.equal(r.received, 1_000_000_000_000n); // 10,000 BTC
assert.ok(r.confirmations > 100000);
const wrong = await observeEsplora("https://mempool.space/api", tx, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
assert.equal(wrong.received, 0n);
const missing = await observeEsplora("https://mempool.space/api", "00".repeat(32), "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
assert.equal(missing.found, false);
console.log("BTC verifier OK against live mainnet data");

// TRON: take a recent real USDT-TRC20 Transfer event from TronGrid's event API (independent source) and check
// that our verifier, which parses transaction-info logs, derives the same recipient amount.
import { getAsset, getNetwork, base58CheckEncode, hexToBytes, concat } from "../packages/core/src/index.ts";
import { observeTron, observeSolana } from "../server/payments.ts";
const tron = getNetwork("tron")!;
const usdt = getAsset(tron, "USDT", "TRC20")!;
const ev: any = await (await fetch(`https://api.trongrid.io/v1/contracts/${usdt.contract}/events?event_name=Transfer&only_confirmed=true&limit=1`)).json();
const e = ev.data?.[0];
assert.ok(e, "no TRC20 event returned by TronGrid");
const toBase58 = e.result.to.startsWith("T") ? e.result.to : base58CheckEncode(concat(Uint8Array.of(0x41), hexToBytes("0x" + e.result.to.replace(/^0x/, "").replace(/^41/, ""))));
const tr = await observeTron(e.transaction_id, toBase58, usdt, usdt.contract);
console.log("tron", { tx: e.transaction_id, to: toBase58, expected: e.result.value, observed: tr.received.toString(), confirmations: tr.confirmations });
assert.ok(tr.found);
assert.ok(tr.received >= BigInt(e.result.value));
console.log("TRON TRC20 verifier OK against live mainnet data");

// Solana: pick a real recent signature for the USDT mint, find a SOL balance change from the raw tx, and verify
// the observer reports the same delta for that account.
const rpc = async (method: string, params: unknown[]) => (await (await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as any).result;
const sigs = await rpc("getSignaturesForAddress", ["5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", { limit: 5 }]).catch(() => null);
let done = false;
for (const { signature: sig } of sigs ?? []) {
  if (done) break;
  const raw = await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  const keys = raw.transaction.message.accountKeys;
  const i = keys.findIndex((_: any, n: number) => raw.meta.postBalances[n] - raw.meta.preBalances[n] > 0);
  if (i >= 0 && !raw.meta.err) {
    const acct = keys[i].pubkey ?? keys[i];
    const delta = BigInt(raw.meta.postBalances[i] - raw.meta.preBalances[i]);
    const sol = await observeSolana(sig, acct, getAsset(getNetwork("solana")!, "SOL")!);
    console.log("solana", { sig: sig.slice(0, 12) + "...", acct, delta: delta.toString(), observed: sol.received.toString() });
    assert.equal(sol.received, delta);
    console.log("Solana verifier OK against live mainnet data");
    done = true;
  }
}
if (!done) console.log("solana: no suitable sampled tx (or RPC rate limited), skipped");
process.exit(0);
