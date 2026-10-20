// Development-only EIP-1193 wallet for a LOCAL hardhat node (chain 31337). Not bundled into production builds
// unless explicitly enabled. It forwards every call to the node's JSON-RPC, so transactions are signed by the
// node's unlocked dev accounts and mined on the real local chain. Select an account with ?devwallet=<index>.
(function () {
  const params = new URLSearchParams(location.search);
  if (!params.has("devwallet") || window.ethereum) return;
  const idx = Number(params.get("devwallet")) || 0;
  const RPC = params.get("rpc") || "http://127.0.0.1:8545";
  let id = 1;
  async function rpc(method, p) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: p || [] }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const listeners = {};
  window.ethereum = {
    isDevWallet: true,
    async request({ method, params: p }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [(await rpc("eth_accounts"))[idx]];
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "personal_sign") { return rpc("personal_sign", p); }
      return rpc(method, p);
    },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener() {},
  };
})();
