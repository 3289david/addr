// Browser/extension-safe, framework-free wallet logic: resolves and reads .addr records directly from
// the registry/resolver contracts over any ethers Provider. No DOM assumptions, no ADDR API dependency.
// Shared by web/src/wallet.js (the main site), the wallet PWA, and the browser extension so this logic
// exists in exactly one place.
import { Contract, getBytes, type Provider } from "ethers";
import { registryAbi, resolverAbi } from "./abi.ts";
import { namehash, normalizeName, parentName } from "./names.ts";
import { decodeAddress, validateAddress } from "./address.ts";
import { NETWORKS, UNSUPPORTED_NETWORKS, getNetwork, getAsset, isMultiNetworkAsset, explorerAddressUrl, type Network } from "./chains.ts";

export interface AddrDeployment {
  registry: string;
  resolver: string;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const RECENT_CHANGE_SECS = 24 * 3600;

export function contractsFor(dep: AddrDeployment, provider: Provider) {
  return {
    registry: new Contract(dep.registry, registryAbi, provider),
    resolver: new Contract(dep.resolver, resolverAbi, provider),
  };
}

async function nameInfoOnChain(dep: AddrDeployment, provider: Provider, input: string) {
  const { registry, resolver } = contractsFor(dep, provider);
  const name = normalizeName(input);
  const node = namehash(name);
  const parent = parentName(name);
  const [statusN, activeOwner, rawOwner, res] = await Promise.all([
    registry.statusOf(node), registry["ownerOf(bytes32)"](node), registry.rawOwner(node), registry.resolverOf(node),
  ]);
  let status: "available" | "active" | "grace" | "expired";
  switch (Number(statusN)) {
    case 1: status = "active"; break;
    case 2: status = "grace"; break;
    case 3: status = rawOwner === ZERO_ADDR ? "available" : "expired"; break;
    default: status = "available";
  }
  return {
    name, node, status, parent,
    owner: status === "active" ? (activeOwner as string) : status === "grace" ? (rawOwner as string) : null,
    resolverAddr: status === "active" && res !== ZERO_ADDR ? (res as string) : null,
    resolver,
  };
}

async function readRecordOnChain(resolver: Contract, node: string, coinType: number) {
  const [raw, meta] = await Promise.all([
    resolver["addr(bytes32,uint256)"](node, coinType) as Promise<string>,
    resolver.addrMeta(node, coinType) as Promise<[bigint, bigint, bigint]>,
  ]);
  return { raw, updatedAt: Number(meta[0]), block: Number(meta[1]), version: Number(meta[2]) };
}

export interface ResolvedRecord {
  name: string; node: string; network: string; networkName: string; coinType: number;
  asset: string; standard: string; tokenContract?: string; address: string; verified: true;
  addressFormat: string; source: "record" | "fallback-ethereum"; fallbackWarning?: string;
  updatedAt: number | null; updatedBlock: number | null; version: number; recentlyChanged: boolean; explorer: string;
}

/** Resolves a .addr name directly from the chain. No API, no SDK beyond this module's own pure logic. */
export async function resolveOnChain(dep: AddrDeployment, provider: Provider, input: string, networkId?: string, assetSym?: string, standard?: string): Promise<ResolvedRecord> {
  const asset0 = assetSym?.toUpperCase();
  if (!networkId) {
    if (asset0 && isMultiNetworkAsset(asset0)) throw new Error(`${asset0} exists on several networks; specify network (and standard) explicitly`);
    if (!asset0) throw new Error("network is required");
    const hit = NETWORKS.find((n) => n.nativeSymbol === asset0 && n.family !== "evm") ?? (asset0 === "ETH" ? getNetwork("ethereum") : undefined);
    if (!hit) throw new Error("network is required");
    networkId = hit.id;
  }
  networkId = networkId.toLowerCase();
  if (UNSUPPORTED_NETWORKS.includes(networkId)) throw new Error(`${networkId} is not supported yet`);
  const net = getNetwork(networkId) as Network | undefined;
  if (!net) throw new Error(`unknown network "${networkId}"`);
  const asset = assetSym ? getAsset(net, assetSym, standard) : net.assets[0];
  if (!asset) throw new Error(`${assetSym?.toUpperCase() ?? ""}${standard ? ` (${standard})` : ""} is not supported on ${net.name}. Supported: ${net.assets.map((x) => `${x.symbol}/${x.standard}`).join(", ")}`);

  const info = await nameInfoOnChain(dep, provider, input);
  if (info.status === "available") throw new Error(`${info.name} is not registered`);
  if (info.status !== "active") throw new Error(`${info.name} is ${info.status}; resolution and sending are blocked until it is renewed`);

  let rec = await readRecordOnChain(info.resolver, info.node, net.coinType);
  let source: ResolvedRecord["source"] = "record";
  let fallbackWarning: string | undefined;
  if (rec.raw === "0x" && net.family === "evm" && net.coinType !== 60) {
    const eth = await readRecordOnChain(info.resolver, info.node, 60);
    if (eth.raw !== "0x") {
      rec = eth; source = "fallback-ethereum";
      fallbackWarning = `No ${net.name}-specific address is set; showing the Ethereum address. Smart-contract wallets may not control this address on ${net.name}. Confirm with the recipient before sending.`;
    }
  }
  if (rec.raw === "0x") throw new Error(`${info.name} has no ${net.name} address record`);
  let address: string;
  try { address = decodeAddress(net, getBytes(rec.raw)); }
  catch (e) { throw new Error(`stored record failed validation: ${(e as Error).message}`); }
  const check = validateAddress(net.id, address);
  if (!check.valid) throw new Error(`stored record failed validation: ${check.error}`);

  const nowSecs = Math.floor(Date.now() / 1000);
  return {
    name: info.name, node: info.node, network: net.id, networkName: net.name, coinType: net.coinType,
    asset: asset.symbol, standard: asset.standard, tokenContract: asset.contract,
    address, verified: true, addressFormat: check.format!, source, fallbackWarning,
    updatedAt: rec.updatedAt || null, updatedBlock: rec.block || null, version: rec.version,
    recentlyChanged: rec.updatedAt > 0 && nowSecs - rec.updatedAt < RECENT_CHANGE_SECS,
    explorer: explorerAddressUrl(net, address),
  };
}

/** The primary (reverse) .addr name for an address, if the owner has set one. Null if none. */
export async function reverseOnChain(dep: AddrDeployment, provider: Provider, address: string): Promise<string | null> {
  const { resolver } = contractsFor(dep, provider);
  const [name] = (await resolver.reverse(address)) as [string, string];
  return name || null;
}

/** Native-currency balance for an address, formatted as a plain decimal string. */
export async function nativeBalance(provider: Provider, address: string): Promise<bigint> {
  return provider.getBalance(address);
}
