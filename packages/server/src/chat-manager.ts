import { randomUUID } from "node:crypto";
import type {
  ActionOutcome,
  ChatSnapshot,
  ExtensionDialog,
  PidexEvent,
  RunOutcome,
  ServerEvent,
  SessionSummary,
  TextItem,
  ToolOutputChunk,
  TranscriptItem,
  TranscriptPage,
  ToolItem,
  Workspace,
} from "@pidex/api";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { streamToAsyncIteratorObject, withEventMeta } from "@orpc/server";
import type {
  AdapterEvent,
  AdapterSessionInfo,
  AdapterToolOutput,
  AdapterWorkspaceInfo,
  EffectAdapterSession,
  PiSdkServiceApi,
} from "./pi-sdk.js";
import { bounded, boundedResource, messageId, messageItems, textOf, thinkingOf } from "./pi-sdk.js";
import { serverError } from "./errors.js";
import type { MetadataService } from "./metadata.js";
import { safeError } from "./security.js";

const nativeSessionKey = (session: { nativeId: string; nativePath?: string | undefined }) =>
  session.nativePath ?? session.nativeId;

interface ChatRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  sessionKey: string;
  session: EffectAdapterSession;
  scope: Scope.Closeable;
  revision: number;
  run?: RunOutcome;
  runStatus: ChatSnapshot["runStatus"];
  items: TranscriptItem[];
  steering: string[];
  followUp: string[];
  extensionDialog: ExtensionDialog | undefined;
  resources: Map<string, AdapterToolOutput>;
  eventId: number;
  events: ServerEvent[];
  subscribers: Set<Queue.Queue<ServerEvent>>;
  generation: number;
  abortRequested: boolean;
}
type EventPayload = PidexEvent;
const LIVE_EVENT_RETRY_MS = 2_000;

