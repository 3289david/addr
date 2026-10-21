# Integration guide

## Wallets and apps (resolve names in a send screen)

**No ADDR API call and no `@addr/sdk` install is required for this.** Resolving a `.addr` name is a
read-only call against two public contracts over any RPC node you already have for the chain — the
same trust model as resolving an ENS name, and (not a coincidence) the exact same `namehash` algorithm
(EIP-137) and the same multicoin `addr(bytes32,uint256)` interface shape (ENSIP-9/11). If you already
have ENS resolution code, you can likely reuse it almost as-is — just point it at the addresses below
instead of the ENS registry.

1. Detect input ending in `.addr`; normalize (trim, lowercase) and reject invalid labels (`[a-z0-9-]`,
   1-63 chars, no leading/trailing/double hyphen).
2. Ask the user for the **network and asset** (or take it from the current send context). Never resolve
   USDT/USDC without a network and standard — the same name can hold a different address per network.
3. Resolve directly on-chain (below) — no API key, no package install, no ADDR dependency at runtime.
4. Show: name, network, asset+standard, full address, last-changed time. Warn if the address differs
   from one the user used before, or changed very recently. Block if the name is not active (expired/
   available names must not resolve).
5. The user's wallet signs and submits the transaction, from your own code, the normal way. Resolution
   never moves funds and never needs to.

### Minimal reference implementation (plain ethers, zero ADDR dependencies)

Base mainnet (chain id `8453`) addresses — same ones published in this repo's
[`packages/core/src/abi.ts`](../packages/core/src/abi.ts) and shown on the live site's `/admin` page,
so you never have to trust this doc alone:

```ts
const REGISTRY = "0x2FDeE277BE3fAeCa14140617A90a71d8A903c78E";
const RESOLVER = "0xB2fAe34A4D9B5F08C67D37a9b9c3f53d3ce77a19";
const RPC_URL  = "https://mainnet.base.org"; // any Base RPC works, this is just a free public one

import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes, getBytes, concat, hexlify } from "ethers";

// EIP-137 namehash, unmodified from ENS. Works for any ".addr" name because the algorithm
// doesn't know or care what the TLD string is.
function namehash(name: string): string {
  let node = "0x" + "00".repeat(32);
  for (const label of name.toLowerCase().split(".").reverse()) {
    const labelHash = keccak256(toUtf8Bytes(label));
    node = keccak256(concat([getBytes(node), getBytes(labelHash)]));
  }
  return hexlify(node);
}

const provider = new JsonRpcProvider(RPC_URL);
const registry = new Contract(REGISTRY, [
  "function statusOf(bytes32 node) view returns (uint8)", // 0 available, 1 active, 2 grace, 3 expired
], provider);
const resolver = new Contract(RESOLVER, [
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)", // ENSIP-9/11 shape
], provider);

async function resolveAddrName(name: string, coinType: number) {
  const node = namehash(name);
  const status = Number(await registry.statusOf(node));
  if (status !== 1) throw new Error(`${name} is not active (status ${status})`);
  const raw = await resolver["addr(bytes32,uint256)"](node, coinType); // "0x" if unset
  if (raw === "0x") throw new Error(`${name} has no record for coin type ${coinType}`);
  return raw; // decode per coinType the same way you already decode any other multicoin ENS record
}
```

`coinType` follows [SLIP-44](https://github.com/satoshilabs/slips/blob/master/slip-0044.md) /
ENSIP-11 (60 = Ethereum/EVM default, 0 = Bitcoin, 2 = Litecoin, 195 = TRON, 501 = Solana, ...) — the
same table you already use for ENS multicoin records.

### If you'd rather use the published package anyway

Same logic, already written, with network/asset lookup and address decoding/validation baked in:

```ts
import { AddrChainResolver } from "@addr/sdk"; // thin wrapper around the exact calls above — read its
const chain = new AddrChainResolver("https://rpc.example", { registry, resolver }); // source, nothing hosted
await chain.resolve("heelo.addr", { network: "bitcoin" });
```

### Hosted alternative (optional convenience, never required)

`GET /v1/names/{name}/resolve?network=..&asset=..&standard=..` does the same on-chain reads server-side
and adds nicer error messages, recently-changed warnings and network/asset-name validation. Use it if
convenient; nothing above requires it.

React: `import { useAddrResolve } from "@addr/sdk/react"`.

## Exchanges and custodians (deposit screens)

Accept `.addr` as a withdrawal destination for the selected network. Pin the resolved address into the withdrawal record at submission time, and apply your normal address-whitelisting and delay policy to the *resolved* address: a name that changes behind a whitelist must be treated as a new address.

## Platforms issuing names to their customers (Enterprise API)

1. Register a parent name you control (for example `acme.addr`).
2. Claim it for your tenant: `GET /v1/enterprise/claim-message?name=acme.addr`, sign the message with the owner wallet, `POST /v1/enterprise/namespaces`.
3. From the owner wallet call `registry.approveName(node, relayer, true)`. The relayer can create subnames under that single name; it can never transfer the parent name or touch customer subnames.
4. Issue: `POST /v1/enterprise/subnames` with `{ namespace, label, customerId, owner, records }`. The customer wallet becomes the on-chain owner and the deposit addresses are written in the same transaction. Send an `Idempotency-Key` header on every write.
5. To let your platform keep managing records, the customer approves the relayer for their subname (`approveName`); without that consent `PATCH` returns `customer_consent_required`.
6. Customers can call `burnParentControl` to become sovereign and can always transfer their subname out. Plan for this in your terms: your customer owns the name.
7. Webhooks (`subname.created`, `record.changed`, `name.transferred`, `invoice.paid`, ...) are HMAC-signed; verify with `verifyWebhook` from the SDK. Deliveries retry with backoff and can be replayed.
8. Deposit **detection** (watching balances, crediting users) stays in your own wallet infrastructure. ADDR stores the mapping name to address; it does not watch deposits.

Global names (`alice.addr`) for customers: `POST /v1/enterprise/names` returns either a free-claim voucher (customer signs the registration; the name belongs to them from the first block) or a payable invoice.

## Webhook verification

```ts
import { verifyWebhook } from "@addr/sdk";
// raw body string, header "x-addr-signature", your webhook secret
const event = await verifyWebhook(rawBody, req.headers["x-addr-signature"], secret);
```

Treat events as at-least-once: de-duplicate on `event.id`.

## Conformance

Run your codec against `docs/test-vectors.json` (names, namehashes, address encodings and invalid cases).
