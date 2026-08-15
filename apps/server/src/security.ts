import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { applicationError, ConfigurationError, HttpError } from "./errors.js";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parsePort(value = process.env.PORT): number {
  if (value === undefined || value === "") return 4783;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1024 || port > 65535)
    throw ConfigurationError.make({
      message: "PORT must be an integer from 1024 through 65535",
    });
  return port;
}

export const allowedRoots = Effect.fn("security.allowedRoots")(function* () {
  const configured = process.env.WORKSPACE_ROOTS?.split(path.delimiter).filter(Boolean) ?? [
    os.homedir(),
  ];
  return yield* Effect.forEach(
    configured,
    (root) =>
      Effect.tryPromise({
        try: () => realpath(root),
        catch: (cause) => applicationError("workspace-roots.resolve", cause),
      }),
    { concurrency: "unbounded" },
  );
});

export const canonicalWorkspace = Effect.fn("security.canonicalWorkspace")(function* (
  candidate: string,
  roots: string[],
) {
  const canonical = yield* Effect.tryPromise({
    try: () => realpath(candidate),
    catch: () =>
      HttpError.make({
        status: 404,
        code: "workspace_missing",
        message: "Project directory does not exist",
      }),
  });
  const details = yield* Effect.tryPromise({
    try: () => stat(canonical),
    catch: (cause) => applicationError("workspace.stat", cause),
  });
  if (!details.isDirectory())
    return yield* Effect.fail(
      HttpError.make({
        status: 400,
        code: "workspace_not_directory",
        message: "Project path is not a directory",
      }),
    );
  if (!roots.some((root) => isDescendant(root, canonical)))
    return yield* Effect.fail(
      HttpError.make({
        status: 403,
        code: "workspace_forbidden",
        message: "Project is outside WORKSPACE_ROOTS",
      }),
    );
  return canonical;
});

export const validateRequest = Effect.fn("security.validateRequest")(function* (
  req: IncomingMessage,
) {
  const rawHost = req.headers.host;
  if (!rawHost)
    return yield* Effect.fail(
      HttpError.make({ status: 400, code: "bad_host", message: "Missing Host header" }),
    );
  const { requestUrl, hostname } = yield* parseRequestHost(rawHost);
  const tailscaleHost = process.env.PIDEX_TAILSCALE_HOST?.toLowerCase();
  if (!loopbackHosts.has(hostname.toLowerCase()) && hostname.toLowerCase() !== tailscaleHost)
    return yield* Effect.fail(
      HttpError.make({ status: 403, code: "bad_host", message: "Host is not allowed" }),
    );
  if (req.headers["sec-fetch-site"] === "cross-site")
    return yield* Effect.fail(
      HttpError.make({
        status: 403,
        code: "cross_site",
        message: "Cross-site requests are not allowed",
      }),
    );
  const origin = req.headers.origin;
  if (origin) {
    const parsed = yield* parseOrigin(origin);
    const loopback = loopbackHosts.has(hostname.toLowerCase());
    const requestPort = requestUrl.port || (loopback ? "80" : "443");
    const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const originAllowed =
      parsed.hostname.toLowerCase() === hostname.toLowerCase() &&
      originPort === requestPort &&
      ((loopback && parsed.protocol === "http:") ||
        (hostname.toLowerCase() === tailscaleHost && parsed.protocol === "https:"));
    if (!originAllowed)
      return yield* Effect.fail(
        HttpError.make({ status: 403, code: "bad_origin", message: "Origin is not allowed" }),
      );
  }
});

export function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
export function securityHeaders(res: ServerResponse, scriptHashes: string[] = []) {
  const allowedScripts = ["'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`)].join(" ");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss:; font-src 'self' data:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src ${allowedScripts}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return message
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[redacted]",
    )
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(
      /((?:["']?[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)[\w-]*["']?)\s*[:=]\s*["']?)[^\s"',;}{]{8,}/gi,
      "$1[redacted]",
    )
    .slice(0, 1000);
}

function parseRequestHost(
  rawHost: string,
): Effect.Effect<{ requestUrl: URL; hostname: string }, HttpError> {
  return Effect.try({
    try: () => {
      const requestUrl = new URL(`http://${rawHost}`);
      return { requestUrl, hostname: requestUrl.hostname };
    },
    catch: () => HttpError.make({ status: 400, code: "bad_host", message: "Invalid Host header" }),
  });
}

function parseOrigin(origin: string): Effect.Effect<URL, HttpError> {
  return Effect.try({
    try: () => new URL(origin),
    catch: () => HttpError.make({ status: 403, code: "bad_origin", message: "Invalid Origin" }),
  });
}
