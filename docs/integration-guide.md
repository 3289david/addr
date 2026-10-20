# Integration guide

## Wallets and apps (resolve names in a send screen)

1. Detect input ending in `.addr`; normalize (trim, lowercase) and reject invalid names.
2. Ask the user for the **network and asset** (or take it from the current send context). Never resolve USDT/USDC without a network and standard.
3. Resolve:
   * trust-minimized: `AddrChainResolver` (reads `AddrRegistry` and `AddrResolver` over your RPC), or any ENSIP-9/11 capable client pointed at the AddrResolver address; or
   * hosted: `GET /v1/names/{name}/resolve?network=..&asset=..&standard=..`.
4. Show: name, network, asset+standard, full address, last-changed time. Warn on `recentlyChanged`, `source: fallback-ethereum`, or address different from the last one the user used. Block if the name is not `active`.
5. The user's wallet signs and submits the transaction. Resolution never moves funds.

```ts
import { Addr, AddrChainResolver } from "@addr/sdk";
const api = new Addr({ baseUrl: "https://api.example", apiKey });
const r = await api.resolve("heelo.addr", { network: "solana", asset: "USDC", standard: "SPL" });

const chain = new AddrChainResolver("https://rpc.example", { registry, resolver });
await chain.resolve("heelo.addr", { network: "bitcoin" });
```

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
