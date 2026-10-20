// Generates docs/test-vectors.json from the reference implementation. Independent implementations must match it.
import fs from "node:fs";
import path from "node:path";
import {
  ROOT_NODE, namehash, normalizeName, getNetwork, encodeAddress, decodeAddress, bytesToHex, validateAddress, base58CheckEncode, hexToBytes, concat,
} from "../packages/core/src/index.ts";

const names = ["heelo.addr", "alice.addr", "shop.heelo.addr", "a.addr", "a-b.addr", "x1.y2.z3.addr"].map((n) => ({ name: n, node: namehash(n) }));
const invalidNames = ["heelo", "Heelo.eth", "he_llo.addr", "-ab.addr", "ab-.addr", "a--b.addr", ".addr", "a..addr", "héllo.addr", "a b.addr", "x".repeat(64) + ".addr"];
const normalization = [[" Heelo.ADDR ", "heelo.addr"], ["ALICE.Addr", "alice.addr"]].map(([i, o]) => ({ input: i, output: normalizeName(i) === o ? o : "MISMATCH" }));

const tron = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ltcHash = hexToBytes("0x" + "11".repeat(20));
const valid: any[] = [
  ["bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
  ["bitcoin", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
  ["bitcoin", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"],
  ["litecoin", base58CheckEncode(concat(Uint8Array.of(0x30), ltcHash))],
  ["litecoin", base58CheckEncode(concat(Uint8Array.of(0x32), ltcHash))],
  ["ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
  ["base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  ["tron", tron],
  ["solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
  ["solana", "11111111111111111111111111111111"],
].map(([network, address]) => {
  const net = getNetwork(network)!;
  const bin = encodeAddress(net, address);
  return { network, coinType: net.coinType, address, stored: bytesToHex(bin), roundTrip: decodeAddress(net, bin) === address };
});
const invalid = [
  ["bitcoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "bad base58 checksum"],
  ["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "bad bech32 checksum"],
  ["bitcoin", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "testnet prefix on mainnet"],
  ["bitcoin", "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5sw4mq6", "witness v1 must use bech32m"],
  ["litecoin", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "bitcoin address on litecoin"],
  ["ethereum", "0x1234", "wrong length"],
  ["tron", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "bitcoin address on tron"],
  ["solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYBB", "wrong length"],
  ["solana", "0OIl", "invalid base58 alphabet"],
].map(([network, address, why]) => ({ network, address, reason: why, valid: validateAddress(network, address).valid }));

for (const v of valid) if (!v.roundTrip) throw new Error("round trip failed " + v.address);
for (const v of invalid) if (v.valid) throw new Error("expected invalid " + v.address);

const out = {
  spec: "ADDR-1",
  rootNode: ROOT_NODE,
  nodeAlgorithm: "node(label.parent) = keccak256(node(parent) || keccak256(label)); node('') = 0x00..00",
  names, normalization, invalidNames, validAddresses: valid, invalidAddresses: invalid,
};
fs.writeFileSync(path.join(import.meta.dirname, "..", "docs", "test-vectors.json"), JSON.stringify(out, null, 2));
console.log("docs/test-vectors.json written:", names.length, "names,", valid.length, "valid and", invalid.length, "invalid addresses");
