#!/usr/bin/env node
import { Addr, AddrChainResolver, validateAddress } from "../sdk/src/index.ts";

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const pos: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? "1" : args[++i];
  else pos.push(args[i]);
}
const client = new Addr({ baseUrl: flags.api ?? process.env.ADDR_API ?? "http://127.0.0.1:8787", apiKey: flags.key ?? process.env.ADDR_API_KEY });
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const HELP = `addr <command>
  resolve <name> --network <id> [--asset USDT --standard TRC20]   resolve via API
  resolve-onchain <name> --network <id> --rpc <url> --registry <addr> --resolver <addr>   no ADDR server involved
  info <name>            registration state, owner, expiry
  records <name>         all chain records + profile
  history <name>         indexed change history
  reverse <address>      verified primary name for an address
  search <text>          availability, price, lookalikes
  validate <network> <address>
  networks | pricing | health
  env: ADDR_API (default http://127.0.0.1:8787), ADDR_API_KEY`;

async function main() {
  const [cmd, a, b] = pos;
  switch (cmd) {
    case "resolve": return out(await client.resolve(a, { network: flags.network, asset: flags.asset, standard: flags.standard }));
    case "resolve-onchain": {
      const c = await client.contracts().catch(() => null);
      const r = new AddrChainResolver(flags.rpc ?? "http://127.0.0.1:8545", { registry: flags.registry ?? c?.registry, resolver: flags.resolver ?? c?.resolver });
      return out(await r.resolve(a, { network: flags.network, asset: flags.asset, standard: flags.standard }));
    }
    case "info": return out(await client.name(a));
    case "records": return out(await client.records(a));
    case "history": return out(await client.history(a));
    case "reverse": return out(await client.reverse(a));
    case "search": return out(await client.search(a));
    case "validate": return out(validateAddress(a, b));
    case "networks": return out(await client.networks());
    case "pricing": return out(await client.pricing());
    case "health": return out(await client.health());
    default: console.log(HELP); process.exitCode = cmd ? 1 : 0;
  }
}
main().catch((e) => { console.error(`error [${e.code ?? "unknown"}]: ${e.message}`); process.exitCode = 1; });
