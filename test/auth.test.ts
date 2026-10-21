// Email sign-in end to end: the server's own SMTP client delivers (STARTTLS, DKIM-signed) to a real SMTP sink,
// the test reads the code from the received message, and exercises sessions, CSRF, keys, rate limits and retries.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startSink, verifyDkim, decodeBodies } from "./helpers/smtp-sink.ts";
import { generateDkimKeys } from "../server/mail.ts";

const root = path.resolve(import.meta.dirname, "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
const PORT = 8797;
const API = `http://127.0.0.1:${PORT}`;
const ADMIN = "auth-admin-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess;
let sink: Awaited<ReturnType<typeof startSink>>;
let dbFile: string;
let dkimPub: string;

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j as any, headers: res.headers };
}
const cookieOf = (r: { headers: Headers }) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("addr_session=")) ?? "";

async function waitMsg(to: string, since = 0, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const hit = sink.messages.slice(since).find((m) => m.to.includes(to));
    if (hit) return hit;
    if (Date.now() - t > ms) throw new Error("no mail for " + to);
    await sleep(100);
  }
}
const codeFrom = (raw: string) => /sign-in code is (\d{6})/.exec(decodeBodies(raw).text)![1];

async function signIn(email: string) {
  const n = sink.messages.length;
  const r = await call("POST", "/v1/auth/email", { email });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const msg = await waitMsg(email, n);
  const v = await call("POST", "/v1/auth/verify", { email, code: codeFrom(msg.raw) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const cookie = cookieOf(v);
  const me = (await call("GET", "/v1/auth/me", undefined, { cookie })).body;
  return { cookie, csrf: me.csrf as string, me, v };
}

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addr-auth-"));
  const key = path.join(tmp, "k.pem"), crt = path.join(tmp, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
  sink = await startSink({
    key: fs.readFileSync(key, "utf8"), cert: fs.readFileSync(crt, "utf8"),
    rcptPolicy: (rcpt, attempt) => {
      if (rcpt.startsWith("temp@") && attempt === 1) return { code: 451, msg: "4.7.1 greylisted, try later" };
      if (rcpt.startsWith("perm@")) return { code: 550, msg: "5.1.1 no such user" };
      return null;
    },
  });
  const dk = generateDkimKeys();
  dkimPub = `-----BEGIN PUBLIC KEY-----\n${dk.publicKeyBase64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  dbFile = path.join(tmp, "auth.db");
  server = spawn(tsxBin, ["--no-warnings", path.join(root, "server", "index.ts")], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbFile, ADMIN_TOKEN: ADMIN, INDEX_INTERVAL_MS: "2000",
      MAIL_TRANSPORT: "direct", MAIL_MX_OVERRIDE: `127.0.0.1:${sink.port}`, MAIL_FROM: "ADDR <login@addr.test>",
      DKIM_PRIVATE_KEY: dk.privateKey, DKIM_SELECTOR: "t1", PUBLIC_URL: "http://127.0.0.1:" + PORT,
      ADMIN_EMAILS: "boss@example.test", LOGIN_IP_PER_HOUR: "500", OPERATOR_KEY: "", FREE_SIGNER_KEY: "",
      LEGAL_ENTITY: "", LEGAL_EMAIL: "",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i++) { if (await fetch(API + "/v1/contracts").then((r) => r.ok, () => false)) break; await sleep(250); }
});

after(async () => {
  server?.kill();
  await sink?.close();
});

test("sign-in email is delivered by our own SMTP client over STARTTLS with a valid DKIM signature", async () => {
  const n = sink.messages.length;
  const email = `alice${crypto.randomBytes(3).toString("hex")}@example.test`;
  assert.equal((await call("POST", "/v1/auth/email", { email })).body.sent, true);
  const msg = await waitMsg(email, n);
  assert.equal(msg.tls, true, "delivery must upgrade to TLS when offered");
  assert.equal(msg.from, "login@addr.test");
  const d = decodeBodies(msg.raw);
  assert.match(d.subject, /^Your ADDR sign-in code: \d{6}$/);
  assert.match(d.text, /sign-in code is \d{6}/);
  assert.match(d.html, /auth\/verify\?token=/);
  assert.equal(d.headers.from, "ADDR <login@addr.test>");
  assert.match(d.headers["message-id"], /^<[0-9a-f]{32}@addr\.test>$/);
  const dk = verifyDkim(msg.raw, dkimPub);
  assert.deepEqual({ ok: dk.ok, d: dk.domain, s: dk.selector }, { ok: true, d: "addr.test", s: "t1" }, String(dk.reason));
  // tampering breaks the signature
  assert.equal(verifyDkim(msg.raw.replace(/Subject: .*/, "Subject: forged"), dkimPub).ok, false);
});

test("anyone can sign up; session cookie is HttpOnly, SameSite=Lax; second sign-in reuses the account", async () => {
  const email = `new${crypto.randomBytes(3).toString("hex")}@Example.test`;
  const s1 = await signIn(email.toLowerCase());
  assert.equal(s1.v.body.newAccount, true);
  const setCookie = (s1.v.headers.getSetCookie?.() ?? []).join(";");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal(s1.me.authenticated, true);
  assert.equal(s1.me.user.email, email.toLowerCase());
  assert.equal(s1.me.tenant.plan, "free");
  const s2 = await signIn(email.toLowerCase());
  assert.equal(s2.v.body.newAccount, false);
  assert.equal(s2.me.tenant.id, s1.me.tenant.id);
  assert.equal((await call("GET", "/v1/auth/me")).body.authenticated, false);
});

test("wrong codes are limited, only the newest code works, codes are single use", async () => {
  const email = `try${crypto.randomBytes(3).toString("hex")}@example.test`;
  let n = sink.messages.length;
  await call("POST", "/v1/auth/email", { email });
  const first = codeFrom((await waitMsg(email, n)).raw);
  n = sink.messages.length;
  await call("POST", "/v1/auth/email", { email });
  const second = codeFrom((await waitMsg(email, n)).raw);
  assert.equal((await call("POST", "/v1/auth/verify", { email, code: first })).status, 401);
  const bad = first === second ? "000000" : first;
  let last: any;
  for (let i = 0; i < 6; i++) last = await call("POST", "/v1/auth/verify", { email, code: bad });
  assert.ok([401, 429].includes(last.status));
  assert.equal((await call("POST", "/v1/auth/verify", { email, code: second })).status, 401, "attempt limit invalidates the code");
  // fresh code works exactly once
  n = sink.messages.length;
  await call("POST", "/v1/auth/email", { email });
  const third = codeFrom((await waitMsg(email, n)).raw);
  assert.equal((await call("POST", "/v1/auth/verify", { email, code: third })).status, 200);
  assert.equal((await call("POST", "/v1/auth/verify", { email, code: third })).status, 401);
  assert.equal((await call("POST", "/v1/auth/verify", { email, code: "12345" })).status, 422);
});

test("invalid emails are rejected and per-address sending is rate limited", async () => {
  for (const bad of ["", "nope", "a@b", "a b@example.test", "<x>@example.test", "x@@example.test", 5]) {
    assert.equal((await call("POST", "/v1/auth/email", { email: bad })).status, 422, String(bad));
  }
  const email = `rl${crypto.randomBytes(3).toString("hex")}@example.test`;
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await call("POST", "/v1/auth/email", { email })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
});

test("magic link needs an explicit confirmation POST and is single use", async () => {
  const email = `link${crypto.randomBytes(3).toString("hex")}@example.test`;
  const n = sink.messages.length;
  await call("POST", "/v1/auth/email", { email, next: "/enterprise" });
  const d = decodeBodies((await waitMsg(email, n)).raw);
  const link = /(http:\/\/\S+\/auth\/verify\?token=[^\s]+)/.exec(d.text)![1];
  assert.match(link, /next=%2Fenterprise/);
  // a plain GET (what mail scanners do) must not consume the token or create a session
  const get = await fetch(link, { redirect: "manual" });
  assert.equal(get.status, 200);
  assert.ok(!get.headers.getSetCookie?.().length);
  const token = new URL(link).searchParams.get("token")!;
  const v = await call("POST", "/v1/auth/verify-token", { token });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(cookieOf(v));
  assert.equal((await call("POST", "/v1/auth/verify-token", { token })).status, 401);
});

test("account API keys: session + CSRF required, keys work as bearer tokens, revocation works", async () => {
  const s = await signIn(`keys${crypto.randomBytes(3).toString("hex")}@example.test`);
  assert.equal((await call("GET", "/v1/account/keys")).status, 401, "anonymous cannot manage keys");
  assert.equal((await call("POST", "/v1/account/keys", { label: "x" }, { cookie: s.cookie })).status, 403, "missing CSRF token");
  assert.equal((await call("POST", "/v1/account/keys", { label: "x" }, { cookie: s.cookie, "x-csrf-token": "wrong" })).status, 403);
  assert.equal((await call("POST", "/v1/account/keys", { label: "x" }, { cookie: s.cookie, "x-csrf-token": s.csrf, origin: "https://evil.example" })).status, 403, "cross-origin write");
  const k = await call("POST", "/v1/account/keys", { label: "ci" }, { cookie: s.cookie, "x-csrf-token": s.csrf });
  assert.equal(k.status, 201);
  assert.match(k.body.apiKey, /^addr_live_/);
  const u = await call("GET", "/v1/usage", undefined, { authorization: `Bearer ${k.body.apiKey}` });
  assert.equal(u.status, 200);
  assert.equal(u.body.plan, "free");
  const list = (await call("GET", "/v1/account/keys", undefined, { cookie: s.cookie })).body.keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "ci");
  assert.ok(!JSON.stringify(list).includes(k.body.apiKey), "full key is never listed again");
  assert.equal((await call("DELETE", `/v1/account/keys/${k.body.keyId}`, undefined, { cookie: s.cookie, "x-csrf-token": s.csrf })).status, 200);
  assert.equal((await call("GET", "/v1/usage", undefined, { authorization: `Bearer ${k.body.apiKey}` })).status, 401);
  // another account cannot revoke this account's keys
  const other = await signIn(`other${crypto.randomBytes(3).toString("hex")}@example.test`);
  const k2 = await call("POST", "/v1/account/keys", {}, { cookie: s.cookie, "x-csrf-token": s.csrf });
  assert.equal((await call("DELETE", `/v1/account/keys/${k2.body.keyId}`, undefined, { cookie: other.cookie, "x-csrf-token": other.csrf })).status, 404);
  // there is no anonymous key creation any more
  assert.equal((await call("POST", "/v1/keys", {})).status, 404);
});

test("logout (single and everywhere) ends sessions", async () => {
  const email = `out${crypto.randomBytes(3).toString("hex")}@example.test`;
  const a = await signIn(email);
  const b = await signIn(email);
  assert.equal((await call("POST", "/v1/auth/logout", {}, { cookie: a.cookie, "x-csrf-token": a.csrf })).status, 200);
  assert.equal((await call("GET", "/v1/auth/me", undefined, { cookie: a.cookie })).body.authenticated, false);
  assert.equal((await call("GET", "/v1/auth/me", undefined, { cookie: b.cookie })).body.authenticated, true);
  await call("POST", "/v1/auth/logout", { all: true }, { cookie: b.cookie, "x-csrf-token": b.csrf });
  assert.equal((await call("GET", "/v1/auth/me", undefined, { cookie: b.cookie })).body.authenticated, false);
});

test("admin console accepts an admin-listed email session or the token; others are refused", async () => {
  const boss = await signIn("boss@example.test");
  assert.equal(boss.me.isAdmin, true);
  assert.equal((await call("GET", "/v1/admin/stats", undefined, { cookie: boss.cookie })).status, 200);
  const user = await signIn(`reg${crypto.randomBytes(3).toString("hex")}@example.test`);
  assert.equal(user.me.isAdmin, false);
  assert.equal((await call("GET", "/v1/admin/stats", undefined, { cookie: user.cookie })).status, 403);
  assert.equal((await call("GET", "/v1/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` })).status, 200);
});

