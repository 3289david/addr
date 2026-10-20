// Public pricing policy (mirrors the on-chain tier table). Amounts are micro-USD (1e6) per year.

export interface PriceQuote {
  label: string;
  length: number;
  years: number;
  usdPerYearMicro: number;
  totalUsdMicro: number;
  free: boolean;
  available: boolean;
  reason?: string;
}

export const DEFAULT_TIERS: Record<number, { priceUsdMicro: number; enabled: boolean }> = {
  1: { priceUsdMicro: 0, enabled: false },
  2: { priceUsdMicro: 200_000_000, enabled: true },
  3: { priceUsdMicro: 50_000_000, enabled: true },
  4: { priceUsdMicro: 15_000_000, enabled: true },
  5: { priceUsdMicro: 5_000_000, enabled: true }, // additional (non-free) names of 5+ chars
};

export function usd(micro: number): string {
  return (micro / 1e6).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function quote(
  label: string, years: number, freeAlreadyClaimed: boolean,
  tiers = DEFAULT_TIERS, premiumMicro = 0,
): PriceQuote {
  const length = label.length;
  const base = { label, length, years };
  if (premiumMicro > 0) {
    return { ...base, usdPerYearMicro: premiumMicro, totalUsdMicro: premiumMicro * years, free: false, available: true };
  }
  if (length >= 5) {
    if (!freeAlreadyClaimed) {
      return { ...base, years: 1, usdPerYearMicro: 0, totalUsdMicro: 0, free: true, available: true };
    }
    const t = tiers[5];
    return { ...base, usdPerYearMicro: t.priceUsdMicro, totalUsdMicro: t.priceUsdMicro * years, free: false, available: t.enabled };
  }
  const t = tiers[length];
  if (!t || !t.enabled || t.priceUsdMicro === 0) {
    return { ...base, usdPerYearMicro: 0, totalUsdMicro: 0, free: false, available: false, reason: "names of this length are not open for registration" };
  }
  return { ...base, usdPerYearMicro: t.priceUsdMicro, totalUsdMicro: t.priceUsdMicro * years, free: false, available: true };
}
