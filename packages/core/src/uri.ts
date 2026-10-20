import type { Asset, Network } from "./chains.ts";

/** Decimal string "1.5" + decimals -> base-unit bigint. Rejects excess precision. */
export function parseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("invalid amount");
  const [i, f = ""] = amount.split(".");
  if (f.length > decimals) throw new Error("too many decimal places");
  return BigInt(i + f.padEnd(decimals, "0"));
}

export function formatUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/**
 * Wallet payment-request URI for a resolved address.
 *  - BTC/LTC: BIP-21        - EVM: EIP-681        - Solana: Solana Pay        - TRON: tron: scheme (wallet dependent)
 */
export function paymentUri(net: Network, asset: Asset, address: string, amount?: string): string {
  const native = asset.standard === "native";
  switch (net.family) {
    case "btc":
      return `bitcoin:${address}${amount ? `?amount=${amount}` : ""}`;
    case "ltc":
      return `litecoin:${address}${amount ? `?amount=${amount}` : ""}`;
    case "evm": {
      if (native) {
        const v = amount ? `?value=${parseUnits(amount, asset.decimals)}` : "";
        return `ethereum:${address}@${net.chainId}${v}`;
      }
      const q = new URLSearchParams({ address });
      if (amount) q.set("uint256", parseUnits(amount, asset.decimals).toString());
      return `ethereum:${asset.contract}@${net.chainId}/transfer?${q}`;
    }
    case "solana": {
      const q = new URLSearchParams();
      if (amount) q.set("amount", amount);
      if (!native && asset.contract) q.set("spl-token", asset.contract);
      const qs = q.toString();
      return `solana:${address}${qs ? `?${qs}` : ""}`;
    }
    case "tron": {
      const q = new URLSearchParams();
      if (amount) q.set("amount", amount);
      if (!native && asset.contract) q.set("token", asset.contract);
      const qs = q.toString();
      return `tron:${address}${qs ? `?${qs}` : ""}`;
    }
  }
}
