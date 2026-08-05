import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WithEffectContext } from "@orpc/experimental-effect";
import "@orpc/experimental-effect/extensions/effect";
import { PROTOCOL_VERSION, pidexApiContract, type ExtensionDialog } from "@pidex/api";
import { ORPCError, implement, os } from "@orpc/server";
import { Effect } from "effect";
import { Chats, Metadata, PiAgent, type ApplicationServices } from "./app-runtime.js";
import type { AuthenticatedSession } from "./auth.js";
import { ActionProtocolError, attemptOperation, HttpError } from "./errors.js";
import { requestDigest, type MetadataService } from "./metadata.js";
import {
  createProjectWorktree,
  discoverProjectCandidates,
  managedWorktreesRoot,
  removeProjectWorktree,
} from "./project-catalog.js";
import { canonicalWorkspace, isDescendant, safeError } from "./security.js";

interface HttpApiDependencies {
  roots: string[];
}

type RpcAccess = "public" | "authenticated" | "desktop";

export const rpcAuthorization: Readonly<Record<string, RpcAccess>> = {
  "system.health": "public",
  "system.bootstrap": "authenticated",
  "workspaces.open": "desktop",
  "workspaces.createWorktree": "desktop",
  "workspaces.removeWorktree": "desktop",
  "workspaces.reorder": "desktop",
  "workspaces.sessions": "authenticated",
  "workspaces.trust": "desktop",
  "chats.create": "authenticated",
  "chats.resume": "authenticated",
  "chats.get": "authenticated",
  "chats.dispose": "authenticated",
  "chats.sendMessage": "authenticated",
  "chats.abort": "authenticated",
  "chats.acknowledgeInterrupted": "authenticated",
  "chats.toolOutput": "authenticated",
  "chats.transcript": "authenticated",
  "chats.clearQueue": "authenticated",
  "chats.configure": "desktop",
  "chats.rename": "desktop",
  "chats.compact": "authenticated",
  "chats.answerDialog": "authenticated",
};

