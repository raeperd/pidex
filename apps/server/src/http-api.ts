import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PROTOCOL_VERSION, pidexApiContract, type ExtensionDialog } from "@pidex/api";
import { ORPCError, implement, os } from "@orpc/server";
import { ChatManager } from "./chat-manager.js";
import { ActionProtocolError, MetadataStore, requestDigest } from "./metadata.js";
import { discoverProjectCandidates } from "./project-catalog.js";
import { PiSdk } from "./pi-sdk.js";
import { canonicalWorkspace, HttpError, safeError } from "./security.js";

interface HttpApiDependencies {
  csrf: string;
  roots: string[];
  metadata: MetadataStore;
  pi: PiSdk;
  manager: ChatManager;
}

export function createRpcApiRouter({ csrf, roots, metadata, pi, manager }: HttpApiDependencies) {
  const base = implement(pidexApiContract).$context<RpcApiContext>();
  const requireCsrf = base.middleware(async ({ context, next }) => {
    if (context.req.headers["x-pidex-csrf"] !== csrf)
      throw new ORPCError("csrf", { status: 403, message: "Invalid CSRF token" });
    return next();
  });
  const implementation = base.use(protocolErrors);
  const workspaces = implementation.workspaces.use(requireCsrf);
  const chats = implementation.chats.use(requireCsrf);

  return implementation.router({
    system: {
      health: implementation.system.health.handler(() => ({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
      })),
      bootstrap: implementation.system.bootstrap.handler(async () => ({
        protocolVersion: PROTOCOL_VERSION,
        csrfToken: csrf,
        piVersion: "0.80.10",
        recentWorkspaces: metadata.recent(),
        projectCandidates: await discoverProjectCandidates(roots),
        warning: "Pi runs with your host user permissions and has no built-in sandbox.",
      })),
    },
    workspaces: workspaces.router({
      open: workspaces.open.handler(async ({ input }) => {
        const canonical = await canonicalWorkspace(input.path, roots);
        const id =
          input.remember === false
            ? (metadata.workspaceId(canonical) ?? randomBytes(16).toString("hex"))
            : metadata.rememberWorkspace(canonical);
        return manager.openWorkspace(id, canonical);
      }),
      sessions: workspaces.sessions.handler(async ({ input }) => ({
        sessions: await manager.refreshSessions(input.workspaceId),
      })),
      trust: workspaces.trust.handler(async ({ input }) => {
        const record = manager.workspace(input.workspaceId);
        await pi.setWorkspaceTrust(record.path, input.trusted);
        return manager.openWorkspace(record.id, record.path);
      }),
    }),
    chats: chats.router({
      create: chats.create.handler(async ({ input }) =>
        manager.snapshot(await manager.create(input.workspaceId)),
      ),
      resume: chats.resume.handler(async ({ input }) =>
        manager.snapshot(await manager.resume(input.workspaceId, input.sessionId)),
      ),
      get: chats.get.handler(({ input }) => manager.snapshot(manager.chat(input.chatId))),
      dispose: chats.dispose.handler(({ input }) => {
        manager.dispose(manager.chat(input.chatId));
        return { ok: true };
      }),
      sendMessage: chats.sendMessage.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        const action = {
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          requestDigest: requestDigest({
            text: input.text,
            delivery: input.delivery,
            runId: input.runId ?? null,
          }),
        };
        if (input.delivery === "normal") {
          const outcome = metadata.acceptPrompt(action);
          manager.startPrompt(chat, input.text, outcome);
          return outcome;
        }
        if (!input.runId)
          throw new HttpError(
            400,
            "An active run ID is required for queued instructions",
            "validation",
          );
        const outcome = metadata.acceptRunMutation({
          ...action,
          runId: input.runId,
          kind: input.delivery,
        });
        return manager.deliverDuringRun(chat, input.text, input.delivery, outcome);
      }),
      abort: chats.abort.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        const outcome = metadata.acceptStop({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          runId: input.runId,
          requestDigest: requestDigest({ runId: input.runId }),
        });
        return manager.abort(chat, outcome);
      }),
      acknowledgeInterrupted: chats.acknowledgeInterrupted.handler(({ input }) => {
        const chat = manager.chat(input.chatId);
        const outcome = metadata.acknowledgeInterrupted({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          requestDigest: requestDigest({ acknowledge: chat.run?.runId ?? null }),
        });
        manager.acknowledgeInterrupted(chat, outcome);
        return outcome;
      }),
      toolOutput: chats.toolOutput.handler(({ input }) =>
        manager.toolOutput(manager.chat(input.chatId), input.resourceId, input.offset, input.limit),
      ),
      transcript: chats.transcript.handler(({ input }) =>
        manager.transcriptPage(manager.chat(input.chatId), input.before, input.limit),
      ),
      clearQueue: chats.clearQueue.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        const outcome = metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "clear-queue",
          requestDigest: requestDigest({ clearQueue: true }),
        });
        await manager.performMutation(chat, outcome, () => manager.clear(chat));
        return manager.snapshot(chat);
      }),
      configure: chats.configure.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        requireIdle(chat, "Configuration can only change while the session is idle");
        const modelAvailable = manager
          .workspace(chat.workspaceId)
          .info.models.some((model) => model.id === input.model);
        if (input.model && !modelAvailable)
          throw new HttpError(400, "Model is no longer available", "model_unavailable");
        const patch = {
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(input.toolMode ? { toolMode: input.toolMode } : {}),
        };
        const outcome = metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "config",
          requestDigest: requestDigest(patch),
        });
        await manager.performMutation(chat, outcome, () => manager.configure(chat, patch));
        return manager.snapshot(chat);
      }),
      rename: chats.rename.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        const outcome = metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "rename",
          requestDigest: requestDigest({ name: input.name }),
        });
        await manager.performMutation(chat, outcome, () => manager.rename(chat, input.name));
        return manager.snapshot(chat);
      }),
      compact: chats.compact.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        requireIdle(chat, "Compaction can only run while the session is idle");
        const outcome = metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "compact",
          requestDigest: requestDigest({ instructions: input.instructions ?? null }),
        });
        await manager.performMutation(chat, outcome, () =>
          manager.compact(chat, input.instructions),
        );
        return manager.snapshot(chat);
      }),
      answerDialog: chats.answerDialog.handler(async ({ input }) => {
        const chat = manager.chat(input.chatId);
        validateDialogResponse(chat.extensionDialog, input.requestId, input.value);
        const outcome = metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "dialog",
          requestDigest: requestDigest({ requestId: input.requestId, value: input.value }),
        });
        await manager.performMutation(chat, outcome, () =>
          chat.session.respondToDialog(input.requestId, input.value),
        );
        return { ok: true };
      }),
    }),
  });
}

const protocolErrors = os.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    const protocolError =
      error instanceof HttpError || error instanceof ActionProtocolError ? error : undefined;
    throw new ORPCError(protocolError?.code ?? "internal_error", {
      status: protocolError?.status ?? 500,
      message: safeError(error),
    });
  }
});

type Chat = ReturnType<ChatManager["chat"]>;
type RpcApiContext = { req: IncomingMessage };

function requireIdle(chat: Chat, message: string) {
  if (chat.session.isIdle) return;
  throw new ActionProtocolError("session_busy", message);
}

function validateDialogResponse(
  dialog: ExtensionDialog | undefined,
  requestId: string,
  value: string | boolean | null,
) {
  if (!dialog || dialog.id !== requestId)
    throw new HttpError(409, "Extension dialog is no longer pending", "dialog_mismatch");
  if (value === null) return;
  if (dialog.kind === "confirm" && typeof value === "boolean") return;
  if (dialog.kind === "select" && typeof value === "string" && dialog.options?.includes(value))
    return;
  if ((dialog.kind === "input" || dialog.kind === "editor") && typeof value === "string") return;
  throw new HttpError(
    400,
    "Extension response does not match the pending dialog",
    "dialog_value_invalid",
  );
}
