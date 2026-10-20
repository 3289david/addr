import { Contract, FallbackProvider, JsonRpcProvider, Wallet, NonceManager } from "ethers";
import { registryAbi, resolverAbi, registrarAbi } from "../packages/core/src/index.ts";
import { config, requireDeployment } from "./config.ts";
import { db, now } from "./db.ts";

const dep = requireDeployment();

const providers = config.rpcUrls.map((u) => new JsonRpcProvider(u, config.chainId, { staticNetwork: true, batchMaxCount: 1 }));
export const provider =
  providers.length > 1
    ? new FallbackProvider(providers.map((p, i) => ({ provider: p, priority: i + 1, weight: 1, stallTimeout: 1500 })), config.chainId, { quorum: 1 })
    : providers[0];

export const registry = new Contract(dep.registry, registryAbi, provider);
export const resolver = new Contract(dep.resolver, resolverAbi, provider);
export const registrar = new Contract(dep.registrar, registrarAbi, provider);

export const operator = config.operatorKey ? new NonceManager(new Wallet(config.operatorKey, provider)) : null;
export const operatorAddress = config.operatorKey ? new Wallet(config.operatorKey).address : null;
export const freeSigner = config.freeSignerKey ? new Wallet(config.freeSignerKey) : null;

/** Serializes all operator transactions so nonces never collide and failures do not skip nonces. */
let chainQueue: Promise<unknown> = Promise.resolve();
export function enqueueTx<T>(fn: () => Promise<T>): Promise<T> {
  const attempt = async () => {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as any)?.code ?? "") + String((e as Error)?.message ?? "");
      // the operator key was used elsewhere (another process/wallet): resync the cached nonce once and retry
      if (operator && /NONCE_EXPIRED|nonce has already been used|nonce too low/i.test(msg)) {
        operator.reset();
        return await fn();
      }
      throw e;
    }
  };
  const run = chainQueue.then(attempt, attempt);
  chainQueue = run.catch(() => undefined);
  return run;
}

export async function probeRpcs(): Promise<{ url: string; ok: boolean; ms: number; block?: number; error?: string }[]> {
  return Promise.all(
    config.rpcUrls.map(async (url, i) => {
      const t = Date.now();
      try {
        const block = await providers[i].getBlockNumber();
        const ms = Date.now() - t;
        db.prepare("INSERT INTO rpc_health (ts, url, ok, ms, block) VALUES (?,?,?,?,?)").run(now(), redact(url), 1, ms, block);
        return { url: redact(url), ok: true, ms, block };
      } catch (e) {
        const ms = Date.now() - t;
        db.prepare("INSERT INTO rpc_health (ts, url, ok, ms, block) VALUES (?,?,?,?,?)").run(now(), redact(url), 0, ms, null);
        return { url: redact(url), ok: false, ms, error: (e as Error).message.slice(0, 120) };
      }
    }),
  );
}

function redact(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}`; // never expose API keys in paths/queries
  } catch {
    return "invalid";
  }
}

export const deployment = dep;

let tsCache = { at: 0, ts: 0 };
/** Timestamp of the latest block (what contracts compare against). Cached for 3s. */
export async function chainNow(fresh = false): Promise<number> {
  if (!fresh && Date.now() - tsCache.at < 3000) return tsCache.ts + Math.floor((Date.now() - tsCache.at) / 1000);
  const b = await provider.getBlock("latest");
  tsCache = { at: Date.now(), ts: b!.timestamp };
  return tsCache.ts;
}
