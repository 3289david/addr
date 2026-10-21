// Wallet layer. Nothing connects automatically: the user chooses a browser wallet (EIP-1193 / EIP-6963 discovery runs
// only when the connect dialog opens) or enters an address manually. In manual mode every transaction is shown as
// copyable fields, the user sends it from any wallet and pastes the hash; we confirm it on-chain.
import { AbstractSigner, BrowserProvider, Contract, JsonRpcProvider, getAddress, isAddress, verifyMessage } from "ethers";
import { registryAbi, resolverAbi, registrarAbi, erc20Abi } from "../../packages/core/src/index.ts";
import { h, mount, modal, btn, icon, copy, copyLine, qr, alert, field, kv, loadChain, store, toast, sleep, short } from "./lib.js";

// Baked in at build time from .env (WALLETCONNECT_PROJECT_ID) by scripts/build-web.cjs. Public by design:
// a WalletConnect project id identifies the dapp to the relay, it is not a secret.
const WC_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || "";
export const walletConnectEnabled = () => !!WC_PROJECT_ID;

export const wallet = { mode: null, address: null, chainId: null, label: "", provider: null, signer: null, listeners: [], raw: null };
const emitChange = () => wallet.listeners.forEach((f) => f());
const CANCEL = () => Object.assign(new Error("Request cancelled"), { code: "CANCELLED" });
// Every major EVM mainnet, so a WalletConnect session can be used on whichever network the user is
// actually on, not just a handful. WalletConnect negotiates this over the encrypted relay after pairing,
// not in the QR code itself, so a long list doesn't make the QR bigger or slower to scan.
const COMMON_CHAINS = [
  1, 10, 25, 56, 100, 137, 146, 169, 196, 204, 250, 288, 324, 1030, 1088, 1101, 1116, 1284, 1285,
  1329, 2222, 5000, 7000, 7700, 8217, 8453, 9001, 13371, 34443, 42161, 42170, 42220, 43114,
  59144, 60808, 81457, 167000, 534352, 7777777,
]; // eth, optimism, cronos, bnb, gnosis, polygon, sonic, manta pacific, x layer, opbnb, fantom, boba,
   // zksync era, conflux espace, metis, polygon zkevm, core, moonbeam, moonriver, sei, kava, mantle,
   // zetachain, canto, kaia, base, evmos, immutable zkevm, mode, arbitrum one, arbitrum nova, celo,
   // avalanche, linea, bob, blast, taiko, scroll, zora

export const isConnected = () => !!wallet.address;
export const canSign = () => wallet.mode === "injected" || wallet.mode === "manual";

// -------------------------------------------------------------- discovery
export function discoverWallets(waitMs = 250) {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (e) => { const d = e.detail; if (d?.info?.uuid) found.set(d.info.uuid, d); };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()].map((d) => ({ id: d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider }));
      if (window.ethereum && !list.some((w) => w.provider === window.ethereum)) {
        list.push({ id: "window.ethereum", name: window.ethereum.isDevWallet ? "Local dev wallet" : window.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: null, provider: window.ethereum });
      }
      resolve(list);
    }, waitMs);
  });
}

// ---------------------------------------------------------------- connect
export async function connectInjected(entry) {
  const eth = entry.provider;
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("The wallet did not share an account");
  wallet.raw = eth;
  wallet.provider = new BrowserProvider(eth, "any");
  wallet.signer = await wallet.provider.getSigner();
  wallet.address = getAddress(await wallet.signer.getAddress());
  wallet.chainId = Number((await wallet.provider.getNetwork()).chainId);
  wallet.mode = "injected";
  wallet.label = entry.name;
  eth.on?.("accountsChanged", (a) => { if (wallet.raw === eth) { if (!a.length) disconnect(); else connectInjected(entry).catch(() => disconnect()); } });
  eth.on?.("chainChanged", () => { if (wallet.raw === eth) connectInjected(entry).catch(() => disconnect()); });
  store.set("walletPref", { mode: "injected", name: entry.name }); // remembered as a hint only; never auto-connects
  emitChange();
}

let wcProvider = null;

