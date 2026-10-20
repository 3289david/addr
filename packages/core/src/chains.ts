// Network + asset registry. A network is only listed "supported" when an address codec exists and is tested.

export type NetworkId =
  | "bitcoin" | "litecoin" | "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "bsc" | "tron" | "solana";

export type AddressFamily = "btc" | "ltc" | "evm" | "tron" | "solana";

export interface Asset {
  symbol: string;
  name: string;
  /** Token standard label shown to users, e.g. TRC20, ERC20, SPL. Native coins use "native". */
  standard: string;
  /** Token contract / mint (omitted for native). */
  contract?: string;
  decimals: number;
}

export interface Network {
  id: NetworkId;
  name: string;
  family: AddressFamily;
  /** ENSIP-9 / SLIP-44 coin type (EVM chains use ENSIP-11: 0x80000000 | chainId, mainnet Ethereum = 60). */
  coinType: number;
  chainId?: number;
  mainnet: boolean;
  nativeSymbol: string;
  explorerTx: string;
  explorerAddress: string;
  assets: Asset[];
}

const evm = (
  id: NetworkId, name: string, chainId: number, nativeSymbol: string, base: string, assets: Asset[],
): Network => ({
  id, name, family: "evm", chainId,
  coinType: chainId === 1 ? 60 : (0x80000000 | chainId) >>> 0,
  mainnet: true, nativeSymbol,
  explorerTx: `${base}/tx/{tx}`, explorerAddress: `${base}/address/{address}`,
  assets: [{ symbol: nativeSymbol, name: nativeSymbol, standard: "native", decimals: 18 }, ...assets],
});

const usdt = (contract: string, standard: string, decimals = 6): Asset => ({ symbol: "USDT", name: "Tether USD", standard, contract, decimals });
const usdc = (contract: string, standard: string, decimals = 6): Asset => ({ symbol: "USDC", name: "USD Coin", standard, contract, decimals });

export const NETWORKS: Network[] = [
  {
    id: "bitcoin", name: "Bitcoin", family: "btc", coinType: 0, mainnet: true, nativeSymbol: "BTC",
    explorerTx: "https://mempool.space/tx/{tx}", explorerAddress: "https://mempool.space/address/{address}",
    assets: [{ symbol: "BTC", name: "Bitcoin", standard: "native", decimals: 8 }],
  },
  {
    id: "litecoin", name: "Litecoin", family: "ltc", coinType: 2, mainnet: true, nativeSymbol: "LTC",
    explorerTx: "https://litecoinspace.org/tx/{tx}", explorerAddress: "https://litecoinspace.org/address/{address}",
    assets: [{ symbol: "LTC", name: "Litecoin", standard: "native", decimals: 8 }],
  },
  evm("ethereum", "Ethereum", 1, "ETH", "https://etherscan.io", [
    usdt("0xdAC17F958D2ee523a2206206994597C13D831ec7", "ERC20"),
    usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "ERC20"),
  ]),
  evm("base", "Base", 8453, "ETH", "https://basescan.org", [
    usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "ERC20"),
  ]),
  evm("arbitrum", "Arbitrum One", 42161, "ETH", "https://arbiscan.io", [
    usdt("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "ERC20"),
    usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "ERC20"),
  ]),
  evm("optimism", "Optimism", 10, "ETH", "https://optimistic.etherscan.io", [
    usdt("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "ERC20"),
    usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "ERC20"),
  ]),
  evm("polygon", "Polygon", 137, "POL", "https://polygonscan.com", [
    usdt("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "ERC20"),
    usdc("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "ERC20"),
  ]),
  evm("bsc", "BNB Smart Chain", 56, "BNB", "https://bscscan.com", [
    usdt("0x55d398326f99059fF775485246999027B3197955", "BEP20", 18),
    usdc("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "BEP20", 18),
  ]),
  {
    id: "tron", name: "TRON", family: "tron", coinType: 195, mainnet: true, nativeSymbol: "TRX",
    explorerTx: "https://tronscan.org/#/transaction/{tx}", explorerAddress: "https://tronscan.org/#/address/{address}",
    assets: [
      { symbol: "TRX", name: "TRON", standard: "native", decimals: 6 },
      usdt("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TRC20"),
      usdc("TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8", "TRC20"),
    ],
  },
  {
    id: "solana", name: "Solana", family: "solana", coinType: 501, mainnet: true, nativeSymbol: "SOL",
    explorerTx: "https://solscan.io/tx/{tx}", explorerAddress: "https://solscan.io/account/{address}",
    assets: [
      { symbol: "SOL", name: "Solana", standard: "native", decimals: 9 },
      usdt("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "SPL"),
      usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "SPL"),
    ],
  },
];

/** Networks that are intentionally not supported yet. API returns these explicitly rather than guessing. */
export const UNSUPPORTED_NETWORKS = ["dogecoin", "xrp", "cosmos", "ton", "sui", "aptos"];

export function getNetwork(id: string): Network | undefined {
  return NETWORKS.find((n) => n.id === id);
}

export function getNetworkByCoinType(coinType: number): Network | undefined {
  return NETWORKS.find((n) => n.coinType === coinType);
}

export function getAsset(net: Network, symbol: string, standard?: string): Asset | undefined {
  const s = symbol.toUpperCase();
  return net.assets.find((a) => a.symbol === s && (!standard || a.standard.toUpperCase() === standard.toUpperCase()));
}

/** Multi-network tokens (USDT/USDC) must never be resolved without a network. */
export function isMultiNetworkAsset(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return NETWORKS.filter((n) => n.assets.some((a) => a.symbol === s && a.standard !== "native")).length > 1;
}

export function explorerTxUrl(net: Network, tx: string): string {
  return net.explorerTx.replace("{tx}", tx);
}
export function explorerAddressUrl(net: Network, address: string): string {
  return net.explorerAddress.replace("{address}", address);
}

export function evmCoinType(chainId: number): number {
  return chainId === 1 ? 60 : (0x80000000 | chainId) >>> 0;
}