export function makeChatManager(pi: PiSdkServiceApi, metadata: MetadataService) {
  const workspaces = new Map<string, { id: string; path: string; info: AdapterWorkspaceInfo }>();
  const chats = new Map<string, ChatRecord>();
  const owners = new Map<string, string>();
  const disposableWorkspaces = new Set<string>();

  function publicSession(workspaceId: string, info: AdapterSessionInfo) {
    return Effect.gen(function* () {
      const workspace = yield* getWorkspace(workspaceId);
      const key = nativeSessionKey(info);
      const id = yield* metadata.rememberTask(workspaceId, workspace.path, key);
      const liveChatId = owners.get(key);
      const liveChat = liveChatId ? chats.get(liveChatId) : undefined;
      const persisted = liveChat ? undefined : (yield* metadata.sessionState(key)).run;
      return {
        id,
        ...(info.name ? { name: info.name } : {}),
        firstMessage: info.firstMessage,
        createdAt: info.createdAt,
        modifiedAt: info.modifiedAt,
        messageCount: info.messageCount,
        status: resolveSessionStatus(liveChat?.runStatus, persisted),
      } satisfies SessionSummary;
    });
  }

  function openWorkspace(id: string, canonicalPath: string) {
    return Effect.gen(function* () {
      const info = yield* pi.inspectWorkspace(canonicalPath);
      const record = { id, path: canonicalPath, info };
      workspaces.set(id, record);
      const listedKeys = new Set(info.sessions.map((session) => nativeSessionKey(session)));
      const listed = yield* Effect.forEach(info.sessions, (session) => publicSession(id, session));
      // Pi does not persist a session to disk until it holds an assistant reply, so a chat
      // that just started (or is still on its first turn) has no entry in `info.sessions`
      // yet — `inspectWorkspace` only ever sees what's on disk. Union in a summary
      // synthesized from the live ChatRecord for any chat in this workspace that isn't
      // listed yet, so a brand-new task has sidebar presence immediately instead of only
      // once the model has replied.
      const liveOnly = [...chats.values()]
        .filter((chat) => chat.workspaceId === id && !listedKeys.has(chat.sessionKey))
        .map(liveOnlySession);
      return {
        id,
        path: canonicalPath,
        name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? canonicalPath,
        trusted: info.trusted,
        protectedResourcesSkipped: info.protectedResourcesSkipped,
        resourceDiagnostics: info.resourceDiagnostics,
        models: info.models,
        sessions: [...liveOnly, ...listed],
        commands: info.commands,
      } satisfies Workspace;
    });
  }

  function getWorkspace(id: string) {
    return Effect.fromNullishOr(workspaces.get(id)).pipe(
      Effect.mapError(() =>
        serverError("chats.workspace", new Error("Workspace is no longer open")),
      ),
    );
  }

  function markWorkspaceDisposable(id: string) {
    return getWorkspace(id).pipe(
      Effect.tap(() => Effect.sync(() => disposableWorkspaces.add(id))),
      Effect.asVoid,
    );
  }

  function workspaceCanBeRemoved(id: string) {
    return getWorkspace(id).pipe(
      Effect.map((workspace) => {
        const workspaceChats = [...chats.values()].filter((chat) => chat.workspaceId === id);
        return (
          disposableWorkspaces.has(id) &&
          workspace.info.sessions.every((session) => session.messageCount === 0) &&
          workspaceChats.every(
            (chat) => chat.items.length === 0 && ["idle", "error"].includes(chat.runStatus),
          )
        );
      }),
    );
  }

  function forgetWorkspace(id: string) {
    return Effect.gen(function* () {
      if (!(yield* workspaceCanBeRemoved(id)))
        return yield* Effect.fail(
          serverError("chats.forgetWorkspace", new Error("Workspace cannot be removed")),
        );
      const workspaceChats = [...chats.values()].filter((chat) => chat.workspaceId === id);
      yield* Effect.forEach(workspaceChats, (chat) => dispose(chat), { discard: true });
      disposableWorkspaces.delete(id);
      workspaces.delete(id);
    });
  }

  function refreshSessions(workspaceId: string) {
    return Effect.gen(function* () {
      const workspace = yield* getWorkspace(workspaceId);
      return (yield* openWorkspace(workspaceId, workspace.path)).sessions;
    });
  }

  function attach(
    workspaceId: string,
    session: EffectAdapterSession,
    scope: Scope.Closeable,
    taskId?: string,
  ) {
    return Effect.gen(function* () {
      const sessionKey = nativeSessionKey(session.state);
      const existingId = owners.get(sessionKey);
      if (existingId) {
        yield* Scope.close(scope, Exit.void);
        return yield* getChat(existingId);
      }
      const persisted = yield* metadata.sessionState(sessionKey);
      const runIsActive =
        persisted.run?.status === "accepted" || persisted.run?.status === "running";
      const id = randomUUID().replaceAll("-", "");
      const workspace = yield* getWorkspace(workspaceId);
      const persistedTaskId =
        taskId ?? (yield* metadata.rememberTask(workspaceId, workspace.path, sessionKey));
      const chat: ChatRecord = {
        id,
        workspaceId,
        taskId: persistedTaskId,
        sessionKey,
        session,
        scope,
        revision: persisted.revision,
        ...(persisted.run ? { run: persisted.run } : {}),
        runStatus: runIsActive ? "running" : "idle",
        items: [...session.state.messages],
        steering: [],
        followUp: [],
        extensionDialog: undefined,
        resources: new Map(session.state.toolOutputs),
        eventId: 0,
        events: [],
        subscribers: new Set(),
        generation: 1,
        abortRequested: false,
      };
      const generation = chat.generation;
      yield* session.events.pipe(
        Stream.runForEach((event) =>
          chat.generation === generation
            ? handle(chat, event).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => handleNotice(chat, { level: "error", text: safeError(error) })),
                ),
              )
            : Effect.void,
        ),
        Effect.forkIn(scope),
      );
      chats.set(id, chat);
      owners.set(sessionKey, id);
      return chat;
    });
  }

  function create(workspaceId: string) {
    return Effect.gen(function* () {
      const workspace = yield* getWorkspace(workspaceId);
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const session = yield* Scope.provide(pi.createSession(workspace.path), scope);
        workspace.info = yield* pi.inspectWorkspace(workspace.path);
        return yield* attach(workspaceId, session, scope);
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });
  }

  function resume(taskId: string) {
    return Effect.gen(function* () {
      const active = [...chats.values()].find((chat) => chat.taskId === taskId);
      if (active) return active;
      const persisted = yield* metadata.task(taskId);
      if (!persisted)
        return yield* Effect.fail(serverError("chats.resume", new Error("Task no longer exists")));
      let workspace = workspaces.get(persisted.workspaceId);
      if (!workspace) {
        yield* openWorkspace(persisted.workspaceId, persisted.workspacePath);
        workspace = yield* getWorkspace(persisted.workspaceId);
      }
      const fresh = yield* pi.inspectWorkspace(workspace.path);
      workspace.info = fresh;
      const listed = fresh.sessions.find(
        (entry) => nativeSessionKey(entry) === persisted.sessionKey,
      );
      if (!listed?.nativePath)
        return yield* Effect.fail(
          serverError("chats.resume", new Error("Session no longer exists")),
        );
      const owner = owners.get(listed.nativePath);
      if (owner) return yield* getChat(owner);
      const nativePath = listed.nativePath;
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const session = yield* Scope.provide(pi.resumeSession(workspace.path, nativePath), scope);
        return yield* attach(persisted.workspaceId, session, scope, taskId);
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });
  }

  function getChat(id: string) {
    return Effect.fromNullishOr(chats.get(id)).pipe(
      Effect.mapError(() => serverError("chats.chat", new Error("Chat was not found"))),
    );
  }

  function snapshot(chat: ChatRecord) {
    return Effect.gen(function* () {
      const transcript = transcriptPage(chat, chat.items.length, 200);
      const contextUsage = chat.session.state.contextUsage;
      const stats = yield* chat.session.getStats();
      return {
        chatId: chat.id,
        workspaceId: chat.workspaceId,
        taskId: chat.taskId,
        ...(chat.session.state.sessionName ? { sessionName: chat.session.state.sessionName } : {}),
        revision: chat.revision,
        ...(chat.run ? { run: chat.run } : {}),
        runStatus: chat.runStatus,
        ...(chat.session.state.model ? { model: chat.session.state.model } : {}),
        thinkingLevel: chat.session.state.thinkingLevel,
        items: transcript.items,
        transcriptStart: transcript.start,
        transcriptTotal: transcript.total,
        steeringQueue: chat.steering,
        followUpQueue: chat.followUp,
        stats,
        ...(contextUsage ? { contextUsage } : {}),
        ...(chat.extensionDialog ? { extensionDialog: chat.extensionDialog } : {}),
      } satisfies ChatSnapshot;
    });
  }

  function broadcastRun(chat: ChatRecord) {
    broadcast(chat, {
      type: "run_status",
      status: chat.runStatus,
      revision: chat.revision,
      ...(chat.run ? { run: chat.run } : {}),
    });
  }

  function events(chat: ChatRecord, lastEventId?: number) {
    return Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ServerEvent>();
      chat.subscribers.add(queue);
      const first = chat.events[0]?.eventId;
      const replay =
        lastEventId !== undefined &&
        first !== undefined &&
        lastEventId >= first - 1 &&
        lastEventId <= chat.eventId
          ? chat.events.filter((event) => event.eventId > lastEventId)
          : [yield* snapshotEvent(chat)];
      const stream = Stream.concat(Stream.fromIterable(replay), Stream.fromQueue(queue)).pipe(
        Stream.ensuring(
          Effect.gen(function* () {
            chat.subscribers.delete(queue);
            yield* Queue.shutdown(queue);
          }),
        ),
      );
      return streamToAsyncIteratorObject(Stream.toReadableStream(stream));
    });
  }

  function snapshotEvent(chat: ChatRecord) {
    return snapshot(chat).pipe(
      Effect.map((currentSnapshot) => {
        const event = makeServerEvent(chat, "pidex", {
          type: "snapshot",
          snapshot: currentSnapshot,
        });
        const eventWithMeta = withEventMeta(event, {
          id: String(event.eventId),
          retry: LIVE_EVENT_RETRY_MS,
        });
        appendEvent(chat, eventWithMeta);
        return eventWithMeta;
      }),
    );
  }

  function handle(chat: ChatRecord, event: AdapterEvent) {
    function applyMessage(
      piEvent: Extract<AgentSessionEvent, { type: "message_start" | "message_end" }>,
    ) {
      if (piEvent.message.role !== "user" && piEvent.message.role !== "assistant") return;
      const thinking = thinkingOf(piEvent.message.content);
      const item: TextItem = {
        type: piEvent.message.role,
        id: messageId(piEvent.message),
        text: textOf(piEvent.message.content),
        ...(thinking ? { thinking } : {}),
        complete: piEvent.type === "message_end",
        timestamp: new Date(piEvent.message.timestamp ?? Date.now()).toISOString(),
      };
      for (const message of messageItems(item)) upsert(chat, message);
    }
    function applyMessageUpdate(piEvent: Extract<AgentSessionEvent, { type: "message_update" }>) {
      const update = piEvent.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
      const item = chat.items.find(
        (entry) => entry.type === "assistant" && entry.id === messageId(piEvent.message),
      );
      if (!item || item.type !== "assistant") return;
      if (update.type === "text_delta") item.text += update.delta;
      else item.thinking = `${item.thinking ?? ""}${update.delta}`;
    }
    function applyTool(
      piEvent: Extract<
        AgentSessionEvent,
        { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
      >,
    ) {
      if (piEvent.type === "tool_execution_start") {
        const args = bounded(piEvent.args, 800);
        upsert(chat, {
          type: "tool",
          id: piEvent.toolCallId,
          name: piEvent.toolName,
          argumentSummary: args.text,
          state: "running",
          preview: "",
          truncated: args.truncated,
        });
        return;
      }
      const running = piEvent.type === "tool_execution_update";
      const output = boundedResource(running ? piEvent.partialResult : piEvent.result);
      const preview = bounded(output.text);
      const previous = chat.items.find(
        (entry): entry is ToolItem => entry.type === "tool" && entry.id === piEvent.toolCallId,
      );
      let item: ToolItem = {
        type: "tool",
        id: piEvent.toolCallId,
        name: piEvent.toolName,
        argumentSummary: running ? bounded(piEvent.args, 800).text : "",
        state: running ? "running" : piEvent.isError ? "error" : "success",
        preview: preview.text,
        truncated: preview.truncated || output.sourceTruncated,
      };
      if (!item.argumentSummary && previous)
        item = { ...item, argumentSummary: previous.argumentSummary };
      if (item.truncated || output.sourceTruncated) {
        const resourceId = previous?.resourceId ?? randomUUID().replaceAll("-", "");
        chat.resources.set(resourceId, {
          id: resourceId,
          text: output.text,
          sourceTruncated: output.sourceTruncated,
        });
        item = { ...item, resourceId, outputSize: output.text.length, truncated: true };
      }
      upsert(chat, item);
    }
    function applyPiEvent(piEvent: AgentSessionEvent) {
      if (piEvent.type === "message_start" || piEvent.type === "message_end") applyMessage(piEvent);
      else if (piEvent.type === "message_update") applyMessageUpdate(piEvent);
      else if (
        piEvent.type === "tool_execution_start" ||
        piEvent.type === "tool_execution_update" ||
        piEvent.type === "tool_execution_end"
      )
        applyTool(piEvent);
      else if (piEvent.type === "queue_update") {
        chat.steering = [...piEvent.steering];
        chat.followUp = [...piEvent.followUp];
      }
    }
    if (event.type === "pi")
      return Effect.sync(() => {
        broadcastPi(chat, event.event);
        applyPiEvent(event.event);
      });
    if (event.type === "settled")
      return Effect.gen(function* () {
        const outcome = chat.abortRequested ? "cancelled" : "completed";
        if (chat.run) {
          yield* metadata.markPromptStatus(chat.sessionKey, chat.run.runId, outcome);
          chat.run = { ...chat.run, status: outcome, requiresAcknowledgement: false };
        }
        chat.abortRequested = false;
        chat.runStatus = "idle";
        broadcastRun(chat);
        yield* broadcastSession(chat);
      });
    return Effect.sync(() => {
      if (event.type === "notice") {
        handleNotice(chat, event);
      } else if (event.type === "context_usage") {
        broadcast(chat, { type: "context_usage", usage: event.usage });
      } else if (event.type === "dialog") {
        chat.extensionDialog = event.dialog;
        broadcast(chat, {
          type: "extension_dialog",
          ...(event.dialog ? { dialog: event.dialog } : {}),
        });
      }
    });
  }

  function handleNotice(
    chat: ChatRecord,
    event: { level: "warning" | "error" | "info"; text: string },
  ) {
    const item: Extract<TranscriptItem, { type: "notice" }> = {
      type: "notice",
      id: randomUUID().replaceAll("-", ""),
      level: event.level,
      text: event.text,
    };
    chat.items.push(item);
    broadcast(chat, { type: "notice", item });
  }

  function startPrompt(chat: ChatRecord, text: string, outcome: ActionOutcome) {
    return Effect.gen(function* () {
      disposableWorkspaces.delete(chat.workspaceId);
      chat.revision = Math.max(chat.revision, outcome.revision);
      if (outcome.replayed) return;
      if (!chat.session.state.isIdle)
        return yield* Effect.fail(
          serverError("chats.startPrompt", new Error("A run is already active")),
        );
      const runState = (status: "running" | "failed") => ({
        runId: outcome.runId,
        actionId: outcome.actionId,
        status,
        requiresAcknowledgement: false,
      });
      chat.run = runState("running");
      chat.runStatus = "running";
      yield* metadata.markPromptStatus(chat.sessionKey, outcome.runId, "running");
      broadcastRun(chat);
      yield* chat.session.prompt(text).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* metadata.markPromptStatus(chat.sessionKey, outcome.runId, "failed");
            chat.run = runState("failed");
            chat.runStatus = "error";
            handleNotice(chat, { level: "error", text: safeError(error) });
            broadcastRun(chat);
          }),
        ),
        Effect.forkIn(chat.scope),
      );
    });
  }

  function deliverDuringRun(
    chat: ChatRecord,
    text: string,
    delivery: "steer" | "follow-up",
    outcome: ActionOutcome,
  ) {
    return Effect.gen(function* () {
      yield* settleAction(chat, outcome, () =>
        delivery === "steer" ? chat.session.steer(text) : chat.session.followUp(text),
      );
      if (outcome.replayed) return outcome;
      broadcastRun(chat);
      return { ...outcome, status: "completed" } satisfies ActionOutcome;
    });
  }

  function abort(chat: ChatRecord, outcome: ActionOutcome) {
    return Effect.gen(function* () {
      chat.revision = Math.max(chat.revision, outcome.revision);
      if (outcome.replayed) return outcome;
      if (!chat.run || chat.run.runId !== outcome.runId)
        return yield* Effect.fail(
          serverError("chats.abort", new Error("Stop no longer targets the active run")),
        );
      chat.abortRequested = true;
      chat.runStatus = "stopping";
      broadcastRun(chat);
      yield* settleAction(chat, outcome, () => chat.session.abort());
      return { ...outcome, status: "completed" } satisfies ActionOutcome;
    });
  }

  function acknowledgeInterrupted(chat: ChatRecord, outcome: ActionOutcome) {
    chat.revision = outcome.revision;
    if (chat.run) chat.run = { ...chat.run, requiresAcknowledgement: false };
    broadcastRun(chat);
  }

  function performMutation<T, E, R>(
    chat: ChatRecord,
    outcome: ActionOutcome,
    work: () => Effect.Effect<T, E, R>,
  ) {
    return settleAction(chat, outcome, work).pipe(
      Effect.tap(() => Effect.sync(() => outcome.replayed || broadcastRun(chat))),
      Effect.tapError(() => Effect.sync(() => broadcastRun(chat))),
    );
  }

  /** Shared action protocol: bump the revision, replay without effects, then run and record. */
  function settleAction<T, E, R>(
    chat: ChatRecord,
    outcome: ActionOutcome,
    work: () => Effect.Effect<T, E, R>,
  ) {
    return Effect.gen(function* () {
      chat.revision = Math.max(chat.revision, outcome.revision);
      if (outcome.replayed) return undefined;
      return yield* work().pipe(
        Effect.tap(() => metadata.markActionStatus(outcome.actionId, "completed")),
        Effect.tapError(() => metadata.markActionStatus(outcome.actionId, "failed")),
      );
    });
  }

  function configure(chat: ChatRecord, input: Parameters<EffectAdapterSession["configure"]>[0]) {
    return Effect.gen(function* () {
      yield* chat.session.configure(input);
      yield* broadcastSession(chat);
      const contextUsage = chat.session.state.contextUsage;
      if (contextUsage) broadcast(chat, { type: "context_usage", usage: contextUsage });
    });
  }
  function rename(chat: ChatRecord, name: string) {
    return Effect.gen(function* () {
      yield* chat.session.rename(name);
      yield* broadcastSession(chat, name);
    });
  }
  function broadcastSession(chat: ChatRecord, name = chat.session.state.sessionName) {
    return Effect.gen(function* () {
      const stats = yield* chat.session.getStats();
      broadcast(chat, { type: "session", ...(name ? { name } : {}), stats });
    });
  }
  function compact(chat: ChatRecord, instructions?: string) {
    return Effect.sync(() => {
      chat.runStatus = "compacting";
      broadcastRun(chat);
    }).pipe(
      Effect.andThen(chat.session.compact(instructions)),
      Effect.ensuring(
        Effect.sync(() => {
          chat.runStatus = "idle";
          broadcastRun(chat);
        }),
      ),
    );
  }
  function dispose(chat: ChatRecord) {
    return Scope.close(chat.scope, Exit.void).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          chat.generation++;
          owners.delete(chat.sessionKey);
          chats.delete(chat.id);
          yield* Effect.forEach(chat.subscribers, Queue.shutdown, { discard: true });
          chat.subscribers.clear();
        }),
      ),
    );
  }
  function shutdown() {
    return Effect.forEach(
      [...chats.values()],
      (chat) =>
        Effect.gen(function* () {
          if (chat.run && (chat.run.status === "accepted" || chat.run.status === "running"))
            yield* metadata
              .markPromptStatus(chat.sessionKey, chat.run.runId, "interrupted")
              .pipe(Effect.catch(() => Effect.void));
          yield* dispose(chat);
        }),
      { discard: true },
    );
  }

  return {
    openWorkspace,
    workspace: getWorkspace,
    markWorkspaceDisposable,
    workspaceCanBeRemoved,
    forgetWorkspace,
    refreshSessions,
    create,
    resume,
    chat: getChat,
    snapshot,
    events,
    startPrompt,
    deliverDuringRun,
    abort,
    acknowledgeInterrupted,
    toolOutput,
    transcriptPage,
    performMutation,
    clear: (chat: ChatRecord) => chat.session.clearQueue(),
    configure,
    rename,
    compact,
    dispose,
    shutdown,
  };
}

