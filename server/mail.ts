// Self-hosted outbound mail: RFC 5322 message builder, DKIM (RFC 6376, rsa-sha256, relaxed/relaxed),
// an SMTP client (RFC 5321, STARTTLS, AUTH) that delivers straight to the recipient's MX, and a persistent
// retry queue. No third-party mail API is involved.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { config } from "./config.ts";
import { db, now } from "./db.ts";

// ------------------------------------------------------------------ message

export interface MailInput { to: string; subject: string; text: string; html?: string }

const CRLF = "\r\n";
const b64lines = (buf: Buffer | string, width = 76) => (Buffer.from(buf).toString("base64").match(new RegExp(`.{1,${width}}`, "g")) ?? []).join(CRLF);

function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export function parseAddress(a: string): { name: string; email: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(a);
  return m ? { name: m[1]?.trim() ?? "", email: m[2].trim() } : { name: "", email: a.trim() };
}

export function senderDomain(): string {
  const d = parseAddress(config.mail.from).email.split("@")[1];
  return (d || "localhost").toLowerCase();
}

export function buildMessage(m: MailInput): { raw: string; messageId: string } {
  const from = parseAddress(config.mail.from);
  const domain = senderDomain();
  const messageId = `<${crypto.randomBytes(16).toString("hex")}@${domain}>`;
  const boundary = "=_addr_" + crypto.randomBytes(12).toString("hex");
  const fromHeader = from.name ? `${encodeHeaderWord(from.name)} <${from.email}>` : from.email;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  ];
  let body: string;
  if (m.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64", "", b64lines(m.text),
      `--${boundary}`, 'Content-Type: text/html; charset="utf-8"', "Content-Transfer-Encoding: base64", "", b64lines(m.html),
      `--${boundary}--`, "",
    ].join(CRLF);
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64");
    body = b64lines(m.text) + CRLF;
  }
  return { raw: headers.join(CRLF) + CRLF + CRLF + body, messageId };
}

// -------------------------------------------------------------------- DKIM

function relaxHeader(name: string, value: string): string {
  return name.toLowerCase() + ":" + value.replace(/\r?\n[ \t]+/g, " ").replace(/[ \t]+/g, " ").trim() + CRLF;
}
function relaxBody(body: string): string {
  let lines = body.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines.join(CRLF) + CRLF : "";
}

const SIGNED = ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"];