test("mail queue: temporary failures are retried, permanent failures are recorded, status is visible to admins", async () => {
  const tmpEmail = `temp@example.test`;
  const n = sink.messages.length;
  assert.equal((await call("POST", "/v1/auth/email", { email: tmpEmail })).status, 200); // greylisted first (451)
  await sleep(1200);
  assert.ok(!sink.messages.slice(n).some((m) => m.to.includes(tmpEmail)), "first attempt was deferred");
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE outbox SET next_attempt = 0 WHERE to_addr = ? AND status = 'pending'").run(tmpEmail);
  const msg = await waitMsg(tmpEmail, n, 15000); // the worker retries within 5 s
  assert.ok(codeFrom(msg.raw));
  await call("POST", "/v1/auth/email", { email: "perm@example.test" }); // 550: never retried
  await sleep(1500);
  const rows = db.prepare("SELECT status, attempts, last_error FROM outbox WHERE to_addr = ?").all("perm@example.test") as any[];
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].last_error, /550/);
  db.close();
  const mail = await call("GET", "/v1/admin/mail", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(mail.status, 200);
  assert.equal(mail.body.dns.domain, "addr.test");
  assert.equal(mail.body.dns.dkimConfigured, true);
  assert.ok(mail.body.outbox.some((o: any) => o.status === "sent"));
});

