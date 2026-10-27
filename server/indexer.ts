import { Interface, getBytes, hexlify, type Log } from "ethers";
import {
  decodeAddress, getNetworkByCoinType, registryAbi, resolverAbi, registrarAbi, ROOT_NODE,
} from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { db, getMeta, setMeta, tx as dbtx } from "./db.ts";
import { deployment, provider } from "./chain.ts";
import { emit } from "./webhooks.ts";

const timelockAbi = [
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
];

const ifaces = {
  [deployment.registry.toLowerCase()]: new Interface(registryAbi),
  [deployment.resolver.toLowerCase()]: new Interface(resolverAbi),
  [deployment.registrar.toLowerCase()]: new Interface(registrarAbi),
  [deployment.timelock.toLowerCase()]: new Interface(timelockAbi),
};
const kindOf: Record<string, string> = {
  [deployment.registry.toLowerCase()]: "registry",
  [deployment.resolver.toLowerCase()]: "resolver",
  [deployment.registrar.toLowerCase()]: "registrar",
  [deployment.timelock.toLowerCase()]: "timelock",
};

const nameOf = (node: string): string | null =>
  (db.prepare("SELECT name FROM names WHERE node = ?").get(node) as { name: string } | undefined)?.name ?? null;

function upsertName(node: string, name: string, label: string, parent: string | null, owner: string, expires: number, block: number, free = 0) {
  db.prepare(
    `INSERT INTO names (node, name, label, parent, owner, expires, free, created_block, updated_block)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(node) DO UPDATE SET owner=excluded.owner, expires=excluded.expires, parent=excluded.parent,
       locked_until=0, resolver=NULL, updated_block=excluded.updated_block`,
  ).run(node, name, label, parent, owner, expires, free, block, block);
}

async function handleLog(log: Log, ts: number) {
  const iface = ifaces[log.address.toLowerCase()];
  if (!iface) return;
  const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed) return;
  const kind = kindOf[log.address.toLowerCase()];
  const a = parsed.args;
  const eventId = `${log.transactionHash}:${log.index}`;
  let node: string | null = null;
  let type: string | null = null;
  let data: Record<string, unknown> = {};

  if (kind === "registry") {
    switch (parsed.name) {
      case "NameRegistered": {
        node = a.node;
        const name = `${a.label}.addr`;
        upsertName(node!, name, a.label, null, a.owner, Number(a.expires), log.blockNumber);
        type = "name.registered";
        data = { name, owner: a.owner, expiresAt: Number(a.expires) };
        break;
      }
      case "NameRenewed":
        node = a.node;
        db.prepare("UPDATE names SET expires = ?, updated_block = ? WHERE node = ?").run(Number(a.expires), log.blockNumber, node);
        type = "name.renewed";
        data = { name: nameOf(node!), expiresAt: Number(a.expires) };
        break;
      case "Transfer": {
        // Two different Transfer events share this name now: the legacy
        // Transfer(bytes32 node, address from, address to) and the new ERC-721
        // Transfer(address from, address to, uint256 tokenId) added for marketplace
        // compatibility — both fire for every ownership change. Only the legacy one
        // carries anything this indexer needs; skip the ERC-721 one here.
        if (parsed.fragment.inputs[0]?.type !== "bytes32") break;
        node = a.node;
        db.prepare("UPDATE names SET owner = ?, updated_block = ? WHERE node = ?").run(a.to, log.blockNumber, node);
        type = "name.transferred";
        data = { name: nameOf(node!), from: a.from, to: a.to };
        break;
      }
      case "ResolverChanged":
        node = a.node;
        db.prepare("UPDATE names SET resolver = ? WHERE node = ?").run(a.resolver, node);
        type = "name.resolver_changed";
        data = { name: nameOf(node!), resolver: a.resolver };
        break;
      case "NameLocked":
        node = a.node;
        db.prepare("UPDATE names SET locked_until = ? WHERE node = ?").run(Number(a.until), node);
        type = "name.locked";
        data = { name: nameOf(node!), lockedUntil: Number(a.until) };
        break;
      case "SubnameCreated": {
        node = a.node;
        const parentRow = db.prepare("SELECT name FROM names WHERE node = ?").get(a.parent) as { name: string } | undefined;
        const parentNameStr = parentRow?.name ?? (a.parent === ROOT_NODE ? "addr" : null);
        if (!parentNameStr) break;
        const name = `${a.label}.${parentNameStr}`;
        upsertName(node!, name, a.label, a.parent, a.owner, 0, log.blockNumber);
        db.prepare("DELETE FROM records WHERE node = ?").run(node);
        type = "subname.created";
        data = { name, parent: parentNameStr, owner: a.owner };
        break;
      }
      case "SubnameRemoved":
        node = a.node;
        db.prepare("UPDATE names SET owner = NULL, updated_block = ? WHERE node = ?").run(log.blockNumber, node);
        type = "subname.removed";
        data = { name: nameOf(node!) };
        break;
      default:
        node = (a.node as string) ?? null;
        type = `registry.${parsed.name}`;
        data = Object.fromEntries(parsed.fragment.inputs.map((i, n) => [i.name, String(a[n])]));
    }
    if (parsed.name === "NameRegistered") {
      // a re-registration wipes any cached records of the previous registration
      db.prepare("DELETE FROM records WHERE node = ?").run(node);
    }
  } else if (kind === "resolver") {
    node = a.node ?? null;
    switch (parsed.name) {
      case "AddrChanged": {
        const coin = Number(a.coinType);
        const rawHex: string = hexlify(a.newAddress);
        const net = getNetworkByCoinType(coin);
        let human = "";
        if (net && rawHex !== "0x") {
          try { human = decodeAddress(net, getBytes(rawHex)); } catch { human = ""; }
        }
        db.prepare(
          `INSERT INTO records (node, coin_type, address, raw, version, block, ts) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(node, coin_type) DO UPDATE SET address=excluded.address, raw=excluded.raw, version=excluded.version, block=excluded.block, ts=excluded.ts`,
        ).run(node, coin, human, rawHex, Number(a.version), log.blockNumber, ts);
        type = "record.changed";
        data = { name: nameOf(node!), network: net?.id ?? null, coinType: coin, address: human || null, version: Number(a.version) };
        break;
      }
      case "TextChanged":
        type = "text.changed";
        data = { name: nameOf(node!), key: a.key, value: a.value };
        break;
      case "RecordsCleared":
        db.prepare("DELETE FROM records WHERE node = ?").run(node);
        type = "records.cleared";
        data = { name: nameOf(node!), version: Number(a.version) };
        break;
      default:
        type = `resolver.${parsed.name}`;
        data = Object.fromEntries(parsed.fragment.inputs.map((i, n) => [i.name, String(a[n])]));
    }
  } else if (kind === "registrar") {
    if (parsed.name === "NameRegistered") {
      node = a.node;
      if (a.free) db.prepare("UPDATE names SET free = 1 WHERE node = ?").run(node);
      type = "registrar.NameRegistered";
      data = { name: nameOf(node!), owner: a.owner, usdPaidMicro: String(a.usdPaid), free: a.free, token: a.token, amountPaid: String(a.amountPaid) };
    } else {
      node = (a.node as string) ?? null;
      type = `registrar.${parsed.name}`;
      data = Object.fromEntries(parsed.fragment.inputs.map((i, n) => [i.name, typeof a[n] === "bigint" ? String(a[n]) : a[n]]));
    }
  } else if (kind === "timelock") {
    type = `timelock.${parsed.name}`;
    data = Object.fromEntries(parsed.fragment.inputs.map((i, n) => [i.name, typeof a[n] === "bigint" ? String(a[n]) : a[n]]));
  }
  if (!type) return;

  const ins = db.prepare("INSERT OR IGNORE INTO events (tx, log_index, block, ts, contract, type, node, data) VALUES (?,?,?,?,?,?,?,?)")
    .run(log.transactionHash, log.index, log.blockNumber, ts, kind, type, node, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  if (Number(ins.changes) > 0 && !type.startsWith("registrar.") && !type.startsWith("timelock.") && !type.startsWith("registry.") && !type.startsWith("resolver.")) {
    emit({ id: eventId, type, name: (data as any).name ?? (data as any).parent ?? null, data });
  }
}