/** Prepends a DKIM-Signature header. Returns raw unchanged when no key is configured. */
export function dkimSign(raw: string, key = config.mail.dkimKey, selector = config.mail.dkimSelector, domain = senderDomain()): string {
  if (!key) return raw;
  const idx = raw.indexOf(CRLF + CRLF);
  const head = raw.slice(0, idx);
  const body = raw.slice(idx + 4);
  const hdrs = new Map<string, string>();
  for (const line of head.replace(/\r\n([ \t])/g, "$1").split(CRLF)) {
    const c = line.indexOf(":");
    if (c > 0) hdrs.set(line.slice(0, c).toLowerCase(), line.slice(c + 1));
  }
  const h = SIGNED.filter((n) => hdrs.has(n));
  const bh = crypto.createHash("sha256").update(relaxBody(body)).digest("base64");
  const unsigned = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; t=${now()}; h=${h.join(":")}; bh=${bh}; b=`;
  const data = h.map((n) => relaxHeader(n, hdrs.get(n)!)).join("") + relaxHeader("DKIM-Signature", unsigned).slice(0, -2);
  const sig = crypto.sign("sha256", Buffer.from(data), key).toString("base64");
  const folded = unsigned + (sig.match(/.{1,72}/g) ?? []).join(CRLF + "\t");
  return `DKIM-Signature: ${folded}${CRLF}${raw}`;
}

export function generateDkimKeys(): { privateKey: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKeyBase64: der.toString("base64") };
}

// -------------------------------------------------------------------- SMTP

class SmtpError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg); this.code = code; }
  get permanent() { return this.code >= 500 && this.code < 600; }
}

class SmtpConn {
  private sock: net.Socket | tls.TLSSocket;
  private buf = "";
  private waiters: ((r: { code: number; lines: string[] }) => void)[] = [];
  private pending: string[] = [];
  private err: Error | null = null;
  private rejecter: ((e: Error) => void)[] = [];

  constructor(sock: net.Socket | tls.TLSSocket) { this.sock = sock; this.bind(sock); }

  private bind(s: net.Socket) {
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      this.buf += d;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) break;
        const line = this.buf.slice(0, nl).replace(/\r$/, "");
        this.buf = this.buf.slice(nl + 1);
        this.pending.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const lines = this.pending; this.pending = [];
          const w = this.waiters.shift();
          if (w) w({ code: Number(line.slice(0, 3)), lines });
        }
      }
    });
    const fail = (e: Error) => { this.err = e; this.rejecter.splice(0).forEach((r) => r(e)); };
    s.on("error", fail);
    s.on("close", () => fail(new Error("connection closed")));
  }

  reply(timeoutMs = 30_000): Promise<{ code: number; lines: string[] }> {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("SMTP timeout")), timeoutMs);
      this.rejecter.push((e) => { clearTimeout(t); reject(e); });
      this.waiters.push((r) => { clearTimeout(t); resolve(r); });
    });
  }

  async cmd(line: string, ok: number[]): Promise<{ code: number; lines: string[] }> {
    this.sock.write(line + CRLF);
    return this.expect(ok);
  }

  async expect(ok: number[]) {
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new SmtpError(r.code, r.lines.join(" | "));
    return r;
  }

  write(s: string) { this.sock.write(s); }

  async startTls(servername: string, verify: boolean) {
    const plain = this.sock;
    plain.removeAllListeners("data");
    const secure = tls.connect({ socket: plain, servername: net.isIP(servername) ? undefined : servername, rejectUnauthorized: verify });
    await new Promise<void>((res, rej) => { secure.once("secureConnect", () => res()); secure.once("error", rej); });
    this.sock = secure;
    this.buf = ""; this.pending = [];
    this.bind(secure);
  }

  close() { try { this.sock.write("QUIT" + CRLF); this.sock.end(); } catch { /* already closed */ } setTimeout(() => this.sock.destroy(), 500).unref(); }
}

function connect(host: string, port: number, secure: boolean): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }) : net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error(`connect timeout ${host}:${port}`)); }, 15_000);
    s.once(secure ? "secureConnect" : "connect", () => { clearTimeout(t); resolve(s); });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function dotStuff(raw: string): string {
  return raw.replace(/\r?\n/g, CRLF).replace(/(^|\r\n)\./g, "$1..");
}

interface Endpoint { host: string; port: number; secure?: boolean; auth?: { user: string; pass: string } }

async function deliverTo(ep: Endpoint, from: string, rcpt: string, raw: string) {
  const sock = await connect(ep.host, ep.port, !!ep.secure);
  const c = new SmtpConn(sock);
  try {
    await c.expect([220]);
    const helo = config.mail.helo || senderDomain();
    let ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    const hasTls = () => ehlo.lines.some((l) => /STARTTLS/i.test(l));
    if (!ep.secure && config.mail.tls !== "off" && hasTls()) {
      await c.cmd("STARTTLS", [220]);
      await c.startTls(ep.host, config.mail.tls === "require" && !!ep.auth);
      ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    } else if (config.mail.tls === "require" && !ep.secure) {
      throw new SmtpError(530, "TLS required but not offered");
    }
    if (ep.auth) {
      const plain = Buffer.from(`\0${ep.auth.user}\0${ep.auth.pass}`).toString("base64");
      await c.cmd(`AUTH PLAIN ${plain}`, [235]);
    }
    await c.cmd(`MAIL FROM:<${from}>`, [250]);
    await c.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await c.cmd("DATA", [354]);
    c.write(dotStuff(raw) + (raw.endsWith(CRLF) ? "" : CRLF) + "." + CRLF);
    await c.expect([250]);
  } finally {
    c.close();
  }
}

async function mxHosts(domain: string): Promise<string[]> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch { /* fall through to A/AAAA fallback below */ }
  return [domain]; // RFC 5321 implicit MX
}

/** Delivers one raw message. Throws SmtpError (permanent flag) or Error (retryable). */
export async function deliverRaw(rcpt: string, raw: string): Promise<string> {
  const envFrom = parseAddress(config.mail.from).email;
  const m = config.mail;
  if (m.transport === "relay") {
    if (!m.relay.host) throw new Error("relay transport selected but SMTP_HOST is not set");
    await deliverTo({ host: m.relay.host, port: m.relay.port, secure: m.relay.secure, auth: m.relay.user ? { user: m.relay.user, pass: m.relay.pass } : undefined }, envFrom, rcpt, raw);
    return m.relay.host;
  }
  if (m.mxOverride) {
    const [host, port] = m.mxOverride.split(":");
    await deliverTo({ host, port: Number(port || m.port) }, envFrom, rcpt, raw);
    return host;
  }
  const domain = rcpt.split("@")[1];
  let last: Error = new Error("no MX hosts");
  for (const host of await mxHosts(domain)) {
    try {
      await deliverTo({ host, port: m.port }, envFrom, rcpt, raw);
      return host;
    } catch (e) {
      last = e as Error;
      if (e instanceof SmtpError && e.permanent) throw e; // do not try other MXes on a 5xx verdict
    }
  }
  throw last;
}

// -------------------------------------------------------------------- queue

const BACKOFF = [60, 300, 1800, 7200, 43200, 86400];

export function sendMail(m: MailInput): string {
  const { raw } = buildMessage(m);
  const signed = dkimSign(raw);
  const id = crypto.randomBytes(10).toString("hex");
  const t = now();
  db.prepare("INSERT INTO outbox (id, to_addr, subject, raw, status, attempts, next_attempt, created) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, m.to, m.subject, signed, "pending", 0, t, t);
  void processOutbox(); // first attempt immediately, retries from the worker
  return id;
}

let running = false;
export async function processOutbox() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt <= ? ORDER BY created LIMIT 20").all(now()) as any[];
    for (const row of due) {
      try {
        let via: string;
        if (config.mail.transport === "file") {
          fs.mkdirSync(config.mail.outboxDir, { recursive: true });
          fs.writeFileSync(path.join(config.mail.outboxDir, `${row.created}-${row.id}.eml`), row.raw);
          via = "file";
        } else {
          via = await deliverRaw(row.to_addr, row.raw);
        }
        db.prepare("UPDATE outbox SET status='sent', attempts=attempts+1, sent_at=?, delivered_via=?, last_error=NULL WHERE id=?").run(now(), via, row.id);
      } catch (e) {
        const attempts = row.attempts + 1;
        const err = String((e as Error).message).slice(0, 300);
        const permanent = e instanceof SmtpError && e.permanent;
        if (permanent || attempts > BACKOFF.length) {
          db.prepare("UPDATE outbox SET status='failed', attempts=?, last_error=? WHERE id=?").run(attempts, err, row.id);
        } else {
          db.prepare("UPDATE outbox SET attempts=?, next_attempt=?, last_error=? WHERE id=?").run(attempts, now() + BACKOFF[attempts - 1], err, row.id);
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startMailWorker() {
  setInterval(() => processOutbox().catch((e) => console.error("mail worker", e)), 5000).unref();
}

/** Looks up the DNS records a receiver will check, so operators can see why mail might be rejected. */
export async function mailDnsStatus() {
  const domain = senderDomain();
  const out: Record<string, unknown> = { domain, transport: config.mail.transport, dkimConfigured: !!config.mail.dkimKey };
  const txt = async (name: string) => (await dns.resolveTxt(name).catch(() => [])).map((r) => r.join(""));
  out.spf = (await txt(domain)).filter((t) => t.startsWith("v=spf1"));
  out.dkim = (await txt(`${config.mail.dkimSelector}._domainkey.${domain}`)).filter((t) => t.includes("v=DKIM1"));
  out.dmarc = (await txt(`_dmarc.${domain}`)).filter((t) => t.startsWith("v=DMARC1"));
  out.mx = await dns.resolveMx(domain).catch(() => []);
  if (config.mail.dkimKey && Array.isArray(out.dkim) && out.dkim.length) {
    try {
      const pub = crypto.createPublicKey(crypto.createPrivateKey(config.mail.dkimKey)).export({ type: "spki", format: "der" }) as Buffer;
      out.dkimMatchesKey = (out.dkim as string[]).some((t) => t.replace(/\s/g, "").includes(pub.toString("base64")));
    } catch { out.dkimMatchesKey = false; }
  }
  return out;
}