test("SPA serves client routes with dotted names and /dev", async () => {
  for (const p of ["/dev", "/names", "/name/heelo.addr", "/auth/verify?token=abc"]) {
    const r = await fetch(API + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type") || "", /text\/html/, p);
  }
});

test("legal info endpoint, abuse reports and admin triage", async () => {
  const legal = await call("GET", "/v1/legal");
  assert.equal(legal.status, 200);
  assert.equal(legal.body.jurisdiction, "Republic of Korea");
  assert.ok(legal.body.retentionDays.loginCodes > 0);
  assert.equal(legal.body.configured, false); // no operator identity configured in the test server
  assert.equal((await call("POST", "/v1/reports", { category: "nonsense", details: "x" })).status, 422);
  assert.equal((await call("POST", "/v1/reports", { category: "scam", details: "" })).status, 422);
  const r = await call("POST", "/v1/reports", { category: "impersonation", name: "paypa1.addr", details: "Pretends to be PayPal", contact: "me@example.test" });
  assert.equal(r.status, 201);
  assert.equal((await call("GET", "/v1/admin/reports")).status, 403);
  const list = (await call("GET", "/v1/admin/reports", undefined, { authorization: `Bearer ${ADMIN}` })).body.reports;
  assert.ok(list.find((x: any) => x.id === r.body.id && x.name === "paypa1.addr" && x.status === "open"));
  assert.equal((await call("PATCH", `/v1/admin/reports/${r.body.id}`, { status: "closed", note: "warned owner" }, { authorization: `Bearer ${ADMIN}` })).status, 200);
  for (let i = 0; i < 5; i++) await call("POST", "/v1/reports", { category: "other", details: "spam" });
  assert.equal((await call("POST", "/v1/reports", { category: "other", details: "spam" })).status, 429);
});

test("account export and deletion (data rights)", async () => {
  const email = `gone${crypto.randomBytes(3).toString("hex")}@example.test`;
  const s = await signIn(email);
  const h = { cookie: s.cookie, "x-csrf-token": s.csrf };
  const key = await call("POST", "/v1/account/keys", { label: "k" }, h);
  assert.equal(key.status, 201);
  assert.equal((await call("GET", "/v1/account/export")).status, 401);
  const exp = (await call("GET", "/v1/account/export", undefined, { cookie: s.cookie })).body;
  assert.equal(exp.user.email, email);
  assert.equal(exp.apiKeys.length, 1);
  assert.ok(!JSON.stringify(exp).includes(key.body.apiKey), "export never contains the secret key");
  // deletion needs the exact email
  assert.equal((await call("POST", "/v1/account/delete", { email: "other@example.test" }, h)).status, 422);
  assert.equal((await call("POST", "/v1/account/delete", {}, h)).status, 422);
  const del = await call("POST", "/v1/account/delete", { email }, h);
  assert.equal(del.status, 200);
  assert.equal((await call("GET", "/v1/auth/me", undefined, { cookie: s.cookie })).body.authenticated, false);
  assert.equal((await call("GET", "/v1/usage", undefined, { authorization: `Bearer ${key.body.apiKey}` })).status, 401, "keys die with the account");
  const db = new DatabaseSync(dbFile);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = ?").get(email) as any).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM login_codes WHERE email = ?").get(email) as any).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE to_addr = ?").get(email) as any).c, 0);
  db.close();
  // the same email can sign up again as a brand new account
  const again = await signIn(email);
  assert.equal(again.v.body.newAccount, true);
});

