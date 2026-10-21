import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AddrError } from "../packages/core/src/index.ts";
import { authenticate, countError, meter, type Principal } from "./auth.ts";
import { config } from "./config.ts";
import { db, now } from "./db.ts";

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  principal: Principal;
}

type Handler = (c: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean }

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler, opts: { auth?: boolean } = {}) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
}

const MAX_BODY = 512 * 1024;

async function readBody(req: http.IncomingMessage): Promise<any> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new AddrError("payload_too_large", "request body too large", 413);
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AddrError("invalid_json", "body must be valid JSON", 400); }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon", ".yaml": "text/yaml; charset=utf-8",
};

function serveStatic(dir: string, rel: string, res: http.ServerResponse): boolean {
  const base = path.resolve(dir);
  let target = path.resolve(base, "." + path.sep + decodeURIComponent(rel));
  if (!target.startsWith(base)) return false;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const json = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-api-key, idempotency-key",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-expose-headers": "x-ratelimit-limit, x-ratelimit-remaining",
    "cache-control": "no-store",
    ...SEC_HEADERS,
    ...extra,
  });
  res.end(json);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type, x-api-key, idempotency-key",
          "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (!url.pathname.startsWith("/v1/")) {
        if (url.pathname === "/robots.txt") {
          const base = config.publicUrl || `http://${req.headers.host || config.host}`;
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", ...SEC_HEADERS });
          return res.end(`User-agent: *\nAllow: /\nDisallow: /dev\nDisallow: /enterprise\nDisallow: /admin\nDisallow: /login\nDisallow: /auth/verify\nDisallow: /invoice/\n\nSitemap: ${base}/sitemap.xml\n`);
        }
        if (url.pathname === "/sitemap.xml") {
          const base = config.publicUrl || `http://${req.headers.host || config.host}`;
          const paths = ["/", "/names", "/send", "/legal/terms", "/legal/privacy", "/legal/privacy-ko", "/legal/acceptable-use", "/legal/refunds", "/legal/risks", "/legal/name-policy", "/legal/cookies", "/legal/report"];
          const urls = paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
          res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600", ...SEC_HEADERS });
          return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
        }
        if (url.pathname === "/openapi.json") {
          if (serveStatic(path.join(config.root, "docs"), "openapi.json", res)) return;
          return send(res, 404, { error: { code: "not_found", message: "not found" } });
        }
        if (url.pathname.startsWith("/docs")) {
          const rel = url.pathname.replace(/^\/docs\/?/, "") || "index.md";
          if (serveStatic(path.join(config.root, "docs"), rel, res)) return;
        }
        const web = path.join(config.root, "web", "dist");
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (serveStatic(web, rel, res)) return;
        // SPA fallback: any path that is not a known static asset type is a client route (names contain dots: x.addr)
        if (!/\.(js|css|map|png|jpg|svg|ico|json|txt|woff2?)$/.test(url.pathname) && serveStatic(web, "index.html", res)) return;
        return send(res, 404, { error: { code: "not_found", message: "not found" } });
      }

      let matched: Route | undefined;
      let params: Record<string, string> = {};
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        matched = r;
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        break;
      }
      if (!matched) {
        return send(res, methodMismatch ? 405 : 404, { error: { code: methodMismatch ? "method_not_allowed" : "not_found", message: "no such endpoint" } });
      }
      const principal = authenticate(req);
      const usage = meter(principal);
      const body = await readBody(req);
      try {
        const out = await matched.handler({ req, res, url, params, query: url.searchParams, body, principal });
        if (res.writableEnded) return;
        const status = (out as any)?.__status as number | undefined;
        const payload = status ? (out as any).body : out;
        send(res, status ?? 200, payload ?? { ok: true }, {
          "x-ratelimit-limit": String(usage.limit), "x-ratelimit-remaining": String(Math.max(0, usage.limit - usage.used)),
        });
      } catch (e) {
        countError(principal);
        throw e;
      }
    } catch (e) {
      if (e instanceof AddrError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      const msg = (e as Error)?.message || "internal error";
      if (/invalid (address|BytesLike|hex)|bad address|bad checksum/i.test(msg)) return send(res, 422, { error: { code: "invalid_input", message: msg } });
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`, e);
      send(res, 500, { error: { code: "internal_error", message: "internal error" } });
    }
  });
}

export const created = (body: unknown) => ({ __status: 201, body });

/** Replays the stored response for a repeated Idempotency-Key; rejects reuse with a different request. */
export async function idempotent(c: Ctx, tenantId: string, fn: () => Promise<unknown>): Promise<unknown> {
  const key = c.req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) return fn();
  if (key.length > 128) throw new AddrError("invalid_idempotency_key", "Idempotency-Key too long", 400);
  const fp = c.req.method + c.url.pathname + JSON.stringify(c.body ?? null);
  const row = db.prepare("SELECT * FROM idempotency WHERE tenant_id = ? AND key = ?").get(tenantId, key) as any;
  if (row) {
    if (row.fingerprint !== fp) throw new AddrError("idempotency_conflict", "this Idempotency-Key was used with a different request", 422);
    const stored = JSON.parse(row.body);
    return row.status === 200 ? stored : { __status: row.status, body: stored };
  }
  const out = await fn();
  const status = (out as any)?.__status ?? 200;
  const body = (out as any)?.__status ? (out as any).body : out;
  db.prepare("INSERT OR IGNORE INTO idempotency (tenant_id, key, fingerprint, status, body, created) VALUES (?,?,?,?,?,?)")
    .run(tenantId, key, fp, status, JSON.stringify(body), now());
  return out;
}
