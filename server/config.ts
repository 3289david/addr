import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function loadDotEnv() {
  const f = path.join(root, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadDotEnv();

const e = process.env;
const num = (k: string, d: number) => (e[k] ? Number(e[k]) : d);

export interface Deployment {
  chainId: number;
  registry: string;
  resolver: string;
  registrar: string;
  timelock: string;
  ethUsdFeed: string;
  tokens: Record<string, string>;
  treasury: string;
  startBlock: number;
}

const chainId = num("CHAIN_ID", 31337);
const depFile = path.join(root, "deployments", `${chainId}.json`);

export const config = {
  root,
  port: num("PORT", 8787),
  host: e.HOST || "127.0.0.1",
  dbPath: e.DB_PATH || path.join(root, "data", "addr.db"),
  chainId,
  /** Comma-separated RPC URLs; more than one enables quorum-less fallback failover. */
  rpcUrls: (e.RPC_URLS || "http://127.0.0.1:8545").split(",").map((s) => s.trim()).filter(Boolean),
  confirmations: num("CONFIRMATIONS", chainId === 31337 ? 0 : 3),
  indexIntervalMs: num("INDEX_INTERVAL_MS", 1500),
  deployment: (fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : null) as Deployment | null,
  // signing keys (server never holds user keys; these are the protocol's own roles)
  freeSignerKey: e.FREE_SIGNER_KEY || "",
  operatorKey: e.OPERATOR_KEY || "", // registrar payment operator (registerPaid) and enterprise relayer
  adminToken: e.ADMIN_TOKEN || "",
  publicUrl: e.PUBLIC_URL || "",
  // email (self-hosted delivery, no third-party API)
  mail: {
    transport: (e.MAIL_TRANSPORT || "direct") as "direct" | "relay" | "file",
    from: e.MAIL_FROM || "ADDR <login@localhost>",
    helo: e.MAIL_HELO || "",
    dkimKey: e.DKIM_PRIVATE_KEY ? e.DKIM_PRIVATE_KEY.split("\\n").join("\n") : (e.DKIM_KEY_FILE && fs.existsSync(e.DKIM_KEY_FILE) ? fs.readFileSync(e.DKIM_KEY_FILE, "utf8") : ""),
    dkimSelector: e.DKIM_SELECTOR || "addr",
    mxOverride: e.MAIL_MX_OVERRIDE || "",         // host[:port], forces delivery to this server (tests, split-horizon)
    tls: e.MAIL_TLS || "opportunistic",           // opportunistic | require | off
    relay: { host: e.SMTP_HOST || "", port: num("SMTP_PORT", 587), secure: e.SMTP_SECURE === "1", user: e.SMTP_USER || "", pass: e.SMTP_PASS || "" },
    outboxDir: e.MAIL_OUTBOX_DIR || path.join(root, "data", "outbox"),
    port: num("MAIL_PORT", 25),
  },
  adminEmails: (e.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  cookieSecure: e.COOKIE_SECURE === "1" || (e.PUBLIC_URL || "").startsWith("https://"),
  loginIpPerHour: num("LOGIN_IP_PER_HOUR", 20),
  loginCodeTtlSec: num("LOGIN_CODE_TTL_SEC", 600),
  sessionTtlSec: num("SESSION_TTL_SEC", 30 * 86400),
  legal: {
    entity: e.LEGAL_ENTITY || "",
    email: e.LEGAL_EMAIL || "",
    hosting: e.LEGAL_HOSTING || "",
    privacyEmail: e.LEGAL_PRIVACY_EMAIL || e.LEGAL_EMAIL || "",
    address: e.LEGAL_ADDRESS || "",
    representative: e.LEGAL_REPRESENTATIVE || "",
    jurisdiction: e.LEGAL_JURISDICTION || "Republic of Korea",
    effective: e.LEGAL_EFFECTIVE || "2026-10-20",
  },
  /** Days. The privacy policy quotes these numbers and the retention job enforces them. */
  retentionDays: { loginCodes: 7, rateEvents: 2, sentMailBodies: 7, mailLog: 90, sessionsAfterExpiry: 30, ipUsage: 30, webhookDeliveries: 30, idempotency: 7, rpcHealth: 14, audit: 365, closedReports: 730 },
  // limits
  anonDailyLimit: num("ANON_DAILY_LIMIT", 2000),
  freeKeyDailyLimit: num("FREE_KEY_DAILY_LIMIT", 20000),
  freeClaimsPerIpPerDay: num("FREE_CLAIMS_PER_IP_PER_DAY", 3),
  allowInsecureWebhooks: e.ALLOW_INSECURE_WEBHOOKS === "1",
  // payments
  quoteTtlSec: num("QUOTE_TTL_SEC", 1800),
  priceApi: e.PRICE_API || "https://api.coingecko.com/api/v3/simple/price",
  btcApi: e.BTC_API || "https://mempool.space/api",
  ltcApi: e.LTC_API || "https://litecoinspace.org/api",
  tronApi: e.TRON_API || "https://api.trongrid.io",
  tronApiKey: e.TRON_API_KEY || "",
  solanaRpc: e.SOLANA_RPC || "https://api.mainnet-beta.solana.com",
  minConf: {
    bitcoin: num("MINCONF_BITCOIN", 2),
    litecoin: num("MINCONF_LITECOIN", 6),
    tron: num("MINCONF_TRON", 19),
    solana: 1, // finalized commitment
    evm: num("MINCONF_EVM", chainId === 31337 ? 1 : 12),
  },
  /** Receiving addresses per network id. A network is payable only if its treasury is configured. */
  treasuries: Object.fromEntries(
    Object.entries(e)
      .filter(([k, v]) => k.startsWith("TREASURY_") && v)
      .map(([k, v]) => [k.slice(9).toLowerCase(), v as string]),
  ) as Record<string, string>,
  /** Additional EVM RPCs for payment verification: EVM_RPC_<NETWORKID>=url */
  evmRpc: Object.fromEntries(
    Object.entries(e)
      .filter(([k, v]) => k.startsWith("EVM_RPC_") && v)
      .map(([k, v]) => [k.slice(8).toLowerCase(), v as string]),
  ) as Record<string, string>,
  plans: {
    free: { name: "FREE", priceUsd: 0, dailyLimit: num("FREE_KEY_DAILY_LIMIT", 20000), maxSubnames: 0, webhooks: 0, batch: 10 },
    startup: { name: "STARTUP", priceUsd: 35, dailyLimit: 200000, maxSubnames: 1000, webhooks: 5, batch: 50 },
    business: { name: "BUSINESS", priceUsd: 142, dailyLimit: 2000000, maxSubnames: 1_000_000, webhooks: 50, batch: 100 },
    enterprise: { name: "ENTERPRISE", priceUsd: 0, dailyLimit: 1e12, maxSubnames: 1e12, webhooks: 1000, batch: 100 },
  } as Record<string, { name: string; priceUsd: number; dailyLimit: number; maxSubnames: number; webhooks: number; batch: number }>,
};

export function requireDeployment(): Deployment {
  if (!config.deployment) {
    throw new Error(`No deployment for chain ${config.chainId}. Run: npm run deploy:local (or deploy to your network)`);
  }
  return config.deployment;
}
