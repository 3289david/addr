// Gasless free-name claims: the operator submits commit() and register() itself and pays the gas, so the
// owner never needs any ETH at all. The owner only ever signs a free off-chain message (no transaction, no
// cost) proving they control the destination wallet — without that, anyone could burn a stranger's one
// free-name slot by registering an unwanted name into their wallet.
import crypto from "node:crypto";
import { getAddress, hexlify, keccak256, parseEther, randomBytes, toUtf8Bytes, verifyMessage, ZeroAddress } from "ethers";
import { AddrError, normalizeLabel, validateAddress } from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { audit, db, now } from "./db.ts";
import { chainNow, deployment, enqueueTx, freeSigner, operator, operatorAddress, provider, registrar } from "./chain.ts";
import { rateCheck } from "./enterprise.ts";
import { emit } from "./webhooks.ts";
import { clientIp, sha256 } from "./auth.ts";
import type { IncomingMessage } from "node:http";

const newId = () => "spc_" + crypto.randomBytes(10).toString("hex");

let minAgeCache = { at: 0, sec: 60 };
/** registrar.minCommitmentAge(), cached briefly — the real on-chain requirement, not a guessed config value. */
async function minCommitmentAge(): Promise<number> {
  if (Date.now() - minAgeCache.at < 60_000) return minAgeCache.sec;
  const sec = Number(await registrar.minCommitmentAge());
  minAgeCache = { at: Date.now(), sec };
  return sec;
}

export function sponsorClaimMessage(label: string, owner: string): string {
  return `ADDR sponsored free claim\nname: ${label}.addr\nowner: ${owner}\nchain: ${config.chainId}\nThis only proves you control this wallet. It does not cost anything and does not move funds.`;
}

function row(id: string) {
  const r = db.prepare("SELECT * FROM sponsored_claims WHERE id = ?").get(id) as any;
  if (!r) throw new AddrError("claim_not_found", "sponsored claim not found", 404);
  return r;
}

export async function publicSponsoredClaim(id: string) {
  const r = row(id);
  return {
    id: r.id, label: r.label, name: `${r.label}.addr`, owner: r.owner, status: r.status,
    commitTx: r.commit_tx, registerTx: r.register_tx, error: r.error,
    readyAt: r.committed_at ? r.committed_at + (await minCommitmentAge()) : null,
    createdAt: r.created, updatedAt: r.updated,
  };
}

export async function requestSponsoredClaim(req: IncomingMessage, labelIn: string, ownerIn: string, signature: string) {
  if (!operator || !operatorAddress) throw new AddrError("sponsor_unavailable", "sponsored claims are not enabled on this server (no operator key configured)", 503);
  if (!freeSigner) throw new AddrError("sponsor_unavailable", "free claims are not enabled on this server", 503);
  const label = normalizeLabel(labelIn);
  if (label.length < 5) throw new AddrError("not_free", "free names must be at least 5 characters", 422);
  if (!validateAddress("ethereum", ownerIn).valid) throw new AddrError("invalid_owner", "owner must be a valid EVM wallet address", 422);
  const owner = getAddress(ownerIn);
  let signer: string;
  try { signer = verifyMessage(sponsorClaimMessage(label, owner), signature); } catch { throw new AddrError("bad_signature", "signature is invalid", 422); }
  if (getAddress(signer) !== owner) throw new AddrError("bad_signature", "signature must come from the owner address", 403);

  if ((await registrar.freeClaimed(owner)) as boolean) throw new AddrError("free_already_claimed", "this wallet already claimed its free name", 409);
  if (!((await registrar.available(label)) as boolean)) throw new AddrError("name_unavailable", `${label}.addr is not available`, 409);

  const pending = db.prepare("SELECT id, status FROM sponsored_claims WHERE owner = ? AND status NOT IN ('completed','failed') ORDER BY created DESC LIMIT 1").get(owner) as any;
  if (pending) return await publicSponsoredClaim(pending.id);

  rateCheck("sponsor:ip:" + sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24), config.freeClaimsPerIpPerDay);
  rateCheck("sponsor:owner:" + owner, 5);

  const secret = hexlify(randomBytes(32));
  const id = newId();
  const t = now();
  db.prepare("INSERT INTO sponsored_claims (id, label, owner, secret, status, created, updated) VALUES (?,?,?,?,?,?,?)")
    .run(id, label, owner, secret, "pending", t, t);
  audit(null, "system", "sponsor.request", id, { label, owner });

  try {
    const commitment = (await registrar.makeCommitment(label, owner, secret)) as string;
    const hash = await enqueueTx(async () => {
      const tx = await registrar.connect(operator).commit(commitment);
      const rc = await tx.wait();
      return rc!.hash as string;
    });
    db.prepare("UPDATE sponsored_claims SET status='committed', commit_tx=?, committed_at=?, updated=? WHERE id=?")
      .run(hash, now(), now(), id);
  } catch (e) {
    const msg = ((e as any).shortMessage || (e as Error).message || "commit failed").slice(0, 300);
    db.prepare("UPDATE sponsored_claims SET status='failed', error=?, updated=? WHERE id=?").run(msg, now(), id);
  }
  return await publicSponsoredClaim(id);
}

