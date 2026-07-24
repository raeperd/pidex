import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
  abortRequestSchema,
  acknowledgeInterruptedRequestSchema,
  actionRequestSchema,
  compactRequestSchema,
  configRequestSchema,
  createChatSchema,
  dialogResponseSchema,
  messageRequestSchema,
  openWorkspaceSchema,
  PROTOCOL_VERSION,
  renameRequestSchema,
  resumeChatSchema,
  wsClientMessageSchema,
  trustWorkspaceSchema,
} from "@pidex/api";
import type { Bootstrap, Health } from "@pidex/api";
import type { ZodType } from "zod";
import { ChatManager } from "./chat-manager.js";
import { FakePiAdapter } from "./fake-adapter.js";
import { ActionProtocolError, MetadataStore, requestDigest } from "./metadata.js";
import { discoverProjectCandidates } from "./project-catalog.js";
import { RealPiAdapter } from "./real-adapter.js";
import {
  allowedRoots,
  canonicalWorkspace,
  HttpError,
  parsePort,
  readJson,
  safeError,
  securityHeaders,
  validateRequest,
} from "./security.js";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
};
const parse = async <T>(req: IncomingMessage, schema: ZodType<T>) => {
  const result = schema.safeParse(await readJson(req));
  if (!result.success) throw new HttpError(400, "Request validation failed", "validation");
  return result.data;
};
const mutation = (method?: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
const mime = (file: string) =>
  file.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : file.endsWith(".css")
      ? "text/css; charset=utf-8"
      : file.endsWith(".svg")
        ? "image/svg+xml"
        : "text/html; charset=utf-8";

export async function createPidexServer() {
  const csrf = randomBytes(32).toString("base64url");
  const roots = await allowedRoots();
  const metadata = new MetadataStore();
  const adapter = process.env.PIDEX_ADAPTER === "fake" ? new FakePiAdapter() : new RealPiAdapter();
  const manager = new ChatManager(adapter, metadata);
  const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res);
    try {
      validateRequest(req, mutation(req.method), csrf);
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;
      if (req.method === "GET" && route === "/api/health") {
        const health: Health = {
          ok: true,
          adapter: adapter.name,
          protocolVersion: PROTOCOL_VERSION,
        };
        return json(res, 200, health);
      }
      if (req.method === "GET" && route === "/api/bootstrap") {
        const bootstrap: Bootstrap = {
          protocolVersion: PROTOCOL_VERSION,
          csrfToken: csrf,
          adapter: adapter.name,
          piVersion: adapter.name === "real" ? "0.80.10" : "fake",
          recentWorkspaces: metadata.recent(),
          projectCandidates: await discoverProjectCandidates(roots),
          warning: "Pi runs with your host user permissions and has no built-in sandbox.",
        };
        return json(res, 200, bootstrap);
      }
      if (req.method === "POST" && route === "/api/workspaces/open") {
        const body = await parse(req, openWorkspaceSchema);
        const canonical = await canonicalWorkspace(body.path, roots);
        const id =
          body.remember === false
            ? (metadata.workspaceId(canonical) ?? metadata.rememberWorkspace(canonical))
            : metadata.rememberWorkspace(canonical);
        return json(res, 200, await manager.openWorkspace(id, canonical));
      }
      let match = route.match(/^\/api\/workspaces\/([A-Za-z0-9_-]+)\/sessions$/);
      if (req.method === "GET" && match?.[1])
        return json(res, 200, { sessions: await manager.refreshSessions(match[1]) });
      match = route.match(/^\/api\/workspaces\/([A-Za-z0-9_-]+)\/trust$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, trustWorkspaceSchema);
        const record = manager.workspace(match[1]);
        await adapter.setWorkspaceTrust(record.path, body.trusted);
        return json(res, 200, await manager.openWorkspace(record.id, record.path));
      }
      if (req.method === "POST" && route === "/api/chats") {
        const body = await parse(req, createChatSchema);
        return json(res, 201, manager.snapshot(await manager.create(body.workspaceId)));
      }
      if (req.method === "POST" && route === "/api/chats/resume") {
        const body = await parse(req, resumeChatSchema);
        return json(
          res,
          200,
          manager.snapshot(await manager.resume(body.workspaceId, body.sessionId)),
        );
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/);
      if (req.method === "GET" && match?.[1])
        return json(res, 200, manager.snapshot(manager.chat(match[1])));
      if (req.method === "DELETE" && match?.[1]) {
        manager.dispose(manager.chat(match[1]));
        return json(res, 200, { ok: true });
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, messageRequestSchema);
        const chat = manager.chat(match[1]);
        const input = {
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          requestDigest: requestDigest({
            text: body.text,
            delivery: body.delivery,
            runId: body.runId ?? null,
          }),
        };
        if (body.delivery === "normal") {
          const outcome = metadata.acceptPrompt(input);
          manager.startPrompt(chat, body.text, outcome);
          return json(res, 202, outcome);
        }
        if (!body.runId)
          throw new HttpError(
            400,
            "An active run ID is required for queued instructions",
            "validation",
          );
        const outcome = metadata.acceptRunMutation({
          ...input,
          runId: body.runId,
          kind: body.delivery,
        });
        return json(
          res,
          202,
          await manager.deliverDuringRun(chat, body.text, body.delivery, outcome),
        );
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/abort$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, abortRequestSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acceptStop({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          runId: body.runId,
          requestDigest: requestDigest({ runId: body.runId }),
        });
        return json(res, 202, await manager.abort(chat, outcome));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/interrupted\/acknowledge$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, acknowledgeInterruptedRequestSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acknowledgeInterrupted({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          requestDigest: requestDigest({ acknowledge: chat.run?.runId ?? null }),
        });
        manager.acknowledgeInterrupted(chat, outcome);
        return json(res, 200, outcome);
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/tools\/([A-Za-z0-9_-]+)$/);
      if (req.method === "GET" && match?.[1] && match[2]) {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "16384");
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
          throw new HttpError(400, "Tool output range is invalid", "validation");
        return json(res, 200, manager.toolOutput(manager.chat(match[1]), match[2], offset, limit));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/transcript$/);
      if (req.method === "GET" && match?.[1]) {
        const before = Number(url.searchParams.get("before") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (
          !Number.isInteger(before) ||
          before < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new HttpError(400, "Transcript range is invalid", "validation");
        return json(res, 200, manager.transcriptPage(manager.chat(match[1]), before, limit));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/queue$/);
      if (req.method === "DELETE" && match?.[1]) {
        const body = await parse(req, actionRequestSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acceptSessionMutation({
          ...body,
          sessionKey: chat.sessionKey,
          kind: "clear-queue",
          requestDigest: requestDigest({ clearQueue: true }),
        });
        await manager.performMutation(chat, outcome, () => manager.clear(chat));
        return json(res, 200, manager.snapshot(chat));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/config$/);
      if (req.method === "PATCH" && match?.[1]) {
        const body = await parse(req, configRequestSchema);
        const chat = manager.chat(match[1]);
        const patch = {
          ...(body.model ? { model: body.model } : {}),
          ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
          ...(body.toolMode ? { toolMode: body.toolMode } : {}),
        };
        const outcome = metadata.acceptSessionMutation({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "config",
          requestDigest: requestDigest(patch),
        });
        await manager.performMutation(chat, outcome, () => manager.configure(chat, patch));
        return json(res, 200, manager.snapshot(chat));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/rename$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, renameRequestSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acceptSessionMutation({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "rename",
          requestDigest: requestDigest({ name: body.name }),
        });
        await manager.performMutation(chat, outcome, () => manager.rename(chat, body.name));
        return json(res, 200, manager.snapshot(chat));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/compact$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, compactRequestSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acceptSessionMutation({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "compact",
          requestDigest: requestDigest({ instructions: body.instructions ?? null }),
        });
        await manager.performMutation(chat, outcome, () =>
          manager.compact(chat, body.instructions),
        );
        return json(res, 200, manager.snapshot(chat));
      }
      match = route.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/dialog$/);
      if (req.method === "POST" && match?.[1]) {
        const body = await parse(req, dialogResponseSchema);
        const chat = manager.chat(match[1]);
        const outcome = metadata.acceptSessionMutation({
          actionId: body.actionId,
          clientId: body.clientId,
          expectedRevision: body.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "dialog",
          requestDigest: requestDigest({ requestId: body.requestId, value: body.value }),
        });
        await manager.performMutation(chat, outcome, () =>
          chat.session.respondToDialog(body.requestId, body.value),
        );
        return json(res, 200, { ok: true });
      }
      if (route.startsWith("/api/")) throw new HttpError(404, "API route not found", "not_found");
      if (!existsSync(webRoot))
        throw new HttpError(503, "Web build is missing; run pnpm build", "web_build_missing");
      const requested = route === "/" ? "index.html" : route.slice(1);
      let file = path.resolve(webRoot, requested);
      if (
        !file.startsWith(`${webRoot}${path.sep}`) ||
        !existsSync(file) ||
        !statSync(file).isFile()
      )
        file = path.join(webRoot, "index.html");
      res.statusCode = 200;
      res.setHeader("Content-Type", mime(file));
      res.setHeader(
        "Cache-Control",
        file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      );
      createReadStream(file).pipe(res);
    } catch (error) {
      const status =
        error instanceof HttpError || error instanceof ActionProtocolError ? error.status : 500;
      const code =
        error instanceof HttpError || error instanceof ActionProtocolError
          ? error.code
          : "internal_error";
      json(res, status, { error: { code, message: safeError(error) } });
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
      const result = wsClientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!result.success) return socket.close(1008, "Invalid protocol message");
      if (result.data.type === "hello") {
        if (connected) return socket.close(1008, "Already connected");
        connected = true;
        try {
          manager.connect(manager.chat(result.data.chatId), socket, result.data.lastEventId);
        } catch {
          socket.close(1008, "Chat not found");
        }
      } else if (result.data.type === "pong") alive = true;
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