/** Connects a mobile wallet app over WalletConnect: shows a QR to scan, or deep-links straight into the
 *  wallet app on a phone. Needs WALLETCONNECT_PROJECT_ID configured at build time (free, cloud.reown.com). */
export async function connectWalletConnect() {
  if (!WC_PROJECT_ID) throw new Error("Mobile wallet connection is not configured on this deployment.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const info = await loadChain();
  const required = COMMON_CHAINS.includes(1) ? 1 : COMMON_CHAINS[0];
  const optional = [...new Set([info.chain.id, ...COMMON_CHAINS])].filter((id) => id !== required);
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [required],
    optionalChains: optional,
    rpcMap: { [info.chain.id]: info.chain.rpcUrl },
    showQrModal: true,
    metadata: { name: "ADDR", description: "Human-readable Web3 names", url: location.origin, icons: [location.origin + "/icon.png"] },
  });
  // Not provider.enable(): internally it skips the real pairing/approval flow whenever a session already
  // exists (incl. a stale one left over from a previous visit) and instead sends a plain eth_requestAccounts
  // RPC call over that session — many wallets approve the WalletConnect session fine but don't implement
  // that follow-up RPC, so enable() can resolve with nothing even though the connection genuinely worked.
  // provider.connect() runs the actual pairing/QR/approval flow and sets provider.accounts directly from
  // the approved session namespaces, which is the reliable source.
  if (provider.session && !provider.accounts?.length) await provider.disconnect().catch(() => {}); // clear a stale, account-less session so a fresh pairing happens
  if (!(provider.session && provider.accounts?.length)) {
    try {
      await provider.connect();
    } catch (e) {
      provider.events?.removeAllListeners?.();
      throw /rejected|reset/i.test(e.message || "") ? CANCEL() : e;
    }
  }
  const accounts = provider.accounts;
  if (!accounts?.length) throw new Error("The wallet connected but didn't share an account — please try again and approve the account/network prompt in your wallet app.");
  wcProvider = provider;
  wallet.raw = provider;
  wallet.provider = new BrowserProvider(provider, "any");
  wallet.address = getAddress(accounts[0]);
  wallet.signer = await wallet.provider.getSigner();
  wallet.chainId = provider.chainId ? Number(provider.chainId) : Number((await wallet.provider.getNetwork()).chainId);
  wallet.mode = "injected";
  wallet.label = "Mobile wallet";
  provider.on("accountsChanged", (a) => { if (wallet.raw === provider) { if (!a.length) disconnect(); else { wallet.address = getAddress(a[0]); emitChange(); } } });
  provider.on("chainChanged", (c) => { if (wallet.raw === provider) { wallet.chainId = Number(c); emitChange(); } });
  provider.on("disconnect", () => { if (wallet.raw === provider) disconnect(); });
  store.set("walletPref", { mode: "walletconnect" }); // remembered as a hint only; never auto-connects
  emitChange();
}

export async function connectManual(address) {
  if (!isAddress(address)) throw new Error("Enter a valid EVM address (0x...)");
  const info = await loadChain();
  wallet.raw = null;
  wallet.provider = new JsonRpcProvider(info.chain.rpcUrl, info.chain.id, { staticNetwork: true });
  wallet.address = getAddress(address);
  wallet.chainId = info.chain.id;
  wallet.mode = "manual";
  wallet.label = "Manual address";
  wallet.signer = new ManualSigner(wallet.address, wallet.provider);
  store.set("manualAddress", wallet.address);
  emitChange();
}

export function disconnect() {
  if (wcProvider && wallet.raw === wcProvider) { const p = wcProvider; wcProvider = null; p.disconnect().catch(() => {}); }
  wallet.mode = null; wallet.address = null; wallet.chainId = null; wallet.provider = null; wallet.signer = null; wallet.raw = null; wallet.label = "";
  emitChange();
}

