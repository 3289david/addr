// This app never calls the ADDR backend — ever, by design. Its only source of truth is the chain
// itself, reached over a public RPC, using contract addresses baked in at build time (see
// scripts/build-walletapp.cjs) from deployments/<chainId>.json. No fetch("/v1/...") exists anywhere
// in this app.
export const chain = (() => {
  try { return JSON.parse(process.env.CHAIN_FALLBACK || "null"); }
  catch { return null; }
})();

export async function loadChain() {
  if (!chain) throw new Error("No chain configuration was baked into this build.");
  return chain;
}