export type ChatManager = ReturnType<typeof makeChatManager>;

/**
 * Coarsens run state down to what the sidebar needs. A live chat always wins over persisted
 * state (it is the more current source of truth); with no live chat, only a persisted failure
 * or an unacknowledged crash-interrupted run counts as "error" — everything else the server
 * knows (completed, cancelled, or an in-flight run left behind by a race) reads as idle rather
 * than inventing a status the server cannot actually stand behind.
 */
function resolveSessionStatus(
  liveRunStatus: ChatSnapshot["runStatus"] | undefined,
  persistedRun: RunOutcome | undefined,
): "running" | "error" | "idle" {
  if (liveRunStatus === "running" || liveRunStatus === "stopping" || liveRunStatus === "compacting")
    return "running";
  if (liveRunStatus === "error") return "error";
  if (liveRunStatus === "idle") return "idle";
  if (
    persistedRun?.status === "failed" ||
    (persistedRun?.status === "interrupted" && persistedRun.requiresAcknowledgement)
  )
    return "error";
  return "idle";
}

/**
 * Builds a SessionSummary for a live chat that Pi hasn't written to disk yet (no assistant
 * reply landed, so `SessionManager.list()` doesn't know about it), from only what the
 * in-memory ChatRecord actually knows — no invented timestamps beyond "now", no invented
 * message content.
 */