/** Opens the connection dialog. Resolves true when connected. */
export function openConnect() {
  return new Promise((resolve) => {
    const list = h("div", { class: "stack" }, h("div", { class: "muted" }, "Looking for wallets..."));
    const manualBox = h("div", { class: "hide stack" });
    const manualInput = h("input", { placeholder: "0x... your EVM address", spellcheck: "false", autocomplete: "off", value: store.get("manualAddress", "") });
    const manualErr = h("div", { class: "bad help" });
    const wcBox = h("div", { class: "hide stack" });
    const m = modal({
      title: "Connect a wallet",
      body: h("div", { class: "stack" },
        h("p", { class: "muted", style: "margin:0" }, "Nothing is connected until you pick an option. ADDR never sees your private keys."),
        list,
        walletConnectEnabled()
          ? h("button", { class: "option", type: "button", onclick: () => { wcBox.classList.toggle("hide"); manualBox.classList.add("hide"); } },
              h("span", { class: "ico" }, icon("phone", 22)),
              h("span", null, h("div", { class: "t" }, "Connect with a mobile wallet app"), h("div", { class: "d" }, "Scan a QR code, or tap to open your wallet app directly on your phone.")))
          : h("div", { class: "option", style: "cursor:default;opacity:.6" },
              h("span", { class: "ico" }, icon("phone", 22)),
              h("span", null, h("div", { class: "t" }, "Connect with a mobile wallet app"), h("div", { class: "d" }, "Not configured on this deployment yet."))),
        wcBox,
        h("button", { class: "option", type: "button", onclick: () => { manualBox.classList.toggle("hide"); wcBox.classList.add("hide"); manualInput.focus(); } },
          h("span", { class: "ico" }, icon("key", 22)),
          h("span", null, h("div", { class: "t" }, "Enter address manually"), h("div", { class: "d" }, "Use any wallet or hardware device. Transactions are shown as fields to copy; you send them yourself and paste the hash."))),
        manualBox),
    });
    m.onClose = (v) => resolve(!!v);
    wcBox.append(
      h("ol", { class: "muted", style: "margin:0;padding-left:20px;display:grid;gap:6px;font-size:13.5px" },
        h("li", null, "Install a wallet app that supports WalletConnect, e.g. MetaMask, Trust Wallet, Rainbow or Coinbase Wallet (most do)."),
        h("li", null, "Tap “Show QR code” below. On a computer: open your wallet app, find Scan / WalletConnect, and scan it with your phone. On a phone: pick your wallet from the list that opens — it switches to the app directly, no scanning needed."),
        h("li", null, "Approve the connection request in your wallet app. Nothing is signed or sent yet — connecting only shares your address.")),
      btn("Show QR code", async () => {
        try { await connectWalletConnect(); toast(`Connected to ${wallet.label}`); m.close(true); } catch (e) { if (e.code !== "CANCELLED") toast(e.message, "bad"); }
      }, "block"));
    manualBox.append(field("Your EVM address", manualInput), manualErr,
      alert("info", "Manual mode proves nothing about ownership by itself: reading works for any address, and every change you make is only valid if the wallet that sends it controls this address."),
      btn("Continue", async () => {
        try { await connectManual(manualInput.value.trim()); toast("Connected manually"); m.close(true); } catch (e) { manualErr.textContent = e.message; }
      }));
    discoverWallets().then((wallets) => {
      mount(list, wallets.length
        ? wallets.map((w) => h("button", { class: "option", type: "button", onclick: async () => {
            try { await connectInjected(w); toast(`Connected to ${w.name}`); m.close(true); } catch (e) { toast(e.code === 4001 ? "Request cancelled in your wallet" : e.message, "bad"); }
          } }, h("span", { class: "ico" }, w.icon ? h("img", { src: w.icon, alt: "", width: 26, height: 26, style: "border-radius:6px" }) : icon("wallet", 22)),
          h("span", null, h("div", { class: "t" }, w.name), h("div", { class: "d" }, "Browser wallet (EIP-1193)"))))
        : h("div", { class: "alert info" }, icon("info", 18), h("div", { class: "body" }, "No browser wallet was found in this browser. Install one such as MetaMask or Rabby, or use manual entry below.")));
    });
  });
}

export async function requireWallet() {
  if (isConnected()) return true;
  return openConnect();
}

// ------------------------------------------------------------- manual UX
function validHash(s) { return /^0x[0-9a-fA-F]{64}$/.test(s); }

