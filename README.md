# ADDR: human-readable Web3 names

`heelo.addr` resolves to Bitcoin, Litecoin, Ethereum and other EVM chains, TRON and Solana addresses, including
USDT and USDC with explicit network and standard. This repository contains the contracts, the resolver/API server,
payment verification, enterprise issuance, webhooks, a TypeScript SDK, a CLI, a React hook and the web app.

Everything below runs against a real EVM (Hardhat node) and real HTTP/RPC calls. There are no stubbed responses in the tests.
See **Verification status** for exactly what has and has not been exercised.

## Layout

| Path | What |
|---|---|
| `contracts/` | `AddrRegistry` (ownership, expiry, subnames, lock, recovery), `AddrResolver` (multichain records, text, reverse), `AddrRegistrar` (pricing, free tier, commit-reveal, ETH/stablecoin payment, operator path), `AddrTimelock` |
| `packages/core` | Name rules, namehash, chain/asset registry, address codecs and validators (base58check, bech32/bech32m, EIP-55, TRON, Solana), pricing, look-alike detection, payment URIs |
| `packages/sdk` | `Addr` REST client, `AddrChainResolver` (no ADDR server needed), `verifyWebhook`, React hook |
| `packages/cli` | `addr` command line |
| `server/` | REST API, chain indexer, payment verification (EVM, BTC, LTC, TRON, Solana), enterprise API, webhooks, rate limiting |
| `web/` | Web app (path routes: `/`, `/names`, `/send`, `/name/<x.addr>`, `/dev`, `/enterprise`, `/admin`, `/invoice/<id>`, `/login`): search/register, manage names, send by name, request links, profiles, developer console, enterprise console, admin, light/dark themes |
| `docs/` | Specification, integration guide, OpenAPI, test vectors |

## Quick start (local chain)

```bash
npm install
npm run node                 # terminal 1: local EVM at http://127.0.0.1:8545
npm run deploy:local         # terminal 2: deploys contracts, writes deployments/31337.json
cp .env.example .env         # local dev keys only
npm run build:web:dev        # web app incl. local dev wallet (?devwallet=N)
npm start                    # API + web at http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787/?devwallet=2`. The dev wallet is an EIP-1193 shim that forwards to the local node's unlocked
accounts and only exists in the `--dev` build. With a real browser wallet (MetaMask, Rabby) connect normally.

Tests:

```bash
npm run test:contracts       # 26 contract tests + OpenAPI coverage (hardhat, in-process EVM)
npm run test:core            # codecs/validation against BIP-173/350 vectors, pricing, look-alikes
npm run test:e2e             # needs the local node + deployment: real server process, signed txs, webhooks, payments
npm run test:sdk             # SDK, on-chain resolver and CLI against the real server and chain
npm run test:auth            # email sign-in: real SMTP delivery (STARTTLS) to a real SMTP sink, DKIM verification, sessions, CSRF, keys, retries
node --no-warnings scripts/verify-live-parsers.ts   # BTC/TRON/Solana verifiers against live mainnet data, read-only
```

## Production deployment

1. Deploy to a real EVM chain (Base is a reasonable first target): set `RPC_URL`, `DEPLOYER_KEY`, `TREASURY`, `ADMIN_MULTISIG`, `FREE_SIGNER`,
   `PAYMENT_OPERATOR`, `USDC_ADDRESS` (+ optional `USDT_ADDRESS`), `ETH_USD_FEED` (a Chainlink ETH/USD aggregator on that chain) and run
   `npx hardhat run scripts/deploy.cjs --network custom`. Live deployments never deploy test tokens or feeds.
   Ownership of registry and registrar moves to `AddrTimelock`; the script prints the `schedule`/`execute` calls the multisig must perform to accept it.
2. Use **separate keys** for `FREE_SIGNER_KEY` (signs free-claim vouchers) and `OPERATOR_KEY` (registers names paid in other coins, issues subnames as relayer). Neither can move or edit users' live names. Fund the operator with gas only.
3. Server env (see `.env.example`): `CHAIN_ID`, `RPC_URLS` (comma-separated for failover; use at least two providers), `ADMIN_TOKEN`, `TRUST_PROXY=1` behind a reverse proxy, `PUBLIC_RPC_URL`, `CHAIN_EXPLORER`.
4. Coin payments: set `TREASURY_BITCOIN`, `TREASURY_LITECOIN`, `TREASURY_TRON`, `TREASURY_SOLANA`, `TREASURY_<EVM NETWORK>` plus `EVM_RPC_<NETWORK>`. A network is payable only when its receiving address is configured. Optional: `TRON_API_KEY`, `SOLANA_RPC`, `BTC_API`, `LTC_API`, `PRICE_API`.
5. Serve behind TLS. Build the web app without `--dev`: `npm run build:web`.
6. Before mainnet: independent contract audit (not done), verify token contract addresses in `packages/core/src/chains.ts` against the issuers' official lists, and set realistic `MINCONF_*`.

