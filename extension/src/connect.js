// Wallet connection for the browser extension popup. Deliberately WalletConnect + watch-only ONLY —
// no injected-wallet (window.ethereum) support here. An extension popup is its own isolated page, not
// the web page you're looking at, so there is no "injected provider" to find without a content script
// that reaches into the active tab and relays messages back and forth. That's a real capability some
// wallet-adjacent extensions add, but it means asking for host/activeTab permissions and running code
// in the context of every page the user visits — exactly the kind of surface Chrome Web Store scrutinizes
// hardest for crypto extensions, and not worth it for a v1. WalletConnect (just a relay connection, no
// page access needed) covers the same real use case: sign with a wallet you already control.
import { BrowserProvider, JsonRpcProvider, getAddress, isAddress } from "ethers";
import { contractsFor, reverseOnChain } from "../../packages/core/src/wallet-client.ts";
import { Contract } from "ethers";
import { registrarAbi, erc20Abi } from "../../packages/core/src/abi.ts";
import { store } from "../../web/src/lib.js";
import { loadChain } from "./chain.js";

const WC_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID || "";
export const walletConnectEnabled = () => !!WC_PROJECT_ID;

export const wallet = { mode: null, address: null, chainId: null, provider: null, signer: null, label: "", raw: null, listeners: [] };
const emitChange = () => wallet.listeners.forEach((f) => f());
const CANCEL = () => Object.assign(new Error("Request cancelled"), { code: "CANCELLED" });
export const isConnected = () => !!wallet.address;

// Not used by this extension (no injected-wallet support), but send.js imports it from ./connect.js —
// keep the shape compatible so that shared screen is usable unmodified.
export function discoverWallets() { return Promise.resolve([]); }
export async function connectInjected() { throw new Error("Browser wallet support is not available in the extension popup — use WalletConnect or a watch-only address."); }

let wcProvider = null;
const COMMON_CHAINS = [1, 10, 56, 100, 137, 8453, 42161, 43114, 59144, 81457];

export async function connectWalletConnect(silent = false) {
  if (!WC_PROJECT_ID) { if (silent) return false; throw new Error("Mobile wallet connection is not configured on this build."); }
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const info = await loadChain();
  const optional = [...new Set([info.chain.id, ...COMMON_CHAINS])];
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: optional,
    rpcMap: { [info.chain.id]: info.chain.rpcUrl },
    showQrModal: true,
    metadata: { name: "ADDR Wallet", description: "A wallet for .addr names", url: "https://addrwallet.krl.kr", icons: ["https://addrwallet.krl.kr/icons/icon-512.png"] },
  });
  if (provider.session && !provider.accounts?.length) await provider.disconnect().catch(() => {});
  if (!(provider.session && provider.accounts?.length)) {
    if (silent) { provider.events?.removeAllListeners?.(); return false; }
    try { await provider.connect(); }
    catch (e) { provider.events?.removeAllListeners?.(); throw /rejected|reset/i.test(e.message || "") ? CANCEL() : e; }
  }
  let accounts = provider.accounts;
  if (!accounts?.length) {
    const raw = provider.session?.namespaces?.eip155?.accounts || [];
    if (raw.length) {
      const chainIdStr = raw[0].split(":")[1];
      provider.chainId = Number(chainIdStr);
      provider.accounts = raw.filter((a) => a.startsWith(`eip155:${chainIdStr}:`)).map((a) => a.split(":")[2]);
      accounts = provider.accounts;
    }
  }
  if (!accounts?.length) { if (silent) return false; throw new Error("The wallet connected but didn't share an account — try again and approve the prompt in your wallet app."); }
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
  store.set("ext.walletPref", { mode: "walletconnect" });
  emitChange();
  return true;
}

export async function connectManual(address) {
  if (!isAddress(address)) throw new Error("Enter a valid EVM address (0x...)");
  const info = await loadChain();
  wallet.raw = null;
  wallet.provider = new JsonRpcProvider(info.chain.rpcUrl, info.chain.id, { staticNetwork: true });
  wallet.address = getAddress(address);
  wallet.chainId = info.chain.id;
  wallet.mode = "manual";
  wallet.label = "Watch-only";
  wallet.signer = null;
  store.set("ext.manualAddress", wallet.address);
  store.set("ext.walletPref", { mode: "manual" });
  emitChange();
}

export function disconnect() {
  if (wcProvider && wallet.raw === wcProvider) { const p = wcProvider; wcProvider = null; p.disconnect().catch(() => {}); }
  wallet.mode = null; wallet.address = null; wallet.chainId = null; wallet.provider = null; wallet.signer = null; wallet.raw = null; wallet.label = "";
  emitChange();
}

export async function autoConnect() {
  const pref = store.get("ext.walletPref");
  if (!pref) return false;
  try {
    if (pref.mode === "walletconnect") return await connectWalletConnect(true);
    if (pref.mode === "manual") {
      const addr = store.get("ext.manualAddress", "");
      if (addr && isAddress(addr)) { await connectManual(addr); return true; }
    }
  } catch { /* silent by design */ }
  return false;
}

export async function ensureChain(targetChainId) {
  if (wallet.mode === "manual") return;
  if (wallet.chainId === targetChainId) return;
  const info = await loadChain();
  const hex = "0x" + targetChainId.toString(16);
  try { await wallet.raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if (e.code === 4902 || /Unrecognized chain/i.test(e.message || "")) {
      await wallet.raw.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: info.chain.name, rpcUrls: [info.chain.rpcUrl], nativeCurrency: { name: info.chain.currency, symbol: info.chain.currency, decimals: 18 }, blockExplorerUrls: info.chain.explorer ? [info.chain.explorer] : undefined }] });
    } else throw e;
  }
  wallet.chainId = Number((await wallet.provider.getNetwork()).chainId);
  wallet.signer = await wallet.provider.getSigner();
  if (wallet.chainId !== targetChainId) throw new Error(`Switch your wallet to chain ${targetChainId}`);
}

let readProv = null;
export async function readProvider() {
  const info = await loadChain();
  if (!readProv) readProv = new JsonRpcProvider(info.chain.rpcUrl, info.chain.id, { staticNetwork: true });
  return readProv;
}

export async function registryContracts(write = false) {
  const info = await loadChain();
  const runner = write ? wallet.signer : await readProvider();
  const { registry, resolver } = contractsFor(info, runner);
  return { info, registry, resolver, registrar: new Contract(info.registrar, registrarAbi, runner), erc20: (addr) => new Contract(addr, erc20Abi, runner) };
}

export async function primaryName(address) {
  const info = await loadChain();
  return reverseOnChain(info, await readProvider(), address);
}

export async function requireWallet(openConnectFn) {
  if (isConnected()) return true;
  return openConnectFn();
}