/** Shows the transaction as fields. Resolves with the pasted transaction hash. Rejects with CANCELLED. */
export function manualTransactionDialog({ from, to, valueWei = 0n, data = "0x", chainId, chainName, summary }) {
  return new Promise((resolve, reject) => {
    const hash = h("input", { placeholder: "0x transaction hash", spellcheck: "false", autocomplete: "off" });
    const err = h("div", { class: "bad help" });
    const eth = valueWei ? Number(valueWei) / 1e18 : 0;
    const uri = !data || data === "0x" ? `ethereum:${to}@${chainId}${valueWei ? `?value=${valueWei}` : ""}` : null;
    let done = false;
    const m = modal({
      title: "Send from your wallet", wide: true, dismissible: true,
      body: h("div", { class: "stack" },
        summary ? alert("info", summary) : null,
        h("ol", { class: "muted", style: "margin:0;padding-left:20px;display:grid;gap:4px" },
          h("li", null, `Open your wallet on ${chainName || "chain " + chainId} (chain id ${chainId}) with the address ${short(from, 6)}.`),
          h("li", null, "Create a transaction with exactly these fields and confirm it."),
          h("li", null, "Paste the transaction hash below.")),
        h("div", { class: "split" },
          h("div", { class: "stack" },
            field("To", copyLine(to)),
            field("Value", copyLine(valueWei ? `${eth} (${valueWei} wei)` : "0")),
            data && data !== "0x" ? field("Data (hex)", h("div", { class: "stack" }, h("textarea", { readonly: true, rows: 4 }, data), btn("Copy data", () => copy(data, "Data copied"), "ghost small"))) : null),
          uri ? h("div", { class: "center stack" }, h("div", { class: "muted help" }, "Or scan with a mobile wallet"), qr(uri)) : null),
        field("Transaction hash", hash), err),
      footer: [btn("Cancel", () => m.close(false), "ghost"), btn("I sent it", async () => {
        const v = hash.value.trim();
        if (!validHash(v)) { err.textContent = "Paste the 66 character transaction hash starting with 0x."; return; }
        done = true; m.close(true); resolve(v);
      })],
    });
    m.onClose = () => { if (!done) reject(CANCEL()); };
  });
}

export function manualSignDialog(address, message) {
  return new Promise((resolve, reject) => {
    const sig = h("input", { placeholder: "0x signature", spellcheck: "false" });
    const err = h("div", { class: "bad help" });
    let done = false;
    const m = modal({
      title: "Sign a message", wide: true,
      body: h("div", { class: "stack" },
        alert("info", "Sign this exact message with the wallet that controls ", h("b", null, short(address, 6)), " using personal_sign (Sign message). It does not send a transaction or cost gas."),
        field("Message", h("div", { class: "stack" }, h("textarea", { readonly: true, rows: 5 }, message), btn("Copy message", () => copy(message, "Message copied"), "ghost small"))),
        field("Signature", sig), err),
      footer: [btn("Cancel", () => m.close(false), "ghost"), btn("Verify signature", async () => {
        try {
          const rec = verifyMessage(message, sig.value.trim());
          if (getAddress(rec) !== getAddress(address)) throw new Error(`That signature is from ${short(rec, 6)}, not ${short(address, 6)}`);
          done = true; m.close(true); resolve(sig.value.trim());
        } catch (e) { err.textContent = e.message; }
      })],
    });
    m.onClose = () => { if (!done) reject(CANCEL()); };
  });
}

