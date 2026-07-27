import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PROTOCOL_VERSION, pidexApiContract, type ExtensionDialog } from "@pidex/api";
import { ORPCError, implement, os } from "@orpc/server";
import { Effect } from "effect";
import { Chats, Metadata, PiAgent, type ApplicationRuntime } from "./app-runtime.js";
import { ActionProtocolError, attemptOperation, HttpError } from "./errors.js";
import { requestDigest, type MetadataStore } from "./metadata.js";
import { discoverProjectCandidates } from "./project-catalog.js";
import { canonicalWorkspace, safeError } from "./security.js";

interface HttpApiDependencies {
  csrf: string;
  roots: string[];
  runtime: ApplicationRuntime;
}

export function createRpcApiRouter({ csrf, roots, runtime }: HttpApiDependencies) {
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
      bootstrap: implementation.system.bootstrap.handler(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const recentWorkspaces = yield* attemptOperation("metadata.recent", () =>
              metadata.recent(),
            );
            const projectCandidates = yield* discoverProjectCandidates(roots);
            return {
              protocolVersion: PROTOCOL_VERSION,
              csrfToken: csrf,
              piVersion: "0.80.10",
              recentWorkspaces,
              projectCandidates,
              warning: "Pi runs with your host user permissions and has no built-in sandbox.",
            };
          }),
        ),
      ),
    },
    workspaces: workspaces.router({
      open: workspaces.open.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const canonical = yield* canonicalWorkspace(input.path, roots);
            const id = yield* workspaceId(metadata, canonical, input.remember);
            return yield* attemptOperation("chats.openWorkspace", () =>
              manager.openWorkspace(id, canonical),
            );
          }),
        ),
      ),
      sessions: workspaces.sessions.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const sessions = yield* attemptOperation("chats.refreshSessions", () =>
              manager.refreshSessions(input.workspaceId),
            );
            return { sessions };
          }),
        ),
      ),
      trust: workspaces.trust.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const pi = yield* PiAgent;
            const record = yield* attemptOperation("chats.workspace", () =>
              manager.workspace(input.workspaceId),
            );
            yield* attemptOperation("pi.setWorkspaceTrust", () =>
              pi.setWorkspaceTrust(record.path, input.trusted),
            );
            return yield* attemptOperation("chats.openWorkspace", () =>
              manager.openWorkspace(record.id, record.path),
            );
          }),
        ),
      ),
    }),
    chats: chats.router({
      create: chats.create.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.create", () =>
              manager.create(input.workspaceId),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      resume: chats.resume.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.resume", () =>
              manager.resume(input.taskId),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      get: chats.get.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      dispose: chats.dispose.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            yield* attemptOperation("chats.dispose", () => manager.dispose(chat));
            return { ok: true };
          }),
        ),
      ),
      sendMessage: chats.sendMessage.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
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
              const outcome = yield* attemptOperation("metadata.acceptPrompt", () =>
                metadata.acceptPrompt(action),
              );
              yield* attemptOperation("chats.startPrompt", () =>
                manager.startPrompt(chat, input.text, outcome),
              );
              return outcome;
            }
            const runId = input.runId;
            const delivery = input.delivery;
            if (!runId)
              return yield* Effect.fail(
                HttpError.make({
                  status: 400,
                  code: "validation",
                  message: "An active run ID is required for queued instructions",
                }),
              );
            const outcome = yield* attemptOperation("metadata.acceptRunMutation", () =>
              metadata.acceptRunMutation({ ...action, runId, kind: delivery }),
            );
            return yield* attemptOperation("chats.deliverDuringRun", () =>
              manager.deliverDuringRun(chat, input.text, delivery, outcome),
            );
          }),
        ),
      ),
      abort: chats.abort.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            const outcome = yield* attemptOperation("metadata.acceptStop", () =>
              metadata.acceptStop({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                runId: input.runId,
                requestDigest: requestDigest({ runId: input.runId }),
              }),
            );
            return yield* attemptOperation("chats.abort", () => manager.abort(chat, outcome));
          }),
        ),
      ),
      acknowledgeInterrupted: chats.acknowledgeInterrupted.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            const outcome = yield* attemptOperation("metadata.acknowledgeInterrupted", () =>
              metadata.acknowledgeInterrupted({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                requestDigest: requestDigest({ acknowledge: chat.run?.runId ?? null }),
              }),
            );
            yield* attemptOperation("chats.acknowledgeInterrupted", () =>
              manager.acknowledgeInterrupted(chat, outcome),
            );
            return outcome;
          }),
        ),
      ),
      toolOutput: chats.toolOutput.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            return yield* attemptOperation("chats.toolOutput", () =>
              manager.toolOutput(chat, input.resourceId, input.offset, input.limit),
            );
          }),
        ),
      ),
      transcript: chats.transcript.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            return yield* attemptOperation("chats.transcript", () =>
              manager.transcriptPage(chat, input.before, input.limit),
            );
          }),
        ),
      ),
      clearQueue: chats.clearQueue.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            const outcome = yield* attemptOperation("metadata.acceptSessionMutation", () =>
              metadata.acceptSessionMutation({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                kind: "clear-queue",
                requestDigest: requestDigest({ clearQueue: true }),
              }),
            );
            yield* attemptOperation("chats.clearQueue", () =>
              manager.performMutation(chat, outcome, () => manager.clear(chat)),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      configure: chats.configure.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            yield* requireIdle(chat.session.isIdle, "Configuration can only change while idle");
            const workspace = yield* attemptOperation("chats.workspace", () =>
              manager.workspace(chat.workspaceId),
            );
            const modelAvailable = workspace.info.models.some((model) => model.id === input.model);
            if (input.model && !modelAvailable)
              return yield* Effect.fail(
                HttpError.make({
                  status: 400,
                  code: "model_unavailable",
                  message: "Model is no longer available",
                }),
              );
            const patch = {
              ...(input.model ? { model: input.model } : {}),
              ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
            };
            const outcome = yield* attemptOperation("metadata.acceptSessionMutation", () =>
              metadata.acceptSessionMutation({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                kind: "config",
                requestDigest: requestDigest(patch),
              }),
            );
            yield* attemptOperation("chats.configure", () =>
              manager.performMutation(chat, outcome, () => manager.configure(chat, patch)),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      rename: chats.rename.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            const outcome = yield* attemptOperation("metadata.acceptSessionMutation", () =>
              metadata.acceptSessionMutation({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                kind: "rename",
                requestDigest: requestDigest({ name: input.name }),
              }),
            );
            yield* attemptOperation("chats.rename", () =>
              manager.performMutation(chat, outcome, () => manager.rename(chat, input.name)),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      compact: chats.compact.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            yield* requireIdle(chat.session.isIdle, "Compaction can only run while idle");
            const outcome = yield* attemptOperation("metadata.acceptSessionMutation", () =>
              metadata.acceptSessionMutation({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                kind: "compact",
                requestDigest: requestDigest({ instructions: input.instructions ?? null }),
              }),
            );
            yield* attemptOperation("chats.compact", () =>
              manager.performMutation(chat, outcome, () =>
                manager.compact(chat, input.instructions),
              ),
            );
            return yield* attemptOperation("chats.snapshot", () => manager.snapshot(chat));
          }),
        ),
      ),
      answerDialog: chats.answerDialog.handler(({ input }) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const metadata = yield* Metadata;
            const manager = yield* Chats;
            const chat = yield* attemptOperation("chats.get", () => manager.chat(input.chatId));
            yield* validateDialogResponse(chat.extensionDialog, input.requestId, input.value);
            const outcome = yield* attemptOperation("metadata.acceptSessionMutation", () =>
              metadata.acceptSessionMutation({
                actionId: input.actionId,
                clientId: input.clientId,
                expectedRevision: input.expectedRevision,
                sessionKey: chat.sessionKey,
                kind: "dialog",
                requestDigest: requestDigest({ requestId: input.requestId, value: input.value }),
              }),
            );
            yield* attemptOperation("chats.answerDialog", () =>
              manager.performMutation(chat, outcome, () =>
                chat.session.respondToDialog(input.requestId, input.value),
              ),
            );
            return { ok: true };
          }),
        ),
      ),
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