export const createRpcApiRouter = Effect.fn("http.createRpcApiRouter")(function* ({
  roots,
}: HttpApiDependencies) {
  const managedWorktreeRoot = yield* managedWorktreesRoot();
  const workspaceRoots = [...roots, managedWorktreeRoot];
  const base = implement(pidexApiContract).$context<RpcApiContext>();
  const requireAuthorization = base.middleware(async ({ context, next, path }) => {
    const access = rpcAuthorization[path.join(".")];
    if (!access)
      throw new ORPCError("internal_error", { message: "RPC authorization policy is missing" });
    if (access === "public") return next();
    const session = authenticatedSession(context);
    if (access === "desktop" && session.kind !== "desktop")
      throw new ORPCError("forbidden", { message: "Desktop authorization is required" });
    return next();
  });
  const requireCsrf = base.middleware(async ({ context, next }) => {
    const session = authenticatedSession(context);
    if (context.req.headers["x-pidex-csrf"] !== session.csrfToken)
      throw new ORPCError("csrf", { message: "Invalid CSRF token" });
    return next();
  });
  const requireActionPrincipal = base.middleware(async ({ context, next }, input) => {
    const session = authenticatedSession(context);
    if (
      typeof input === "object" &&
      input !== null &&
      "clientId" in input &&
      input.clientId !== session.clientId
    )
      throw new ORPCError("client_mismatch", {
        message: "Action client ID does not match the authenticated session",
      });
    return next();
  });
  const implementation = base.use(protocolErrors).use(requireAuthorization);
  const workspaces = implementation.workspaces.use(requireCsrf);
  const chats = implementation.chats.use(requireCsrf).use(requireActionPrincipal);

  return implementation.router({
    system: {
      health: implementation.system.health.handler(() => ({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
      })),
      bootstrap: implementation.system.bootstrap.effect(function* ({ context }) {
        const session = authenticatedSession(context);
        const metadata = yield* Metadata;
        const recentWorkspaces = yield* recentWorkspaceRecords(metadata, managedWorktreeRoot);
        const projectCandidates = yield* discoverProjectCandidates(roots);
        return {
          protocolVersion: PROTOCOL_VERSION,
          clientId: session.clientId,
          csrfToken: session.csrfToken,
          piVersion: "0.80.10",
          recentWorkspaces,
          projectCandidates,
          warning: "Pi runs with your host user permissions and has no built-in sandbox.",
        };
      }),
    },
    workspaces: workspaces.router({
      open: workspaces.open.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const canonical = yield* canonicalWorkspace(input.path, workspaceRoots);
        if (!roots.some((root) => isDescendant(root, canonical))) {
          const rememberedId = yield* metadata.workspaceId(canonical);
          const sourceWorkspaceId = rememberedId
            ? yield* metadata.workspaceProjectId(rememberedId)
            : undefined;
          if (!rememberedId || sourceWorkspaceId === rememberedId)
            return yield* Effect.fail(
              HttpError.make({
                status: 403,
                code: "workspace_forbidden",
                message: "Project is outside WORKSPACE_ROOTS",
              }),
            );
        }
        const id = yield* workspaceId(metadata, canonical, input.remember);
        return yield* manager.openWorkspace(id, canonical);
      }),
      createWorktree: workspaces.createWorktree.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const pi = yield* PiAgent;
        const source = yield* manager.workspace(input.workspaceId);
        const canonicalSource = yield* canonicalWorkspace(source.path, workspaceRoots);
        const worktreePath = yield* createProjectWorktree(canonicalSource);
        let id: string | undefined;
        return yield* Effect.gen(function* () {
          yield* pi.inheritWorkspaceTrust(canonicalSource, worktreePath);
          const sourceWorkspaceId = yield* metadata.workspaceProjectId(source.id);
          const createdWorkspaceId = yield* metadata.rememberWorkspace(
            worktreePath,
            sourceWorkspaceId,
          );
          id = createdWorkspaceId;
          const opened = yield* manager.openWorkspace(createdWorkspaceId, worktreePath);
          yield* manager.markWorkspaceDisposable(createdWorkspaceId);
          return opened;
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* removeProjectWorktree(canonicalSource, worktreePath).pipe(
                Effect.catch(() => Effect.void),
              );
              yield* pi.clearWorkspaceTrust(worktreePath).pipe(Effect.catch(() => Effect.void));
              const createdWorkspaceId = id;
              if (createdWorkspaceId)
                yield* metadata
                  .forgetWorkspace(createdWorkspaceId)
                  .pipe(Effect.catch(() => Effect.void));
            }),
          ),
        );
      }),
      removeWorktree: workspaces.removeWorktree.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const pi = yield* PiAgent;
        const worktree = yield* manager.workspace(input.workspaceId);
        const sourceWorkspaceId = yield* metadata.workspaceProjectId(input.workspaceId);
        if (sourceWorkspaceId === input.workspaceId)
          return yield* Effect.fail(
            HttpError.make({
              status: 400,
              code: "workspace_not_managed_worktree",
              message: "Workspace is not a managed Pidex worktree",
            }),
          );
        const source = yield* manager.workspace(sourceWorkspaceId);
        const canRemove = yield* manager.workspaceCanBeRemoved(worktree.id);
        if (!canRemove)
          return yield* Effect.fail(
            HttpError.make({
              status: 409,
              code: "worktree_has_tasks",
              message: "Only a newly created worktree without task history can be removed",
            }),
          );
        yield* removeProjectWorktree(source.path, worktree.path);
        yield* pi.clearWorkspaceTrust(worktree.path).pipe(Effect.catch(() => Effect.void));
        yield* manager.forgetWorkspace(worktree.id);
        yield* metadata.forgetWorkspace(worktree.id);
        return { ok: true };
      }),
      reorder: workspaces.reorder.effect(function* (_, input) {
        const metadata = yield* Metadata;
        yield* metadata.reorderWorkspaces(input.workspaceIds);
        const recentWorkspaces = yield* recentWorkspaceRecords(metadata, managedWorktreeRoot);
        return { recentWorkspaces };
      }),
      sessions: workspaces.sessions.effect(function* (_, input) {
        const manager = yield* Chats;
        const sessions = yield* manager.refreshSessions(input.workspaceId);
        return { sessions };
      }),
      trust: workspaces.trust.effect(function* (_, input) {
        const manager = yield* Chats;
        const pi = yield* PiAgent;
        const record = yield* manager.workspace(input.workspaceId);
        yield* pi.setWorkspaceTrust(record.path, input.trusted);
        return yield* manager.openWorkspace(record.id, record.path);
      }),
    }),
    chats: chats.router({
      create: chats.create.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.create(input.workspaceId);
        return yield* manager.snapshot(chat);
      }),
      resume: chats.resume.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.resume(input.taskId);
        return yield* manager.snapshot(chat);
      }),
      get: chats.get.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        return yield* manager.snapshot(chat);
      }),
      dispose: chats.dispose.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        yield* manager.dispose(chat);
        return { ok: true };
      }),
      sendMessage: chats.sendMessage.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
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
          const outcome = yield* metadata.acceptPrompt(action);
          yield* manager.startPrompt(chat, input.text, outcome);
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
        const outcome = yield* metadata.acceptRunMutation({ ...action, runId, kind: delivery });
        return yield* manager.deliverDuringRun(chat, input.text, delivery, outcome);
      }),
      abort: chats.abort.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        const outcome = yield* metadata.acceptStop({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          runId: input.runId,
          requestDigest: requestDigest({ runId: input.runId }),
        });
        return yield* manager.abort(chat, outcome);
      }),
      acknowledgeInterrupted: chats.acknowledgeInterrupted.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        const outcome = yield* metadata.acknowledgeInterrupted({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          requestDigest: requestDigest({ acknowledge: chat.run?.runId ?? null }),
        });
        manager.acknowledgeInterrupted(chat, outcome);
        return outcome;
      }),
      toolOutput: chats.toolOutput.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        return yield* manager.toolOutput(chat, input.resourceId, input.offset, input.limit);
      }),
      transcript: chats.transcript.effect(function* (_, input) {
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        return yield* attemptOperation("chats.transcript", () =>
          manager.transcriptPage(chat, input.before, input.limit),
        );
      }),
      clearQueue: chats.clearQueue.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        const outcome = yield* metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "clear-queue",
          requestDigest: requestDigest({ clearQueue: true }),
        });
        yield* manager.performMutation(chat, outcome, () => manager.clear(chat));
        return yield* manager.snapshot(chat);
      }),
      configure: chats.configure.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        yield* requireIdle(chat.session.state.isIdle, "Configuration can only change while idle");
        const workspace = yield* manager.workspace(chat.workspaceId);
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
        const outcome = yield* metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "config",
          requestDigest: requestDigest(patch),
        });
        yield* manager.performMutation(chat, outcome, () => manager.configure(chat, patch));
        return yield* manager.snapshot(chat);
      }),
      rename: chats.rename.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        const outcome = yield* metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "rename",
          requestDigest: requestDigest({ name: input.name }),
        });
        yield* manager.performMutation(chat, outcome, () => manager.rename(chat, input.name));
        return yield* manager.snapshot(chat);
      }),
      compact: chats.compact.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        yield* requireIdle(chat.session.state.isIdle, "Compaction can only run while idle");
        const outcome = yield* metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "compact",
          requestDigest: requestDigest({ instructions: input.instructions ?? null }),
        });
        yield* manager.performMutation(chat, outcome, () =>
          manager.compact(chat, input.instructions),
        );
        return yield* manager.snapshot(chat);
      }),
      answerDialog: chats.answerDialog.effect(function* (_, input) {
        const metadata = yield* Metadata;
        const manager = yield* Chats;
        const chat = yield* manager.chat(input.chatId);
        yield* validateDialogResponse(chat.extensionDialog, input.requestId, input.value);
        const outcome = yield* metadata.acceptSessionMutation({
          actionId: input.actionId,
          clientId: input.clientId,
          expectedRevision: input.expectedRevision,
          sessionKey: chat.sessionKey,
          kind: "dialog",
          requestDigest: requestDigest({ requestId: input.requestId, value: input.value }),
        });
        yield* manager.performMutation(chat, outcome, () =>
          chat.session.respondToDialog(input.requestId, input.value),
        );
        return { ok: true };
      }),
    }),
  });
});