async function finalizeSponsoredClaim(id: string) {
  const r = row(id);
  if (r.status !== "committed") return;
  if (now() < r.committed_at + (await minCommitmentAge())) return;
  db.prepare("UPDATE sponsored_claims SET status='registering', updated=? WHERE id=? AND status='committed'").run(now(), id);
  try {
    if ((await registrar.freeClaimed(r.owner)) as boolean) throw new AddrError("free_already_claimed", "this wallet already claimed its free name (via another path)", 409);
    if (!((await registrar.available(r.label)) as boolean)) throw new AddrError("name_unavailable", `${r.label}.addr is no longer available`, 409);
    const deadline = (await chainNow(true)) + 3600;
    const domain = { name: "AddrRegistrar", version: "1", chainId: config.chainId, verifyingContract: deployment.registrar };
    const types = { FreeClaim: [{ name: "owner", type: "address" }, { name: "labelhash", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
    const labelhash = keccak256(toUtf8Bytes(r.label));
    const voucherSig = await freeSigner!.signTypedData(domain, types, { owner: r.owner, labelhash, deadline });
    const hash = await enqueueTx(async () => {
      const tx = await registrar.connect(operator).register(
        { label: r.label, owner: r.owner, years_: 1, token: ZeroAddress, secret: r.secret, deadline, voucher: voucherSig },
        { value: 0n },
      );
      const rc = await tx.wait();
      return rc!.hash as string;
    });
    db.prepare("UPDATE sponsored_claims SET status='completed', register_tx=?, updated=? WHERE id=?").run(hash, now(), id);
    emit({ id: `sponsor:${id}:completed`, type: "name.registered", tenantId: null, name: `${r.label}.addr`, data: { sponsored: true, owner: r.owner } });
  } catch (e) {
    const msg = ((e as any).shortMessage || (e as Error).message || "register failed").slice(0, 300);
    db.prepare("UPDATE sponsored_claims SET status='failed', error=?, updated=? WHERE id=?").run(msg, now(), id);
  }
}

export async function sponsorTick() {
  const rows = db.prepare("SELECT id FROM sponsored_claims WHERE status = 'committed' LIMIT 25").all() as { id: string }[];
  for (const r of rows) {
    try { await finalizeSponsoredClaim(r.id); } catch (e) { console.error("sponsor tick", r.id, (e as Error).message); }
  }
}

export function startSponsorWorker() {
  setInterval(() => sponsorTick().catch((e) => console.error("sponsor worker", e)), 5_000).unref();
}

export async function dripGas(req: IncomingMessage, targetAddressIn: string) {
  if (!operator || !operatorAddress) {
    throw new AddrError("sponsor_unavailable", "Gasless relayer is not available", 503);
  }
  if (!validateAddress("ethereum", targetAddressIn).valid) {
    throw new AddrError("invalid_address", "target must be a valid EVM address", 422);
  }
  const target = getAddress(targetAddressIn);

  rateCheck("drip:ip:" + sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24), 20);
  rateCheck("drip:addr:" + target, 10);

  const bal = await provider.getBalance(target);
  if (bal >= parseEther("0.0001")) {
    return { ok: true, message: "Wallet already has sufficient gas for Base", balance: bal.toString(), tx: null };
  }

  const opBal = await provider.getBalance(operatorAddress);
  const DRIP_AMOUNT = parseEther("0.00015");
  if (opBal < DRIP_AMOUNT * 2n) {
    throw new AddrError("relayer_low_balance", "Gasless relayer balance is low", 503);
  }

  const hash = await enqueueTx(async () => {
    const tx = await operator.sendTransaction({
      to: target,
      value: DRIP_AMOUNT,
    });
    const rc = await tx.wait();
    return rc!.hash as string;
  });

  audit(null, "system", "sponsor.drip", target, { tx: hash, amount: "0.00015 ETH" });
  return { ok: true, message: "Gas fee covered by Gasless Relayer", tx: hash, funded: "0.00015 ETH" };
}
