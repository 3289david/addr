import {
  AddrError, NETWORKS, UNSUPPORTED_NETWORKS, bytesToHex, decodeAddress, explorerAddressUrl, getAsset, getNetwork,
  isMultiNetworkAsset, namehash, normalizeName, parentName, validateAddress, type Network, type Asset,
} from "../packages/core/src/index.ts";
import { registry, resolver, deployment, chainNow } from "./chain.ts";
import { db, now } from "./db.ts";
import { getBytes } from "ethers";

export type NameStatus = "active" | "grace" | "expired" | "available";

export interface NameInfo {
  name: string;
  node: string;
  status: NameStatus;
  owner: string | null;
  expiresAt: number | null;
  gracePeriodEndsAt: number | null;
  resolver: string | null;
  parent: string | null;
  lockedUntil: number | null;
  level: "second" | "sub";
  contracts: { registry: string; resolver: string; chainId: number };
}

const GRACE = 30 * 86400;

export async function getNameInfo(input: string): Promise<NameInfo> {
  const name = normalizeName(input);
  const node = namehash(name);
  const parent = parentName(name);
  const [statusN, activeOwner, rawOwner, res, exp, lock] = await Promise.all([
    registry.statusOf(node) as Promise<bigint>,
    registry.ownerOf(node) as Promise<string>,
    registry.rawOwner(node) as Promise<string>,
    registry.resolverOf(node) as Promise<string>,
    registry.expiresAt(node) as Promise<bigint>,
    registry.lockedUntil(node) as Promise<bigint>,
  ]);
  const zero = "0x0000000000000000000000000000000000000000";
  let status: NameStatus;
  switch (Number(statusN)) {
    case 1: status = "active"; break;
    case 2: status = "grace"; break;
    case 3: status = rawOwner === zero ? "available" : "expired"; break;
    default: status = "available";
  }
  const second = !parent;
  return {
    name, node, status,
    owner: status === "active" ? activeOwner : status === "grace" ? rawOwner : null,
    expiresAt: second && Number(exp) > 0 ? Number(exp) : null,
    gracePeriodEndsAt: second && Number(exp) > 0 ? Number(exp) + GRACE : null,
    resolver: status === "active" && res !== zero ? res : null,
    parent: parent,
    lockedUntil: Number(lock) > (await chainNow()) ? Number(lock) : null,
    level: second ? "second" : "sub",
    contracts: { registry: deployment.registry, resolver: deployment.resolver, chainId: deployment.chainId },
  };
}