function liveOnlySession(chat: ChatRecord): SessionSummary {
  const firstUserItem = chat.items.find((item): item is TextItem => item.type === "user");
  const now = new Date().toISOString();
  return {
    id: chat.taskId,
    ...(chat.session.state.sessionName ? { name: chat.session.state.sessionName } : {}),
    firstMessage: (firstUserItem?.text ?? "").slice(0, 500),
    createdAt: now,
    modifiedAt: now,
    messageCount: chat.items.filter((item) => item.type === "user" || item.type === "assistant")
      .length,
    status: resolveSessionStatus(chat.runStatus, undefined),
  } satisfies SessionSummary;
}

function broadcast(chat: ChatRecord, event: EventPayload) {
  broadcastWithMeta(chat, makeServerEvent(chat, "pidex", event));
}

function broadcastPi(chat: ChatRecord, event: AgentSessionEvent) {
  broadcastWithMeta(chat, makeServerEvent(chat, "pi", event));
}

function makeServerEvent(
  chat: ChatRecord,
  source: "pidex",
  event: PidexEvent,
): Extract<ServerEvent, { source: "pidex" }>;
function makeServerEvent(
  chat: ChatRecord,
  source: "pi",
  event: AgentSessionEvent,
): Extract<ServerEvent, { source: "pi" }>;
function makeServerEvent(
  chat: ChatRecord,
  source: "pidex" | "pi",
  event: PidexEvent | AgentSessionEvent,
): ServerEvent {
  const envelope = { eventId: ++chat.eventId, chatId: chat.id, source, event };
  return source === "pi"
    ? (envelope as Extract<ServerEvent, { source: "pi" }>)
    : (envelope as Extract<ServerEvent, { source: "pidex" }>);
}