type RpcApiContext = { req: IncomingMessage };

function workspaceId(metadata: MetadataStore, canonical: string, remember: boolean | undefined) {
  return Effect.gen(function* () {
    if (remember === false) {
      const existing = yield* attemptOperation("metadata.workspaceId", () =>
        metadata.workspaceId(canonical),
      );
      if (existing) return existing;
      return yield* attemptOperation("workspace.ephemeralId", () =>
        randomBytes(16).toString("hex"),
      );
    }
    return yield* attemptOperation("metadata.rememberWorkspace", () =>
      metadata.rememberWorkspace(canonical),
    );
  });
}

function requireIdle(isIdle: boolean, message: string) {
  return isIdle
    ? Effect.void
    : Effect.fail(ActionProtocolError.make({ code: "session_busy", message }));
}

function validateDialogResponse(
  dialog: ExtensionDialog | undefined,
  requestId: string,
  value: string | boolean | null,
) {
  if (!dialog || dialog.id !== requestId)
    return Effect.fail(
      HttpError.make({
        status: 409,
        code: "dialog_mismatch",
        message: "Extension dialog is no longer pending",
      }),
    );
  if (value === null) return Effect.void;
  if (dialog.kind === "confirm" && typeof value === "boolean") return Effect.void;
  if (dialog.kind === "select" && typeof value === "string" && dialog.options?.includes(value))
    return Effect.void;
  if ((dialog.kind === "input" || dialog.kind === "editor") && typeof value === "string")
    return Effect.void;
  return Effect.fail(
    HttpError.make({
      status: 400,
      code: "dialog_value_invalid",
      message: "Extension response does not match the pending dialog",
    }),
  );
}
