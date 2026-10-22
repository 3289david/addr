// Metadata + image for the registry's ERC-721 surface (AddrRegistry.tokenURI points here). A
// name's NFT metadata mirrors the same fields the rest of the site already shows for it — this is
// a read-only presentation layer over the registry/names index, not a second source of truth.
import { AddrError } from "../packages/core/src/index.ts";
import { config } from "./config.ts";
import { db, now } from "./db.ts";
import { registry } from "./chain.ts";

export function nodeFromTokenId(tokenId: string): string {
  if (!/^\d+$/.test(tokenId)) throw new AddrError("invalid_request", "tokenId must be a decimal integer", 422);
  return "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
}

interface NameRow { name: string; label: string; owner: string; expires: number; free: number }

function lookup(node: string): NameRow | undefined {
  return db.prepare("SELECT name, label, owner, expires, free FROM names WHERE node = ?").get(node) as NameRow | undefined;
}

export async function nftMetadata(tokenId: string) {
  const node = nodeFromTokenId(tokenId);
  const base = config.publicUrl || "";
  const row = lookup(node);
  const image = `${base}/v1/nft/${tokenId}/image.svg`;
  if (!row) {
    // Not in the index yet — could be mid-indexing-lag right after a fresh registration, or could
    // genuinely not exist. Ask the chain directly (source of truth) rather than guess.
    const status = Number(await registry.statusOf(node));
    if (status === 0) throw new AddrError("not_found", "no such token", 404);
    return { name: "(indexing)", description: "This name was just registered and is still being indexed. Refresh shortly.", image };
  }
  const expired = row.expires > 0 && row.expires < now();
  const attributes: Record<string, unknown>[] = [
    { trait_type: "Length", value: row.label.length },
    { trait_type: "Status", value: expired ? "expired" : "active" },
    { trait_type: "Free tier", value: row.free ? "yes" : "no" },
  ];
  if (row.expires > 0) attributes.push({ trait_type: "Expires", display_type: "date", value: row.expires });
  return {
    name: row.name,
    description: `${row.name} is a human-readable Web3 name, resolving to Bitcoin, Ethereum, Solana, TRON, Litecoin and USDT addresses. Ownership and records live entirely on-chain — see https://addr.krl.kr/docs/integration-guide.md for how to read them directly, no API required.`,
    image,
    external_url: `${base}/name/${row.name}`,
    attributes,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function nftImageSvg(label: string): string {
  const text = esc(label);
  // Shrink the font for long names so they stay on one line within the fixed canvas.
  const size = text.length > 20 ? 34 : text.length > 14 ? 42 : 56;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect x="6" y="6" width="588" height="588" fill="#ffc700" stroke="#0a0a09" stroke-width="12"/>
  <rect x="40" y="40" width="80" height="80" fill="#0a0a09"/>
  <text x="62" y="100" font-family="Arial, sans-serif" font-size="46" font-weight="800" fill="#ffc700">A</text>
  <text x="300" y="330" font-family="Arial, sans-serif" font-size="${size}" font-weight="800" fill="#0a0a09" text-anchor="middle">${text}</text>
  <text x="300" y="540" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#0a0a09" text-anchor="middle" opacity="0.7">ADDR · addr.krl.kr</text>
</svg>`;
}
