// A real SMTP receiving server (RFC 5321 subset: EHLO, STARTTLS, MAIL, RCPT, DATA, RSET, QUIT) used to test the
// outbound mail stack over the actual wire protocol. It records every message it accepts.
import net from "node:net";
import tls from "node:tls";

export interface Received { from: string; to: string[]; raw: string; tls: boolean }
export interface SinkOptions {
  key?: string; cert?: string;                     // enables STARTTLS when both are set
  rcptPolicy?: (rcpt: string, attempt: number) => { code: number; msg: string } | null;
}

export async function startSink(opts: SinkOptions = {}) {
  const messages: Received[] = [];
  const rcptAttempts = new Map<string, number>();
  const server = net.createServer((raw) => {
    let sock: net.Socket | tls.TLSSocket = raw;
    let secure = false;
    let buf = "";
    let from = "";
    let to: string[] = [];
    let inData = false;
    let data = "";
    const send = (s: string) => sock.write(s + "\r\n");
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) break; // keep buffering until the terminator arrives
          data = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          const body = data.split("\r\n").map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
          messages.push({ from, to: [...to], raw: body, tls: secure });
          data = ""; from = ""; to = [];
          send("250 2.0.0 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) {
          const caps = ["250-sink.test greets you", "250-8BITMIME"];
          if (opts.key && opts.cert && !secure) caps.push("250-STARTTLS");
          caps.push("250 SIZE 10485760");
          caps.forEach(send);
        } else if (up === "STARTTLS" && opts.key && opts.cert && !secure) {
          send("220 2.0.0 ready to start TLS");
          const plain = sock as net.Socket;
          plain.removeListener("data", onData);
          const t = new tls.TLSSocket(plain, { isServer: true, key: opts.key, cert: opts.cert });
          sock = t; secure = true; buf = "";
          t.on("data", onData);
          t.on("error", () => {});
        } else if (up.startsWith("MAIL FROM:")) {
          from = line.slice(10).replace(/[<>\s]/g, ""); send("250 2.1.0 ok");
        } else if (up.startsWith("RCPT TO:")) {
          const r = line.slice(8).replace(/[<>\s]/g, "");
          const n = (rcptAttempts.get(r) ?? 0) + 1; rcptAttempts.set(r, n);
          const verdict = opts.rcptPolicy?.(r, n);
          if (verdict) send(`${verdict.code} ${verdict.msg}`); else { to.push(r); send("250 2.1.5 ok"); }
        } else if (up === "DATA") {
          if (!to.length) send("503 5.5.1 need RCPT first"); else { inData = true; data = ""; send("354 end with <CRLF>.<CRLF>"); }
        } else if (up === "RSET") { from = ""; to = []; send("250 ok"); }
        else if (up === "QUIT") { send("221 bye"); sock.end(); return; }
        else send("502 5.5.2 unrecognized");
      }
    };
    raw.on("data", onData);
    raw.on("error", () => {});
    send("220 sink.test ESMTP ready");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((r) => server.close(() => r())), rcptAttempts };
}

/** Independent DKIM verifier (RFC 6376 relaxed/relaxed, rsa-sha256) used to check what the server signed. */
import crypto from "node:crypto";
export function verifyDkim(raw: string, publicKeyPem: string): { ok: boolean; reason?: string; domain?: string; selector?: string } {
  const idx = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, idx);
  const body = raw.slice(idx + 4);
  const unfolded = head.replace(/\r\n([ \t])/g, "$1").split("\r\n");
  const hdrs: [string, string][] = unfolded.map((l) => { const c = l.indexOf(":"); return [l.slice(0, c), l.slice(c + 1)]; });
  const sigHdr = hdrs.find(([n]) => n.toLowerCase() === "dkim-signature");
  if (!sigHdr) return { ok: false, reason: "no DKIM-Signature" };
  const tags = Object.fromEntries(sigHdr[1].split(";").map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).replace(/\s+/g, "")]; }));
  const relaxedBody = (() => {
    const lines = body.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length ? lines.join("\r\n") + "\r\n" : "";
  })();
  const bh = crypto.createHash("sha256").update(relaxedBody).digest("base64");
  if (bh !== tags.bh) return { ok: false, reason: "body hash mismatch" };
  const rh = (n: string, v: string) => n.toLowerCase() + ":" + v.replace(/[ \t]+/g, " ").trim() + "\r\n";
  let data = "";
  for (const name of tags.h.split(":")) {
    const found = [...hdrs].reverse().find(([n]) => n.toLowerCase() === name);
    if (found) data += rh(found[0], found[1]);
  }
  const sigValueNoB = sigHdr[1].replace(/(;\s*b=)[^;]*$/, "$1");
  data += rh("DKIM-Signature", sigValueNoB).slice(0, -2);
  const ok = crypto.verify("sha256", Buffer.from(data), publicKeyPem, Buffer.from(tags.b, "base64"));
  return { ok, reason: ok ? undefined : "signature mismatch", domain: tags.d, selector: tags.s };
}

/** Decodes a message built by the server (base64 text parts). */
export function decodeBodies(raw: string): { text: string; html: string; subject: string; headers: Record<string, string> } {
  const idx = raw.indexOf("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const l of raw.slice(0, idx).replace(/\r\n([ \t])/g, "$1").split("\r\n")) { const c = l.indexOf(":"); headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim(); }
  const body = raw.slice(idx + 4);
  const parts = body.split(/--=_addr_[0-9a-f]+(?:--)?\r\n?/).filter((p) => p.trim());
  const dec = (p: string) => Buffer.from(p.slice(p.indexOf("\r\n\r\n") + 4).replace(/\s+/g, ""), "base64").toString("utf8");
  let text = "", html = "";
  for (const p of parts) { if (/text\/plain/.test(p)) text = dec(p); else if (/text\/html/.test(p)) html = dec(p); }
  const subj = headers.subject?.startsWith("=?UTF-8?B?") ? Buffer.from(headers.subject.slice(10, -2), "base64").toString("utf8") : headers.subject;
  return { text, html, subject: subj, headers };
}