let busy = false;
export async function indexOnce(): Promise<{ from: number; to: number; logs: number }> {
  if (busy) return { from: 0, to: 0, logs: 0 };
  busy = true;
  try {
    const head = (await provider.getBlockNumber()) - config.confirmations;
    const last = Number(getMeta("last_block") ?? deployment.startBlock - 1);
    // re-read the most recent blocks every pass so shallow reorgs self-heal (writes are idempotent)
    const from = Math.max(last - 6, deployment.startBlock);
    if (head < from) return { from, to: head, logs: 0 };
    const addresses = Object.keys(kindOf);
    let total = 0;
    async function fetchLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
      try {
        return await provider.getLogs({ address: addresses, fromBlock, toBlock });
      } catch (e: any) {
        if (toBlock > fromBlock && /range|limit|413|payload|reached/i.test(String(e?.message ?? "") + String(e?.info?.responseBody ?? ""))) {
          const mid = Math.floor((fromBlock + toBlock) / 2);
          const left = await fetchLogs(fromBlock, mid);
          const right = await fetchLogs(mid + 1, toBlock);
          return [...left, ...right];
        }
        throw e;
      }
    }
    const CHUNK = 100;
    for (let start = from; start <= head; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, head);
      const logs = await fetchLogs(start, end);
      logs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      const blockTs = new Map<number, number>();
      for (const l of logs) {
        if (!blockTs.has(l.blockNumber)) blockTs.set(l.blockNumber, (await provider.getBlock(l.blockNumber))!.timestamp);
      }
      for (const l of logs) {
        try {
          await handleLog(l, blockTs.get(l.blockNumber)!);
        } catch (e) {
          console.error("indexer: failed log", l.transactionHash, l.index, e);
          throw e; // do not advance the cursor past an unhandled event
        }
      }
      total += logs.length;
      setMeta("last_block", String(end));
    }
    return { from, to: head, logs: total };
  } finally {
    busy = false;
  }
}

export function startIndexer() {
  const tick = () => indexOnce().catch((e) => console.error("indexer", (e as Error).message)).finally(() => setTimeout(tick, config.indexIntervalMs).unref());
  tick();
}
export { dbtx };
