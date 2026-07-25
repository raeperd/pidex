import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wsClientMessageSchema } from "@pidex/api";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { WebSocketServer, type RawData } from "ws";
import { ChatManager } from "./chat-manager.js";
import { createRpcApiRouter } from "./http-api.js";
import { MetadataStore } from "./metadata.js";
import { PiSdk } from "./pi-sdk.js";
import {
  allowedRoots,
  HttpError,
  parsePort,
  safeError,
  securityHeaders,
  validateRequest,
} from "./security.js";

export async function createPidexServer() {
  const csrf = randomBytes(32).toString("base64url");
  const roots = await allowedRoots();
  const metadata = new MetadataStore();
  const pi = new PiSdk();
  const manager = new ChatManager(pi, metadata);
  const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
  const apiHandler = new RPCHandler(createRpcApiRouter({ csrf, roots, metadata, pi, manager }), {
    plugins: [new BodyLimitPlugin({ maxBodySize: 64 * 1024 })],
  });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res);
    try {
      validateRequest(req, false, csrf);
      const route = new URL(req.url ?? "/", "http://localhost").pathname;
      const { matched } = await apiHandler.handle(req, res, {
        prefix: "/api/rpc",
        context: { req },
      });
      if (matched) return;
      if (route.startsWith("/api/")) throw new HttpError(404, "API route not found", "not_found");
      serveWebApp(req, res, route, webRoot);
    } catch (error) {
      if (res.headersSent) return res.end();
      const protocolError = error instanceof HttpError ? error : undefined;
      json(res, protocolError?.status ?? 500, {
        error: { code: protocolError?.code ?? "internal_error", message: safeError(error) },
      });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    try {
      validateRequest(req, false, csrf);
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/api/ws")
        throw new HttpError(404, "WebSocket route not found");
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  wss.on("connection", (socket) => {
    let connected = false;
    let alive = true;
    socket.on("message", (data) => {
      const message = parseClientMessage(data);
      if (!message) return socket.close(1008, "Invalid protocol message");
      if (!connected && message.type !== "hello") return socket.close(1008, "Hello required");
      if (message.type === "hello") {
        if (connected) return socket.close(1008, "Already connected");
        connected = true;
        try {
          manager.connect(manager.chat(message.chatId), socket, message.lastEventId);
        } catch {
          socket.close(1008, "Chat not found");
        }
      } else if (message.type === "pong") alive = true;
    });
    const timer = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
    socket.once("close", () => clearInterval(timer));
  });

  return {
    server,
    close: async () => {
      for (const socket of wss.clients) socket.close(1001, "Server stopping");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      manager.shutdown();
      metadata.close();
    },
    manager,
  };
}

function serveWebApp(_req: IncomingMessage, res: ServerResponse, route: string, webRoot: string) {
  if (!existsSync(webRoot))
    throw new HttpError(503, "Web build is missing; run pnpm build", "web_build_missing");
  const requested = route === "/" ? "index.html" : route.slice(1);
  let file = path.resolve(webRoot, requested);
  if (!file.startsWith(`${webRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile())
    file = path.join(webRoot, "index.html");
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(file));
  res.setHeader(
    "Cache-Control",
    file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  );
  createReadStream(file).pipe(res);
}

function parseClientMessage(data: RawData) {
  try {
    const result = wsClientMessageSchema.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function contentTypeFor(file: string) {
  switch (path.extname(file).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function main() {
  const port = parsePort();
  const app = await createPidexServer();
  app.server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE")
      console.error(`Pidex cannot start: 127.0.0.1:${port} is already in use.`);
    else console.error(`Pidex cannot start: ${safeError(error)}`);
    process.exitCode = 1;
  });
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`Pidex ready at http://127.0.0.1:${port}`),
  );
  const stop = () => void app.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(`Pidex cannot start: ${safeError(error)}`);
    process.exit(1);
  });