class ManualSigner extends AbstractSigner {
  constructor(address, provider) { super(provider); this.address = address; }
  async getAddress() { return this.address; }
  connect(provider) { return new ManualSigner(this.address, provider); }
  async signTransaction() { throw new Error("Manual mode signs in your own wallet; use the transaction dialog"); }
  async signTypedData() { throw new Error("Typed-data signing is not available in manual mode"); }
  async signMessage(message) { return manualSignDialog(this.address, typeof message === "string" ? message : new TextDecoder().decode(message)); }
  async sendTransaction(tx) {
    const info = await loadChain();
    const resolved = { to: tx.to ? (typeof tx.to === "string" ? tx.to : await tx.to.getAddress()) : null, data: tx.data || "0x", value: tx.value ? BigInt(tx.value) : 0n };
    if (!resolved.to) throw new Error("Contract deployment is not supported here");
    const hash = await manualTransactionDialog({ from: this.address, to: getAddress(resolved.to), valueWei: resolved.value, data: resolved.data, chainId: info.chain.id, chainName: info.chain.name, summary: tx._summary });
    // wait until the node knows the transaction, then check it is the one we asked for
    let found = null;
    for (let i = 0; i < 60 && !found; i++) { found = await this.provider.getTransaction(hash).catch(() => null); if (!found) await sleep(2000); }
    if (!found) throw new Error("That transaction was not found on the registry chain yet. Check the hash and the network, then try again.");
    if (getAddress(found.from) !== this.address) throw new Error(`That transaction was sent from ${short(found.from, 6)}, not ${short(this.address, 6)}`);
    if (!found.to || getAddress(found.to) !== getAddress(resolved.to) || found.data.toLowerCase() !== resolved.data.toLowerCase() || found.value !== resolved.value) {
      throw new Error("That transaction does not match the requested one (to, value and data must be identical)");
    }
    return found;
  }
}

// ------------------------------------------------------------- chain/contracts
export async function ensureRegistryChain() {
  const info = await loadChain();
  if (!isConnected()) { if (!(await requireWallet())) throw CANCEL(); }
  if (wallet.mode === "manual") return;
  if (wallet.chainId === info.chain.id) return;
  const hex = "0x" + info.chain.id.toString(16);
  try {
    await wallet.raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902 || /Unrecognized chain/i.test(e.message || "")) {
      await wallet.raw.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: info.chain.name, rpcUrls: [info.chain.rpcUrl], nativeCurrency: { name: info.chain.currency, symbol: info.chain.currency, decimals: 18 }, blockExplorerUrls: info.chain.explorer ? [info.chain.explorer] : undefined }] });
    } else if (!wallet.raw.isDevWallet) throw e;
  }
  const net = await wallet.provider.getNetwork();
  wallet.chainId = Number(net.chainId);
  wallet.signer = await wallet.provider.getSigner();
  if (wallet.chainId !== info.chain.id && !wallet.raw.isDevWallet) throw new Error(`Switch your wallet to ${info.chain.name} (chain ${info.chain.id})`);
}

let readProv = null;
export async function readProvider() {
  const info = await loadChain();
  if (!readProv) readProv = new JsonRpcProvider(info.chain.rpcUrl, info.chain.id, { staticNetwork: true });
  return readProv;
}

/** Contract handles. With a connected wallet they sign (or produce manual dialogs); otherwise read-only. */
export async function contracts(write = true) {
  const info = await loadChain();
  const runner = write ? (await (async () => { await ensureRegistryChain(); return wallet.signer; })()) : await readProvider();
  return {
    info,
    registry: new Contract(info.registry, registryAbi, runner),
    resolver: new Contract(info.resolver, resolverAbi, runner),
    registrar: new Contract(info.registrar, registrarAbi, runner),
    erc20: (addr) => new Contract(addr, erc20Abi, runner),
  };
}

export function explorerTx(info, hash) { return info.chain.explorer ? `${info.chain.explorer}/tx/${hash}` : null; }

/** Plain transfer on an arbitrary EVM chain for the Send page. */
export async function sendEvmTransfer({ chainId, chainName, to, valueWei = 0n, data = "0x", summary }) {
  if (!isConnected() && !(await requireWallet())) throw CANCEL();
  if (wallet.mode === "manual") {
    return manualTransactionDialog({ from: wallet.address, to, valueWei, data, chainId, chainName, summary });
  }
  if (wallet.chainId !== chainId && !wallet.raw.isDevWallet) {
    const hex = "0x" + chainId.toString(16);
    await wallet.raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    wallet.chainId = Number((await wallet.provider.getNetwork()).chainId);
    wallet.signer = await wallet.provider.getSigner();
    if (wallet.chainId !== chainId) throw new Error(`Switch your wallet to ${chainName}`);
  }
  const tx = await wallet.signer.sendTransaction({ to, value: valueWei, data });
  await tx.wait();
  return tx.hash;
}
