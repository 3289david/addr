// Same pattern as walletapp/src/chain.js: baked in at build time, no backend ever involved.
export const chain = (() => {
  try { return JSON.parse(process.env.CHAIN_FALLBACK || "null"); }
  catch { return null; }
})();

export async function loadChain() {
  if (!chain) throw new Error("No chain configuration was baked into this build.");
  return chain;
}
