# ADDR Protocol Specification, version 1

ADDR is an open naming protocol: human-readable `.addr` names that resolve to addresses on many blockchains.
This document is normative for implementers of resolvers, wallets and SDKs. The reference implementation lives in
this repository (`contracts/`, `packages/core`, `server/`).

Three things are deliberately separate and each needs its own implementation:

1. **Registration**: who owns `heelo.addr` and until when (on-chain, `AddrRegistry` + `AddrRegistrar`).
2. **Resolution**: turning a name into a network-specific address (on-chain records read through `AddrResolver`, or the REST API which only caches/indexes).
3. **Wallet integration**: a wallet must actually call a resolver. Registering a name does not make any wallet recognize it, and `.addr` is not a DNS TLD, so browsers do not resolve it either. Use the lookup web app, the SDK, or integrate resolution into your wallet send screen.

## 1. Names

* A name is a dot-separated sequence of labels ending in the label `addr`: `heelo.addr`, `shop.heelo.addr`.
* A label is 1 to 63 ASCII characters from `a-z`, `0-9` and `-`. A hyphen may not start or end a label, and `--` is not allowed anywhere. No Unicode: this removes homoglyph attacks at the character level.
* **Normalization** (client side, before hashing): trim, lowercase. Anything that is still not valid is rejected; it is never silently rewritten. The contracts enforce the same rule independently, so a client bug cannot register an unnormalized name.
* Depth: `label.addr` is depth 1. Subnames go to depth 4.
* **Namehash** is the ENS algorithm: `node("") = 0x00..00`, `node(label.parent) = keccak256(node(parent) ++ keccak256(label))`. `node("addr")` is `0x` + the value in `docs/test-vectors.json`. Test vectors for names are provided.

## 2. Ownership and lifecycle

State of a second-level name (`AddrRegistry.statusOf`): `0` unregistered, `1` active, `2` grace, `3` expired-and-available.

* Registration lasts 1 to 5 years in whole years; total remaining term can never exceed 5 years.
* After expiry there is a **30 day grace period**. During grace the name cannot be resolved or used for sending (records are hidden) and cannot be re-registered by others. Anyone may renew it (the owner is unchanged). After grace it becomes available. A re-registered name starts with a **clean slate**: records, text, subnames and approvals of the previous registration are invisible (generation counters).
* Only a registry *controller* (the registrar contract) can create or extend second-level names, and only if the name is available. No administrator function can reassign, seize or edit a live name. Administration of prices and reserved lists runs through a timelock; every action is announced on-chain (`CallScheduled`) before it can execute.
* Owner actions: `transfer`, `setResolver`, `approveName` (per-name operator that can edit records and create subnames but never transfer), `setApprovalForAll`, `lock(until)` (blocks transfers; can be extended, never shortened; max 4 years ahead), guardian recovery.
* **Recovery** is opt-in. If the owner sets a guardian with a delay of at least 3 days, the guardian can start a recovery that completes only after the delay and can be cancelled by the current owner at any time. There is no automatic recovery.
* **Subnames**: created by the parent's owner or an approved operator in one call, optionally provisioning records atomically. A subname is owned by the address given at creation, not by the creator. A subname lives only while its parent is active and the parent's registration generation is unchanged. The subname owner can call `burnParentControl` to make the subname sovereign (the parent can no longer remove it). Subnames can always be transferred by their owner (migration to an independent name is: register `alice.addr`, then copy records).

## 3. Records

Records are stored per `(node, coinType)` as raw bytes in `AddrResolver`:

| Network | coinType | Stored bytes |
|---|---|---|
| Bitcoin | 0 | scriptPubKey (P2PKH `76a914..88ac`, P2SH `a914..87`, P2WPKH `0014..`, P2WSH `0020..`, P2TR `5120..`) |
| Litecoin | 2 | same script forms (LTC address versions 0x30 / 0x32, hrp `ltc`) |
| Ethereum | 60 | 20 byte address |
| EVM chain *c* | `0x80000000 | c` (ENSIP-11) | 20 byte address |
| TRON | 195 | 21 bytes: `0x41` + 20 byte hash |
| Solana | 501 | 32 byte public key |