function broadcastWithMeta(chat: ChatRecord, event: ServerEvent) {
  const eventWithMeta = withEventMeta(event, {
    id: String(event.eventId),
    retry: LIVE_EVENT_RETRY_MS,
  });
  appendEvent(chat, eventWithMeta);
  for (const queue of chat.subscribers) Queue.offerUnsafe(queue, eventWithMeta);
}

function appendEvent(chat: ChatRecord, event: ServerEvent) {
  chat.events.push(event);
  if (chat.events.length > 500) chat.events.shift();
}

function upsert(chat: ChatRecord, item: TranscriptItem) {
  const index = chat.items.findIndex((entry) => entry.id === item.id);
  if (index >= 0) chat.items[index] = item;
  else chat.items.push(item);
}

function toolOutput(chat: ChatRecord, resourceId: string, offset: number, requestedLimit: number) {
  return Effect.fromNullishOr(chat.resources.get(resourceId)).pipe(
    Effect.mapError(() =>
      serverError(
        "chats.toolOutput",
        new Error("Tool output is no longer available; rerun the tool to regenerate it"),
      ),
    ),
    Effect.map((resource) => {
      const limit = Math.min(Math.max(requestedLimit, 1), 16_384);
      const safeOffset = Math.min(offset, resource.text.length);
      const text = resource.text.slice(safeOffset, safeOffset + limit);
      const nextOffset = safeOffset + text.length;
      return {
        resourceId,
        offset: safeOffset,
        nextOffset,
        total: resource.text.length,
        text,
        complete: nextOffset >= resource.text.length,
        sourceTruncated: resource.sourceTruncated,
      } satisfies ToolOutputChunk;
    }),
  );
}

function transcriptPage(
  chat: ChatRecord,
  requestedBefore: number,
  requestedLimit: number,
): TranscriptPage {
  const before = Math.min(Math.max(requestedBefore, 0), chat.items.length);
  const limit = Math.min(Math.max(requestedLimit, 1), 200);
  let start = before;
  let size = 0;
  while (start > 0 && before - start < limit) {
    const nextSize = JSON.stringify(chat.items[start - 1]).length;
    if (size > 0 && size + nextSize > 512_000) break;
    size += nextSize;
    start--;
  }
  return { items: chat.items.slice(start, before), start, total: chat.items.length };
}
