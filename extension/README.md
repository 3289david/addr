# ADDR Wallet — browser extension

A popup that resolves and sends to `.addr` human-readable names, and shows balances for a connected
address. Single purpose: `.addr` name resolution and sending, same as the web app at
https://addrwallet.krl.kr.

## Privacy / data handling

- No analytics, no tracking, no remote logging of any kind.
- `storage` permission is used only to remember your last-connected-wallet preference and (in
  watch-only mode) the address you entered — both stored locally in the extension's own storage,
  never transmitted anywhere.
- All chain reads go directly from your browser to public RPC nodes (e.g. `mainnet.base.org`) and, for
  WalletConnect, to WalletConnect's own relay network to reach your wallet app. Nothing goes through an
  ADDR-operated server.
- This extension never has access to a private key. It either relays signing requests to a wallet you
  already control over WalletConnect, or runs in watch-only mode (read-only, cannot send).
- Full legal terms/privacy policy (shared with the main site): https://addr.krl.kr/legal/terms and
  https://addr.krl.kr/legal/privacy.

## Permissions requested (and why that's the complete list)

- `storage` — remember a wallet preference locally. That's all.
- No `host_permissions`, no `activeTab`, no `scripting`. This extension does not read or modify the
  content of any web page you visit — it only has its own popup page.

## Manifest V3 / store-policy notes

- No remotely hosted code: everything is bundled at build time (`npm run build:extension`) into a
  single `popup.js`; nothing is fetched and `eval`'d at runtime.
- `content_security_policy.extension_pages` is the MV3 default-strict policy (`script-src 'self'`), not
  loosened.
- Verified end-to-end in a real loaded (unpacked) MV3 extension context, not just a plain web page —
  confirms the stricter extension-page CSP doesn't break WalletConnect or any on-chain read.

## Build

```
npm run build:extension
```

Output: `extension/dist/` — load via `chrome://extensions` → Developer mode → "Load unpacked".
