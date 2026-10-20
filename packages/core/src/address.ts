import { getAddress } from "ethers";
import {
  base58CheckDecode, base58CheckEncode, base58Decode, base58Encode, bech32Decode, bech32Encode,
  bytesToHex, concat, convertBits, hexToBytes,
} from "./encoding.ts";
import type { Network } from "./chains.ts";
import { getNetwork, getNetworkByCoinType } from "./chains.ts";

export interface AddressCheck {
  valid: boolean;
  format?: string;
  error?: string;
  /** canonical form of the address (checksummed for EVM) */
  normalized?: string;
}

const BTC = { p2pkh: 0x00, p2sh: 0x05, hrp: "bc" };
const LTC = { p2pkh: 0x30, p2sh: 0x32, p2shLegacy: 0x05, hrp: "ltc" };

function scriptFor(version: number, prog: Uint8Array): Uint8Array | null {
  if (version === 0 && prog.length === 20) return concat(Uint8Array.of(0x00, 0x14), prog);
  if (version === 0 && prog.length === 32) return concat(Uint8Array.of(0x00, 0x20), prog);
  if (version === 1 && prog.length === 32) return concat(Uint8Array.of(0x51, 0x20), prog);
  return null;
}

/** Address string -> ENSIP-9 binary form stored in the resolver. Throws on invalid input. */
export function encodeAddress(net: Network, address: string): Uint8Array {
  switch (net.family) {
    case "evm":
      return hexToBytes(getAddress(address)); // throws on bad checksum / format
    case "solana": {
      const raw = base58Decode(address);
      if (raw.length !== 32) throw new Error("Solana address must decode to 32 bytes");
      if (base58Encode(raw) !== address) throw new Error("non-canonical base58");
      return raw;
    }
    case "tron": {
      const payload = base58CheckDecode(address);
      if (payload.length !== 21 || payload[0] !== 0x41) throw new Error("not a TRON address");
      return payload;
    }
    case "btc":
    case "ltc": {
      const p = net.family === "btc" ? BTC : LTC;
      const lower = address.toLowerCase();
      if (lower.startsWith(p.hrp + "1")) {
        const { hrp, data, variant } = bech32Decode(address);
        if (hrp !== p.hrp) throw new Error("wrong network prefix");
        const version = data[0];
        if (version > 16) throw new Error("bad witness version");
        const prog = Uint8Array.from(convertBits(data.slice(1), 5, 8, false));
        if (prog.length < 2 || prog.length > 40) throw new Error("bad witness program length");
        if (version === 0 && variant !== "bech32") throw new Error("v0 must be bech32");
        if (version !== 0 && variant !== "bech32m") throw new Error("v1+ must be bech32m");
        const script = scriptFor(version, prog);
        if (!script) throw new Error("unsupported witness program");
        return script;
      }
      const payload = base58CheckDecode(address);
      if (payload.length !== 21) throw new Error("bad payload length");
      const hash = payload.slice(1);
      const v = payload[0];
      if (v === p.p2pkh) return concat(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac));
      if (v === p.p2sh || (net.family === "ltc" && v === LTC.p2shLegacy)) {
        return concat(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87));
      }
      throw new Error("unknown address version byte");
    }
  }
}

/** Binary resolver value -> human address string. */
export function decodeAddress(net: Network, data: Uint8Array): string {
  switch (net.family) {
    case "evm":
      if (data.length !== 20) throw new Error("bad EVM length");
      return getAddress(bytesToHex(data));
    case "solana":
      if (data.length !== 32) throw new Error("bad Solana length");
      return base58Encode(data);
    case "tron":
      if (data.length !== 21 || data[0] !== 0x41) throw new Error("bad TRON length");
      return base58CheckEncode(data);
    case "btc":
    case "ltc": {
      const p = net.family === "btc" ? BTC : LTC;
      const n = data.length;
      if (n === 25 && data[0] === 0x76 && data[1] === 0xa9 && data[2] === 0x14 && data[23] === 0x88 && data[24] === 0xac) {
        return base58CheckEncode(concat(Uint8Array.of(p.p2pkh), data.slice(3, 23)));
      }
      if (n === 23 && data[0] === 0xa9 && data[1] === 0x14 && data[22] === 0x87) {
        return base58CheckEncode(concat(Uint8Array.of(p.p2sh), data.slice(2, 22)));
      }
      if ((n === 22 && data[0] === 0x00 && data[1] === 0x14) || (n === 34 && data[0] === 0x00 && data[1] === 0x20)) {
        return bech32Encode(p.hrp, [0, ...convertBits(data.slice(2), 8, 5, true)], "bech32");
      }
      if (n === 34 && data[0] === 0x51 && data[1] === 0x20) {
        return bech32Encode(p.hrp, [1, ...convertBits(data.slice(2), 8, 5, true)], "bech32m");
      }
      throw new Error("unrecognized script");
    }
  }
}

export function describeFormat(net: Network, address: string): string {
  switch (net.family) {
    case "evm": return "EIP-55";
    case "solana": return "base58-ed25519-pubkey";
    case "tron": return "base58check-T";
    case "btc":
    case "ltc": {
      const l = address.toLowerCase();
      if (l.startsWith("bc1p") || l.startsWith("ltc1p")) return "p2tr";
      if (l.startsWith("bc1") || l.startsWith("ltc1")) return address.length > 50 ? "p2wsh" : "p2wpkh";
      const first = address[0];
      return first === "1" || first === "L" ? "p2pkh" : "p2sh";
    }
  }
}

export function validateAddress(networkId: string, address: string): AddressCheck {
  const net = getNetwork(networkId);
  if (!net) return { valid: false, error: `unsupported network "${networkId}"` };
  if (typeof address !== "string" || address.trim() !== address || address.length === 0) {
    return { valid: false, error: "empty or whitespace-padded address" };
  }
  try {
    const bin = encodeAddress(net, address);
    return { valid: true, format: describeFormat(net, address), normalized: decodeAddress(net, bin) };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

export function networkForCoinType(coinType: number): Network | undefined {
  return getNetworkByCoinType(coinType);
}