export interface ResolvedRecord {
  name: string;
  node: string;
  network: string;
  networkName: string;
  coinType: number;
  asset: string;
  standard: string;
  tokenContract?: string;
  address: string;
  /** Format + checksum valid, read directly from the on-chain record of an active name. Not a statement about the recipient. */
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

const RECENT_CHANGE_SECS = 24 * 3600;

async function readRecord(node: string, coinType: number): Promise<{ raw: string; updatedAt: number; block: number; version: number }> {
  const [raw, meta] = await Promise.all([
    resolver["addr(bytes32,uint256)"](node, coinType) as Promise<string>,
    resolver.addrMeta(node, coinType) as Promise<[bigint, bigint, bigint]>,
  ]);
  return { raw, updatedAt: Number(meta[0]), block: Number(meta[1]), version: Number(meta[2]) };
}

export function pickAsset(net: Network, assetSym?: string, standard?: string): Asset {
  if (!assetSym) return net.assets[0];
  const a = getAsset(net, assetSym, standard);
  if (!a) {
    throw new AddrError("unsupported_asset", `${assetSym.toUpperCase()}${standard ? ` (${standard})` : ""} is not supported on ${net.name}. Supported: ${net.assets.map((x) => `${x.symbol}/${x.standard}`).join(", ")}`, 422);
  }
  return a;
}

export async function resolveName(input: string, networkId?: string, assetSym?: string, standard?: string): Promise<ResolvedRecord> {
  const asset0 = assetSym?.toUpperCase();
  if (!networkId) {
    if (asset0 && isMultiNetworkAsset(asset0)) {
      throw new AddrError("network_required", `${asset0} exists on several networks; specify network (and standard) explicitly`, 422);
    }
    if (!asset0) throw new AddrError("network_required", "network is required", 422);
    const hit = NETWORKS.find((n) => n.nativeSymbol === asset0 && n.family !== "evm") ?? (asset0 === "ETH" ? getNetwork("ethereum") : undefined);
    if (!hit) throw new AddrError("network_required", "network is required", 422);
    networkId = hit.id;
  }
  networkId = networkId.toLowerCase();
  if (UNSUPPORTED_NETWORKS.includes(networkId)) {
    throw new AddrError("network_unsupported", `${networkId} is not supported yet`, 501);
  }
  const net = getNetwork(networkId);
  if (!net) throw new AddrError("network_unknown", `unknown network "${networkId}"`, 404);
  const asset = pickAsset(net, assetSym, standard);

  const info = await getNameInfo(input);
  if (info.status === "available") throw new AddrError("name_not_registered", `${info.name} is not registered`, 404);
  if (info.status !== "active") {
    throw new AddrError("name_expired", `${info.name} is ${info.status}; resolution and sending are blocked until it is renewed`, 410);
  }

  let rec = await readRecord(info.node, net.coinType);
  let source: ResolvedRecord["source"] = "record";
  let fallbackWarning: string | undefined;
  if (rec.raw === "0x" && net.family === "evm" && net.coinType !== 60) {
    const eth = await readRecord(info.node, 60);
    if (eth.raw !== "0x") {
      rec = eth;
      source = "fallback-ethereum";
      fallbackWarning = `No ${net.name}-specific address is set; showing the Ethereum address. Smart-contract wallets may not control this address on ${net.name}. Confirm with the recipient before sending.`;
    }
  }
  if (rec.raw === "0x") {
    throw new AddrError("record_not_set", `${info.name} has no ${net.name} address record`, 404);
  }
  let address: string;
  try {
    address = decodeAddress(net, getBytes(rec.raw));
  } catch (e) {
    throw new AddrError("record_invalid", `stored record failed validation: ${(e as Error).message}`, 502);
  }
  const check = validateAddress(net.id, address);
  if (!check.valid) throw new AddrError("record_invalid", `stored record failed validation: ${check.error}`, 502);

  return {
    name: info.name, node: info.node, network: net.id, networkName: net.name, coinType: net.coinType,
    asset: asset.symbol, standard: asset.standard, tokenContract: asset.contract,
    address, verified: true, addressFormat: check.format!, source, fallbackWarning,
    updatedAt: rec.updatedAt || null, updatedBlock: rec.block || null, version: rec.version,
    recentlyChanged: rec.updatedAt > 0 && (await chainNow()) - rec.updatedAt < RECENT_CHANGE_SECS,
    explorer: explorerAddressUrl(net, address),
  };
}

export async function allRecords(input: string) {
  const info = await getNameInfo(input);
  if (info.status !== "active") {
    return { ...info, records: [] as unknown[], unsupported: UNSUPPORTED_NETWORKS };
  }
  const cn = await chainNow();
  const records = await Promise.all(
    NETWORKS.map(async (net) => {
      const rec = await readRecord(info.node, net.coinType);
      if (rec.raw === "0x") return null;
      try {
        const address = decodeAddress(net, getBytes(rec.raw));
        return {
          network: net.id, networkName: net.name, coinType: net.coinType, address,
          nativeSymbol: net.nativeSymbol,
          assets: net.assets.map((a) => ({ symbol: a.symbol, standard: a.standard, contract: a.contract ?? null })),
          updatedAt: rec.updatedAt || null, updatedBlock: rec.block || null, version: rec.version,
          recentlyChanged: rec.updatedAt > 0 && cn - rec.updatedAt < RECENT_CHANGE_SECS,
        };
      } catch {
        return { network: net.id, error: "stored record failed validation" };
      }
    }),
  );
  const texts: Record<string, string> = {};
  for (const key of ["avatar", "display", "description", "url", "email", "twitter", "github"]) {
    const v = (await resolver.text(info.node, key)) as string;
    if (v) texts[key] = v;
  }
  return { ...info, records: records.filter(Boolean), profile: texts, unsupported: UNSUPPORTED_NETWORKS };
}

export async function reverseLookup(address: string) {
  const { getAddress, isAddress } = await import("ethers");
  if (isAddress(address)) {
    const a = getAddress(address);
    const [name, node] = (await resolver.reverse(a)) as [string, string];
    const candidates = db.prepare(
      `SELECT n.name FROM records r JOIN names n ON n.node = r.node
       WHERE r.coin_type = 60 AND lower(r.address) = lower(?) AND (n.parent IS NOT NULL OR n.expires > ?) LIMIT 20`,
    ).all(a, now()).map((r: any) => r.name);
    return {
      address: a,
      primaryName: name || null,
      node: name ? node : null,
      verified: Boolean(name),
      note: name ? "Primary name is set by the address and verified against ownership/forward record." : "No verified primary name is set for this address.",
      recordMatches: candidates,
    };
  }
  for (const net of NETWORKS.filter((n) => n.family !== "evm")) {
    const c = validateAddress(net.id, address);
    if (!c.valid) continue;
    const rows = db.prepare(
      `SELECT n.name FROM records r JOIN names n ON n.node = r.node WHERE r.coin_type = ? AND r.address = ? AND (n.parent IS NOT NULL OR n.expires > ?) LIMIT 20`,
    ).all(net.coinType, address, now()).map((r: any) => r.name);
    return {
      address, network: net.id, primaryName: null, verified: false,
      note: "Primary names are only supported for EVM addresses. These names point at this address but the address owner has not attested them.",
      recordMatches: rows,
    };
  }
  throw new AddrError("invalid_address", "not a recognized address", 422);
}