const protocolErrors = os.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    const protocolError =
      error instanceof HttpError || error instanceof ActionProtocolError ? error : undefined;
    throw new ORPCError(protocolError?.code ?? "internal_error", {
      message: safeError(error),
    });
  }
});

interface RpcApiContext extends WithEffectContext<ApplicationServices> {
  req: IncomingMessage;
  session: AuthenticatedSession | undefined;
}

function authenticatedSession(context: RpcApiContext) {
  if (!context.session)
    throw new ORPCError("unauthenticated", { message: "Authentication required" });
  return context.session;
}

function workspaceId(metadata: MetadataService, canonical: string, remember: boolean | undefined) {
  return Effect.gen(function* () {
    if (remember === false) {
      const existing = yield* metadata.workspaceId(canonical);
      if (existing) return existing;
      return yield* attemptOperation("workspace.ephemeralId", () =>
        randomBytes(16).toString("hex"),
      );
    }
    return yield* metadata.rememberWorkspace(canonical);
  });
}

function recentWorkspaceRecords(metadata: MetadataService, managedWorktreeRoot: string) {
  return metadata.recent().pipe(
    Effect.map((records) =>
      records.map((record) => ({
        ...record,
        worktree: isDescendant(managedWorktreeRoot, record.path),
      })),
    ),
  );
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
