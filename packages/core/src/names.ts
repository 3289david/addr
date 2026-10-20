import { keccak256, toUtf8Bytes, getBytes, hexlify, concat } from "ethers";

export const TLD = "addr";
export const MIN_LABEL = 1;
export const MAX_LABEL = 63;

export class AddrError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Matches the on-chain rule in AddrName.validLabel: [a-z0-9-], 1..63, no edge or double hyphens. */
export function isValidLabel(label: string): boolean {
  if (label.length < MIN_LABEL || label.length > MAX_LABEL) return false;
  if (!/^[a-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-") || label.includes("--")) return false;
  return true;
}

/**
 * Normalizes user input to canonical form. Only ASCII is accepted (no unicode, so no confusable
 * homoglyphs). Input is trimmed and lower-cased; anything else invalid is rejected, never silently altered.
 */
export function normalizeName(input: string): string {
  if (typeof input !== "string") throw new AddrError("invalid_name", "name must be a string");
  const name = input.trim().toLowerCase();
  if (!/^[\x21-\x7e]+$/.test(name)) throw new AddrError("invalid_name", "name contains disallowed characters");
  const parts = name.split(".");
  if (parts.length < 2 || parts[parts.length - 1] !== TLD) {
    throw new AddrError("invalid_name", `name must end with .${TLD}`);
  }
  for (const p of parts) if (!isValidLabel(p)) throw new AddrError("invalid_name", `invalid label "${p}"`);
  return parts.join(".");
}

/** Accepts "heelo" or "heelo.addr" and returns the second-level label. */
export function normalizeLabel(input: string): string {
  const s = input.trim().toLowerCase();
  const label = s.endsWith(`.${TLD}`) ? s.slice(0, -(TLD.length + 1)) : s;
  if (!isValidLabel(label)) throw new AddrError("invalid_name", `invalid label "${label}"`);
  return label;
}

export function labelhash(label: string): string {
  return keccak256(toUtf8Bytes(label));
}

export const ZERO32 = "0x" + "00".repeat(32);

export function namehash(name: string): string {
  const n = normalizeName(name);
  let node = ZERO32;
  const labels = n.split(".").reverse();
  for (const l of labels) node = keccak256(concat([getBytes(node), getBytes(labelhash(l))]));
  return hexlify(node);
}

export const ROOT_NODE = (() => {
  return keccak256(concat([getBytes(ZERO32), getBytes(labelhash(TLD))]));
})();

export function parentName(name: string): string | null {
  const p = normalizeName(name).split(".");
  return p.length > 2 ? p.slice(1).join(".") : null;
}

export function isSecondLevel(name: string): boolean {
  return normalizeName(name).split(".").length === 2;
}

export function toLabels(name: string): string[] {
  return normalizeName(name).split(".");
}

export const SAMPLE_RESERVED = [
  "admin", "support", "root", "addr", "www", "api", "app", "help", "security", "official",
  "team", "mail", "wallet", "bank", "exchange", "ens", "dns", "registry", "resolver", "registrar",
  "treasury", "bitcoin", "ethereum", "solana", "tron", "litecoin", "usdt", "usdc",
];
