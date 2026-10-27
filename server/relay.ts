// Gasless "address changes & contract actions": the owner signs an EIP-712 message for free (no
// transaction, no gas) authorizing one specific action; the operator submits it on-chain and pays
// the gas. The contract (not this file) is what actually enforces that the signer is authorized —
// see setAddrSigned/setPrimaryNameSigned/transferSigned in AddrRegistry.sol/AddrResolver.sol. This
// file is just rate-limiting + relaying; a bad signature simply reverts on-chain and the error comes
// straight back to the caller.
import { getAddress } from "ethers";
import { AddrError, validateAddress } from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { audit } from "./db.ts";
import { deployment, enqueueTx, operator, operatorAddress, registry, resolver } from "./chain.ts";
import { rateCheck } from "./enterprise.ts";
import { clientIp, sha256 } from "./auth.ts";
import type { IncomingMessage } from "node:http";

function requireOperator() {
  if (!operator || !operatorAddress) throw new AddrError("sponsor_unavailable", "the gasless relayer is not enabled on this server (no operator key configured)", 503);
}

function hex32(v: unknown, name: string): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new AddrError("invalid_request", `${name} must be a 32-byte hex value`, 422);
  return v;
}
function hexBytes(v: unknown, name: string): string {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new AddrError("invalid_request", `${name} must be a hex byte string`, 422);
  return v;
}
function uint(v: unknown, name: string): bigint {
  try { const n = BigInt(v as any); if (n < 0n) throw 0; return n; } catch { throw new AddrError("invalid_request", `${name} must be a non-negative integer`, 422); }
}
function sig(v: unknown): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(v)) throw new AddrError("invalid_request", "signature must be a 65-byte hex signature", 422);
  return v;
}

function limitPerCaller(req: IncomingMessage, bucket: string) {
  rateCheck(`relay:ip:${bucket}:` + sha256(clientIp(req) + "|" + new Date().toISOString().slice(0, 10)).slice(0, 24), 100);
}

/** The EIP-712 domains/types callers need to produce a signature — surfaced so client code never
 *  has to hardcode (and risk drifting from) the contract's own typehash definitions. */
export function relayDomains() {
  return {
    resolver: { domain: { name: "AddrResolver", version: "1", chainId: config.chainId, verifyingContract: deployment.resolver },
      types: {
        SetAddr: [{ name: "node", type: "bytes32" }, { name: "coinType", type: "uint256" }, { name: "value", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
        SetPrimaryName: [{ name: "node", type: "bytes32" }, { name: "name", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
      } },
    registry: { domain: { name: "AddrRegistry", version: "1", chainId: config.chainId, verifyingContract: deployment.registry },
      types: { Transfer: [{ name: "node", type: "bytes32" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } },
  };
}

/** Current nonces for an address on both contracts — what a client should sign next. */
export async function relayNonces(addressIn: string) {
  if (!validateAddress("ethereum", addressIn).valid) throw new AddrError("invalid_address", "address must be a valid EVM address", 422);
  const address = getAddress(addressIn);
  const [resolverNonce, registryNonce] = await Promise.all([resolver.nonces(address), registry.nonces(address)]);
  return { address, resolverNonce: Number(resolverNonce), registryNonce: Number(registryNonce) };
}

export async function relaySetAddr(req: IncomingMessage, b: any) {
  requireOperator();
  limitPerCaller(req, "setaddr");
  const node = hex32(b?.node, "node");
  const coinType = uint(b?.coinType, "coinType");
  const value = hexBytes(b?.value, "value");
  const nonce = uint(b?.nonce, "nonce");
  const deadline = uint(b?.deadline, "deadline");
  const signature = sig(b?.signature);
  const hash = await enqueueTx(async () => {
    const tx = await resolver.connect(operator).setAddrSigned(node, coinType, value, nonce, deadline, signature);
    const rc = await tx.wait();
    return rc!.hash as string;
  });
  audit(null, "system", "relay.setAddr", node, { coinType: coinType.toString(), tx: hash });
  return { ok: true, tx: hash };
}

export async function relaySetPrimaryName(req: IncomingMessage, b: any) {
  requireOperator();
  limitPerCaller(req, "setprimary");
  const name = typeof b?.name === "string" && b.name ? b.name : (() => { throw new AddrError("invalid_request", "name is required", 422); })();
  const nonce = uint(b?.nonce, "nonce");
  const deadline = uint(b?.deadline, "deadline");
  const signature = sig(b?.signature);
  const hash = await enqueueTx(async () => {
    const tx = await resolver.connect(operator).setPrimaryNameSigned(name, nonce, deadline, signature);
    const rc = await tx.wait();
    return rc!.hash as string;
  });
  audit(null, "system", "relay.setPrimaryName", null, { name, tx: hash });
  return { ok: true, tx: hash };
}

export async function relayTransfer(req: IncomingMessage, b: any) {
  requireOperator();
  limitPerCaller(req, "transfer");
  const node = hex32(b?.node, "node");
  if (!validateAddress("ethereum", b?.to).valid) throw new AddrError("invalid_address", "to must be a valid EVM address", 422);
  const to = getAddress(b.to);
  const nonce = uint(b?.nonce, "nonce");
  const deadline = uint(b?.deadline, "deadline");
  const signature = sig(b?.signature);
  const hash = await enqueueTx(async () => {
    const tx = await registry.connect(operator).transferSigned(node, to, nonce, deadline, signature);
    const rc = await tx.wait();
    return rc!.hash as string;
  });
  audit(null, "system", "relay.transfer", node, { to, tx: hash });
  return { ok: true, tx: hash };
}
