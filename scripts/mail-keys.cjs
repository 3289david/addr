// Generates a DKIM key pair and prints the DNS records to publish for self-hosted email delivery.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const domain = process.argv[2];
const selector = process.argv[3] || "addr";
if (!domain) { console.error("usage: node scripts/mail-keys.cjs <sending-domain> [selector]"); process.exit(1); }
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const file = path.join(__dirname, "..", "data", `dkim-${selector}.pem`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, pem, { mode: 0o600 });
console.log(`Private key written to ${file} (keep it secret). Set in .env:\n  DKIM_KEY_FILE=${file}\n  DKIM_SELECTOR=${selector}\n  MAIL_FROM="ADDR <login@${domain}>"\n`);
console.log("Publish these DNS records:\n");
console.log(`  ${selector}._domainkey.${domain}  TXT  "v=DKIM1; k=rsa; p=${pub}"`);
console.log(`  ${domain}                         TXT  "v=spf1 ip4:YOUR.SERVER.IP -all"`);
console.log(`  _dmarc.${domain}                  TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}"`);
console.log("\nAlso set a reverse DNS (PTR) record for your server IP to a hostname that resolves back to it (MAIL_HELO).");
console.log("Outbound port 25 must be open on your host. If your provider blocks it, set MAIL_TRANSPORT=relay with SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (your own or your host's SMTP relay).");