## Email (self-hosted, no mail API)

The server contains its own SMTP client, DKIM signer (RSA-SHA256, relaxed/relaxed) and a persistent retry queue. By default it looks up the recipient's MX records and delivers directly (STARTTLS when offered), the way a normal mail server does.

```bash
node scripts/mail-keys.cjs yourdomain.com     # writes the DKIM key, prints the DNS records to publish
```

Set `MAIL_FROM="ADDR <login@yourdomain.com>"`, `DKIM_KEY_FILE`, `DKIM_SELECTOR`, `MAIL_HELO`, publish SPF, DKIM and DMARC, and give the server IP a matching PTR record. Outbound port 25 must be open; many cloud providers block it by default. If yours does, use your own or your host's SMTP relay: `MAIL_TRANSPORT=relay` with `SMTP_HOST/PORT/USER/PASS` (still no HTTP mail API). For local development `MAIL_TRANSPORT=file` writes messages to `data/outbox/*.eml`. The admin console (Email tab) shows the outbox and checks your SPF/DKIM/DMARC DNS records. Temporary failures (4xx, network) retry with backoff for a day; permanent failures (5xx) are recorded.

## How payments work

* **On the registry chain**: one transaction pays ETH (oracle priced) or a whitelisted stablecoin and registers atomically. There is no paid-but-unregistered state.
* **Other coins**: `POST /v1/invoices` quotes the USD price in the chosen coin from live rates and adds a small unique amount so each open invoice has a distinct exact amount. The payer sends exactly that amount; `POST /v1/invoices/{id}/payment` with the txid makes the server read the transaction from that network and check recipient, asset and exact amount, wait for confirmations, then the operator registers the name on-chain with the payment reference (single use). Underpayments are not credited; overpayments and late payments go to `needs_review` for manual refund; if the name is taken meanwhile the invoice ends `registration_failed` (refund, not retry).

## Free tier

`one 5+ character name per wallet` is enforced on-chain (`freeClaimed[owner]`). The server additionally issues the required EIP-712 voucher only after per-IP and per-wallet rate limits. A wallet is not a person; creating many wallets is possible. The limits make it costly at scale, not impossible.

## Verification status (honest)

Verified by automated tests in this repo:

* Contracts: registration, pricing tiers, free tier, voucher check, commit-reveal, ETH and ERC20 payment, expiry/grace/renewal, clean slate on re-registration, records validation, reverse records, transfer, lock, guardian recovery, subnames with atomic provisioning, operator caps, two-step admin.
* API against a real chain: resolution of BTC/LTC/ETH/Base fallback/TRON/Solana records, USDT network enforcement, expiry blocking, indexer history/search/reverse, API keys and quotas, enterprise claim by signature, relayer issuance, tenant isolation, idempotency, signed webhook delivery to a real HTTP receiver, admin auth, ETH and ERC20 invoices (underpaid, wrong recipient, exact payment, txid reuse) settling into real registrations.
* Email sign-in end to end: the server's SMTP client delivers over STARTTLS to a real SMTP receiver, the DKIM signature is verified by an independent verifier, codes and links work once, wrong-code lockout, rate limits, sessions, CSRF, key lifecycle, retry/permanent-failure queue behavior.
* Web app driven in a browser against the local chain: email sign-in gate on `/dev`, API key creation, manual wallet connect with the full copy-and-paste transaction flow (commit and register a free name), record editing with live validation, resolving and sending 0.5 ETH by name, mobile layout.
* Payment verifiers for Bitcoin, TRON (USDT-TRC20) and Solana (native SOL) read real mainnet transactions correctly (`verify-live-parsers`, read-only).

Not verified, needs your action:

* No end-to-end purchase was made with real BTC, LTC, TRX or SOL (requires funded wallets and a treasury address of yours). The Litecoin verifier shares the Bitcoin (esplora) code but was not run against a Litecoin transaction, and the Solana SPL-token (USDT/USDC) branch was not run on a live transaction.
* No deployment to a public network was performed; the deployment script's live path (timelock handoff via multisig) is untested.
* Wallet integrations: MetaMask/Rabby work through the standard injected provider; WalletConnect is not wired. Solana wallets and Bitcoin wallets are not driven directly from the browser: the app shows the address, payment link and QR for those networks. TronLink works if `tronWeb` is injected (untested here).
* Contracts have not been externally audited.
* Third-party wallets will not recognise `.addr` until they integrate resolution. That is a business/engineering effort outside this repository.

## Limits and design notes

* Names are ASCII-only to remove Unicode homoglyphs; visual look-alikes (`paypa1`) are flagged, not blocked.
* The index (SQLite) is used for search and history. Resolution reads the chain every time.
* Webhook URLs must be https and must not resolve to private addresses (checked at creation and each delivery); DNS-rebinding between check and connect is not fully eliminated.
* Invoices reserve a name only softly (an on-chain registration by someone else wins and the invoice is refunded).
