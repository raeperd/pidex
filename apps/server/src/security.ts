import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error { constructor(readonly status: number, message: string, readonly code = "bad_request") { super(message); } }
export function parsePort(value = process.env.PORT): number {
  if (value === undefined || value === "") return 4783;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer from 1024 through 65535");
  const port = Number(value); if (port < 1024 || port > 65535) throw new Error("PORT must be an integer from 1024 through 65535"); return port;
}
export async function allowedRoots(): Promise<string[]> {
  const configured = process.env.WORKSPACE_ROOTS?.split(path.delimiter).filter(Boolean) ?? [os.homedir()];
  return Promise.all(configured.map((root) => realpath(root)));
}
export function isDescendant(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
export async function canonicalWorkspace(candidate: string, roots: string[]): Promise<string> {
  let canonical: string; try { canonical = await realpath(candidate); } catch { throw new HttpError(404, "Project directory does not exist", "workspace_missing"); }
  if (!roots.some((root) => isDescendant(root, canonical))) throw new HttpError(403, "Project is outside WORKSPACE_ROOTS", "workspace_forbidden");
  return canonical;
}
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function validateRequest(req: IncomingMessage, mutation: boolean, csrf: string): void {
  const rawHost = req.headers.host; if (!rawHost) throw new HttpError(400, "Missing Host header", "bad_host");
  let hostname: string; try { hostname = new URL(`http://${rawHost}`).hostname; } catch { throw new HttpError(400, "Invalid Host header", "bad_host"); }
  const tailscaleHost = process.env.PIDEX_TAILSCALE_HOST?.toLowerCase();
  if (!loopbackHosts.has(hostname.toLowerCase()) && hostname.toLowerCase() !== tailscaleHost) throw new HttpError(403, "Host is not allowed", "bad_host");
  if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site requests are not allowed", "cross_site");
  const origin = req.headers.origin;
  if (origin) {
    let parsed: URL; try { parsed = new URL(origin); } catch { throw new HttpError(403, "Invalid Origin", "bad_origin"); }
    const originAllowed = loopbackHosts.has(parsed.hostname.toLowerCase()) || (tailscaleHost !== undefined && parsed.protocol === "https:" && parsed.hostname.toLowerCase() === tailscaleHost);
    if (!originAllowed) throw new HttpError(403, "Origin is not allowed", "bad_origin");
  }
  if (mutation && req.headers["x-pidex-csrf"] !== csrf) throw new HttpError(403, "Invalid CSRF token", "csrf");
}
export function securityHeaders(res: ServerResponse) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 64 * 1024) throw new HttpError(413, "Request body is too large", "body_too_large"); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Malformed JSON", "invalid_json"); }
}
export function safeError(error: unknown) { const message = error instanceof Error ? error.message : "Unexpected error"; return message.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[redacted]").slice(0, 1000); }