This follows ENSIP-9 (multi-coin address records) and ENSIP-11 (EVM chain coin types), so existing tooling that understands those can read ADDR records. For cross-chain account identifiers CAIP-10 can be derived as `namespace:reference:address` (`eip155:8453:0x..`, `bip122:000000000019d6689c085ae165831e93:bc1..`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:..`).

Contract-level validation rejects malformed lengths and script patterns for these coin types. Other coin types are stored if 128 bytes or less and are not interpreted by the reference stack ("not supported" is returned explicitly, never guessed).

Every write records `updatedAt`, `updatedBlock` and a per-coin `version`, and emits `AddrChanged`. `clearRecords(node)` invalidates all records in O(1). Writes are allowed only for an *active* name and an authorised sender. Text records (`display`, `avatar`, `description`, `url`, ...) are plain strings of up to 1024 bytes.

### Tokens and networks

An address record is per **network**, not per token. `USDT` and `USDC` exist on many networks; a resolver MUST NOT return an address for a multi-network token without an explicit network, and SHOULD require the token standard (`TRC20`, `ERC20`, `BEP20`, `SPL`). A TRON address receives TRX, USDT-TRC20 and USDC-TRC20; the response reports the contract. Resolution on an EVM network with no network-specific record falls back to the Ethereum (coin 60) record and the response MUST flag `source: "fallback-ethereum"` with a warning, because smart-contract wallets do not necessarily control the same address on other chains.

## 4. Reverse records

`setPrimaryName(name)` is called by the account itself. The resolver accepts it only when the name is active and either owned by the caller or its ETH record equals the caller. `reverse(address)` re-verifies this at read time and returns nothing otherwise, so transferring or expiring a name instantly invalidates reverse records. Never convert an address to a name without this check.

## 5. Resolution response (REST)

```
GET /v1/names/{name}/resolve?network=tron&asset=USDT&standard=TRC20
{
  "name": "heelo.addr", "node": "0x..", "network": "tron", "coinType": 195,
  "asset": "USDT", "standard": "TRC20", "tokenContract": "TR7NHqje...",
  "address": "T...", "verified": true, "addressFormat": "base58check-T",
  "source": "record", "updatedAt": 1700000000, "updatedBlock": 123, "version": 2,
  "recentlyChanged": false
}
```

`verified: true` means exactly: the record was read from the registry/resolver of an **active** name and the address passed format, checksum and network validation. It does **not** say the address belongs to the person you think, nor that it can receive funds. Clients should additionally (a) show name, network, asset and address together, (b) warn when `recentlyChanged` (changed in the last 24 h), when `source` is a fallback, or when the address differs from one the user saw before, and (c) block sending when the name is not active.

### Error codes

`invalid_name` 400, `name_not_registered` 404, `name_expired` 410 (grace or expired), `network_required` 422, `network_unknown` 404, `network_unsupported` 501, `unsupported_asset` 422, `record_not_set` 404, `record_invalid` 502, `invalid_address` 422, `rate_limited` 429, `quota_exceeded` 429. All errors have the shape `{ "error": { "code", "message" } }`.

## 6. Trust-minimized verification

The REST API is an index and convenience layer. For wallets: call the contracts directly. `AddrChainResolver` in `packages/sdk` does exactly: `registry.statusOf(node)` must be `1`, then `resolver.addr(node, coinType)`, decode with the codec in `packages/core`, validate. Use more than one RPC provider for critical flows. ADDR's database is never the source of truth for ownership.

## 7. Registration economics (reference deployment)

All prices are per year, USD, and stored on-chain (`AddrRegistrar.tiers`, `premiumUsd`), publicly readable:

* 5+ characters: **one free name per wallet** (1 year, renewals free). Additional 5+ names $5.
* 4 characters $15, 3 characters $50, 2 characters $200, 1 character closed.
* Premium names may carry an individual price. Renewal price equals registration price.
* Payment: ETH (via a Chainlink-style ETH/USD feed, 1 day staleness limit) or whitelisted stablecoins on the registry chain, atomically in the registration transaction. Other coins (BTC, LTC, SOL, TRX, USDT on other networks) go through invoices: the server verifies the payment on that network and an *operator* key mints the name (rate-capped per day, one use per payment reference, cannot touch reserved or taken names).
* Registration uses **commit-reveal** (min age 60 s, max 24 h) against front-running.
* The free tier is limited per owner address on-chain and, when a free signer is configured, requires a short-lived EIP-712 voucher issued after API rate limits (per IP, per wallet). A wallet address does not identify a person; operators should treat the free tier as best-effort anti-abuse, not proof of uniqueness.

## 8. Security considerations

* Look-alike names: ASCII-only labels prevent Unicode homoglyphs. Visual confusion (`paypa1` vs `paypal`, `rn` vs `m`) is detected by the search API (`lookalikes`) and shown in the registration UI. Show the full name and address on every send confirmation.
* Address change fraud: expose change time and version, warn within 24 h, and diff against a user's address book.
* Network mismatch: compare the wallet's active chain with the record's network and refuse silently-wrong sends.
* Admin powers: owner of registry/registrar is a timelock. Prices and reserved names change with notice; ownership of existing names cannot be changed by anyone but the owner (or a guardian the owner chose).
* Privacy: names and records are public on-chain; registration requires no personal data. The API keeps per-day salted IP hashes for rate limiting only.
* Keys: no ADDR server ever receives user private keys or seed phrases. The only server-held keys are the protocol's own roles (free-claim signer, payment operator / relayer) and they cannot move user names.

## 9. Compatibility strategy

1. Web app resolves names and sends from a connected wallet.
2. REST API and SDKs let any app resolve.
3. Wallet and exchange integrations call the contracts or SDK in their send/deposit screens.
4. This specification plus `docs/test-vectors.json` allow independent implementations.

An integrator checklist is in `docs/integration-guide.md`.