test("retention job removes data past the published periods and blanks old mail bodies", async () => {
  const db = new DatabaseSync(dbFile);
  const old = Math.floor(Date.now() / 1000) - 400 * 86400;
  db.prepare("INSERT INTO login_codes (id, email, code_hash, token_hash, created, expires) VALUES ('old1','o@example.test','h','t-old-1',?,?)").run(old, old + 600);
  db.prepare("INSERT INTO rate_events (bucket, ts) VALUES ('login:ip:old', ?)").run(old);
  db.prepare("INSERT INTO outbox (id, to_addr, subject, raw, status, attempts, next_attempt, created, sent_at) VALUES ('oldmail','o@example.test','s','SECRET BODY','sent',1,0,?,?)").run(old, old);
  db.prepare("INSERT INTO usage (subject, day, count) VALUES ('ip:abc', '2020-01-01', 5)").run();
  const fresh = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO rate_events (bucket, ts) VALUES ('login:ip:new', ?)").run(fresh);
  const r = await call("POST", "/v1/admin/retention/run", {}, { authorization: `Bearer ${ADMIN}` });
  assert.equal(r.status, 200);
  assert.ok(r.body.loginCodes >= 1 && r.body.rateEvents >= 1 && r.body.ipUsage >= 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM login_codes WHERE id = 'old1'").get() as any).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE id = 'oldmail'").get() as any).c, 0); // older than the log period: gone
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM rate_events WHERE bucket = 'login:ip:new'").get() as any).c, 1, "recent data is kept");
  db.prepare("INSERT INTO outbox (id, to_addr, subject, raw, status, attempts, next_attempt, created, sent_at) VALUES ('mid','o@example.test','s','SECRET BODY','sent',1,0,?,?)").run(fresh - 20 * 86400, fresh - 20 * 86400);
  await call("POST", "/v1/admin/retention/run", {}, { authorization: `Bearer ${ADMIN}` });
  const mid = db.prepare("SELECT raw FROM outbox WHERE id = 'mid'").get() as any;
  assert.equal(mid.raw, "", "bodies (which contain one-time codes) are blanked after the body period");
  db.close();
});
