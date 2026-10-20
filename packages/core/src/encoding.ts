// Dependency-light encoders: hex, base58(check), bech32/bech32m. Isomorphic (browser + Node).
import { sha256 } from "ethers";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58.length; i++) B58_MAP[B58[i]] = i;

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let s = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}

export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const v = B58_MAP[str[i]];
    if (v === undefined) throw new Error("invalid base58 character");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

function dsha256(data: Uint8Array): Uint8Array {
  return hexToBytes(sha256(hexToBytes(sha256(data))));
}

export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concat(payload, dsha256(payload).slice(0, 4)));
}

/** Returns payload (without checksum); throws on bad checksum. */
export function base58CheckDecode(str: string): Uint8Array {
  const raw = base58Decode(str);
  if (raw.length < 5) throw new Error("too short");
  const payload = raw.slice(0, raw.length - 4);
  const check = raw.slice(raw.length - 4);
  const expect = dsha256(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) if (check[i] !== expect[i]) throw new Error("bad checksum");
  return payload;
}

// ---- bech32 / bech32m (BIP-173 / BIP-350)
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

export function bech32Decode(str: string): { hrp: string; data: number[]; variant: "bech32" | "bech32m" } {
  if (str.length < 8 || str.length > 90) throw new Error("bad length");
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error("mixed case");
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("bad separator");
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (let i = pos + 1; i < s.length; i++) {
    const v = CHARSET.indexOf(s[i]);
    if (v === -1) throw new Error("bad character");
    data.push(v);
  }
  const c = polymod([...hrpExpand(hrp), ...data]);
  let variant: "bech32" | "bech32m";
  if (c === BECH32_CONST) variant = "bech32";
  else if (c === BECH32M_CONST) variant = "bech32m";
  else throw new Error("bad checksum");
  return { hrp, data: data.slice(0, data.length - 6), variant };
}

export function bech32Encode(hrp: string, data: number[], variant: "bech32" | "bech32m"): string {
  const k = variant === "bech32" ? BECH32_CONST : BECH32M_CONST;
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ k;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

export function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < 0 || v >> from !== 0) throw new Error("bad value");
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("bad padding");
  }
  return out;
}
