import { randomUUID } from "node:crypto";
import type {
  ActionOutcome,
  ChatSnapshot,
  ExtensionDialog,
  RunOutcome,
  ServerEvent,
  SessionSummary,
  ToolOutputChunk,
  TranscriptItem,
  TranscriptPage,
  ToolItem,
  Workspace,
} from "@pidex/api";
import type { WebSocket } from "ws";
import type { AdapterEvent, AdapterSession, AdapterSessionInfo } from "./adapter.js";
import type { MetadataStore } from "./metadata.js";
import type { PiSdk } from "./pi-sdk.js";
import { safeError } from "./security.js";

interface WorkspaceRecord {
  id: string;
  path: string;
  info: Awaited<ReturnType<PiSdk["inspectWorkspace"]>>;
}
interface ToolResource {
  id: string;
  text: string;
  sourceTruncated: boolean;
}
type NativeSessionReference =
  | Pick<AdapterSession, "nativeId" | "nativePath">
  | Pick<AdapterSessionInfo, "nativeId" | "nativePath">;

const nativeSessionKey = (session: NativeSessionReference) =>
  session.nativePath ?? session.nativeId;

interface ChatRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  sessionKey: string;
  session: AdapterSession;
  revision: number;
  run?: RunOutcome;
  runStatus: ChatSnapshot["runStatus"];
  items: TranscriptItem[];
  steering: string[];
  followUp: string[];
  extensionDialog: ExtensionDialog | undefined;
  resources: Map<string, ToolResource>;
  eventId: number;
  events: ServerEvent[];
  sockets: Set<WebSocket>;
  generation: number;
  abortRequested: boolean;
  unsubscribe: () => void;
}
type EventPayload = ServerEvent extends infer Event
  ? Event extends ServerEvent
    ? Omit<Event, "eventId" | "chatId">
    : never
  : never;

export function makeChatManager(pi: PiSdk, metadata: MetadataStore) {
  const workspaces = new Map<string, WorkspaceRecord>();
  const chats = new Map<string, ChatRecord>();
  const owners = new Map<string, string>();
  const disposableWorkspaces = new Set<string>();

  function publicSession(workspaceId: string, info: AdapterSessionInfo): SessionSummary {
    const workspaceRecord = getWorkspace(workspaceId);
    return {
      id: metadata.rememberTask(workspaceId, workspaceRecord.path, nativeSessionKey(info)),
      ...(info.name ? { name: info.name } : {}),
      firstMessage: info.firstMessage,
      createdAt: info.createdAt,
      modifiedAt: info.modifiedAt,
      messageCount: info.messageCount,
    };
  }

  async function openWorkspace(id: string, canonicalPath: string): Promise<Workspace> {
    const info = await pi.inspectWorkspace(canonicalPath);
    const record = { id, path: canonicalPath, info };
    workspaces.set(id, record);
    const sessions = info.sessions.map((session) => publicSession(id, session));
    return {
      id,
      path: canonicalPath,
      name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? canonicalPath,
      trusted: info.trusted,
      protectedResourcesSkipped: info.protectedResourcesSkipped,
      resourceDiagnostics: info.resourceDiagnostics,
      models: info.models,
      sessions,
      commands: info.commands,
    };
  }

  function getWorkspace(id: string) {
    const value = workspaces.get(id);
    if (!value) throw new Error("Workspace is no longer open");
    return value;
  }

  function markWorkspaceDisposable(id: string) {
    getWorkspace(id);
    disposableWorkspaces.add(id);
  }

  function workspaceCanBeRemoved(id: string) {
    const workspace = getWorkspace(id);
    const workspaceChats = [...chats.values()].filter((chat) => chat.workspaceId === id);
    return (
      disposableWorkspaces.has(id) &&
      workspace.info.sessions.every((session) => session.messageCount === 0) &&
      workspaceChats.every(
        (chat) => chat.items.length === 0 && ["idle", "error"].includes(chat.runStatus),
      )
    );
  }

  function forgetWorkspace(id: string) {
    if (!workspaceCanBeRemoved(id)) throw new Error("Workspace cannot be removed");
    const workspaceChats = [...chats.values()].filter((chat) => chat.workspaceId === id);
    for (const chat of workspaceChats) dispose(chat);
    disposableWorkspaces.delete(id);
    workspaces.delete(id);
  }

  async function refreshSessions(workspaceId: string) {
    const ws = getWorkspace(workspaceId);
    return (await openWorkspace(workspaceId, ws.path)).sessions;
  }

  function attach(workspaceId: string, session: AdapterSession, taskId?: string): ChatRecord {
    const sessionKey = nativeSessionKey(session);
    const existingId = owners.get(sessionKey);
    if (existingId) return getChat(existingId);
    const persisted = metadata.sessionState(sessionKey);
    const runIsActive = persisted.run?.status === "accepted" || persisted.run?.status === "running";
    const id = randomUUID().replaceAll("-", "");
    const workspaceRecord = getWorkspace(workspaceId);
    const persistedTaskId =
      taskId ?? metadata.rememberTask(workspaceId, workspaceRecord.path, sessionKey);
    const chat: ChatRecord = {
      id,
      workspaceId,
      taskId: persistedTaskId,
      sessionKey,
      session,
      revision: persisted.revision,
      ...(persisted.run ? { run: persisted.run } : {}),
      runStatus: runIsActive ? "running" : "idle",
      items: [...session.messages],
      steering: [],
      followUp: [],
      extensionDialog: undefined,
      resources: new Map(),
      eventId: 0,
      events: [],
      sockets: new Set<WebSocket>(),
      generation: 1,
      abortRequested: false,
      unsubscribe: () => {},
    };
    const generation = chat.generation;
    chat.unsubscribe = session.subscribe((event) => {
      if (chat.generation === generation) handle(chat, event);
    });
    chats.set(id, chat);
    owners.set(sessionKey, id);
    return chat;
  }

  async function create(workspaceId: string) {
    const ws = getWorkspace(workspaceId);
    const session = await pi.createSession(ws.path);
    const fresh = await pi.inspectWorkspace(ws.path);
    ws.info = fresh;
    return attach(workspaceId, session);
  }

  async function resume(taskId: string) {
    const active = [...chats.values()].find((chat) => chat.taskId === taskId);
    if (active) return active;
    const persisted = metadata.task(taskId);
    if (!persisted) throw new Error("Task no longer exists");
    let ws = workspaces.get(persisted.workspaceId);
    if (!ws) {
      await openWorkspace(persisted.workspaceId, persisted.workspacePath);
      ws = getWorkspace(persisted.workspaceId);
    }
    const fresh = await pi.inspectWorkspace(ws.path);
    ws.info = fresh;
    const listed = fresh.sessions.find((entry) => nativeSessionKey(entry) === persisted.sessionKey);
    if (!listed?.nativePath) throw new Error("Session no longer exists");
    const owner = owners.get(listed.nativePath);
    if (owner) return getChat(owner);
    return attach(
      persisted.workspaceId,
      await pi.resumeSession(ws.path, listed.nativePath),
      taskId,
    );
  }

  function getChat(id: string) {
    const chat = chats.get(id);
    if (!chat) throw new Error("Chat was not found");
    return chat;
  }

  function snapshot(chat: ChatRecord): ChatSnapshot {
    const transcript = transcriptPage(chat, chat.items.length, 200);
    const contextUsage = chat.session.contextUsage;
    return {
      chatId: chat.id,
      workspaceId: chat.workspaceId,
      taskId: chat.taskId,
      ...(chat.session.sessionName ? { sessionName: chat.session.sessionName } : {}),
      revision: chat.revision,
      ...(chat.run ? { run: chat.run } : {}),
      runStatus: chat.runStatus,
      ...(chat.session.model ? { model: chat.session.model } : {}),
      thinkingLevel: chat.session.thinkingLevel,
      items: transcript.items,
      transcriptStart: transcript.start,
      transcriptTotal: transcript.total,
      steeringQueue: chat.steering,
      followUpQueue: chat.followUp,
      stats: chat.session.getStats(),
      ...(contextUsage ? { contextUsage } : {}),
      ...(chat.extensionDialog ? { extensionDialog: chat.extensionDialog } : {}),
    };
  }

  function broadcastRun(chat: ChatRecord) {
    broadcast(chat, {
      type: "run_status",
      status: chat.runStatus,
      revision: chat.revision,
      ...(chat.run ? { run: chat.run } : {}),
    });
  }

  function sendSnapshot(chat: ChatRecord, socket: WebSocket) {
    const event = {
      type: "snapshot",
      eventId: ++chat.eventId,
      chatId: chat.id,
      snapshot: snapshot(chat),
    } as ServerEvent;
    chat.events.push(event);
    socket.send(JSON.stringify(event));
  }

  function connect(chat: ChatRecord, socket: WebSocket, lastEventId?: number) {
    chat.sockets.add(socket);
    const first = chat.events[0]?.eventId;
    if (
      lastEventId !== undefined &&
      first !== undefined &&
      lastEventId >= first - 1 &&
      lastEventId <= chat.eventId
    ) {
      for (const event of chat.events)
        if (event.eventId > lastEventId) socket.send(JSON.stringify(event));
    } else sendSnapshot(chat, socket);
    socket.once("close", () => chat.sockets.delete(socket));
  }

  function handle(chat: ChatRecord, event: AdapterEvent) {
    if (event.type === "message") {
      upsert(chat, event.item);
      broadcast(chat, { type: "message", item: event.item });
    } else if (event.type === "delta") {
      const item = chat.items.find((entry) => entry.type !== "notice" && entry.id === event.itemId);
      if (item?.type === "assistant") {
        if (event.channel === "text") item.text += event.delta;
        else item.thinking = `${item.thinking ?? ""}${event.delta}`;
      }
      broadcast(chat, {
        type: "text_delta",
        itemId: event.itemId,
        delta: event.delta,
        channel: event.channel,
      });
    } else if (event.type === "tool") {
      const previous = chat.items.find(
        (entry): entry is ToolItem => entry.type === "tool" && entry.id === event.item.id,
      );
      let item =
        event.item.argumentSummary || !previous
          ? event.item
          : { ...event.item, argumentSummary: previous.argumentSummary };
      if (event.output && (item.truncated || event.output.sourceTruncated)) {
        const resourceId = previous?.resourceId ?? randomUUID().replaceAll("-", "");
        chat.resources.set(resourceId, {
          id: resourceId,
          text: event.output.text,
          sourceTruncated: event.output.sourceTruncated,
        });
        item = { ...item, resourceId, outputSize: event.output.text.length, truncated: true };
      }
      upsert(chat, item);
      broadcast(chat, { type: "tool", item });
    } else if (event.type === "queue") {
      chat.steering = event.steering;
      chat.followUp = event.followUp;
      broadcast(chat, { type: "queue", steering: event.steering, followUp: event.followUp });
    } else if (event.type === "notice") {
      const item: Extract<TranscriptItem, { type: "notice" }> = {
        type: "notice",
        id: randomUUID().replaceAll("-", ""),
        level: event.level,
        text: event.text,
      };
      chat.items.push(item);
      broadcast(chat, { type: "notice", item });
    } else if (event.type === "context_usage") {
      broadcast(chat, { type: "context_usage", usage: event.usage });
    } else if (event.type === "dialog") {
      chat.extensionDialog = event.dialog;
      broadcast(chat, {
        type: "extension_dialog",
        ...(event.dialog ? { dialog: event.dialog } : {}),
      });
    } else if (event.type === "settled") {
      const outcome = chat.abortRequested ? "cancelled" : "completed";
      if (chat.run) {
        metadata.markPromptStatus(chat.sessionKey, chat.run.runId, outcome);
        chat.run = { ...chat.run, status: outcome, requiresAcknowledgement: false };
      }
      chat.abortRequested = false;
      chat.runStatus = "idle";
      broadcastRun(chat);
      broadcast(chat, {
        type: "session",
        ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}),
        stats: chat.session.getStats(),
      });
    }
  }

  function startPrompt(chat: ChatRecord, text: string, outcome: ActionOutcome) {
    disposableWorkspaces.delete(chat.workspaceId);
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return;
    if (!chat.session.isIdle) throw new Error("A run is already active");
    chat.run = {
      runId: outcome.runId,
      actionId: outcome.actionId,
      status: "running",
      requiresAcknowledgement: false,
    };
    chat.runStatus = "running";
    metadata.markPromptStatus(chat.sessionKey, outcome.runId, "running");
    broadcastRun(chat);
    void chat.session.prompt(text).catch((error) => {
      metadata.markPromptStatus(chat.sessionKey, outcome.runId, "failed");
      chat.run = {
        runId: outcome.runId,
        actionId: outcome.actionId,
        status: "failed",
        requiresAcknowledgement: false,
      };
      chat.runStatus = "error";
      handle(chat, {
        type: "notice",
        level: "error",
        text: safeError(error),
      });
      broadcastRun(chat);
    });
  }

  async function deliverDuringRun(
    chat: ChatRecord,
    text: string,
    delivery: "steer" | "follow-up",
    outcome: ActionOutcome,
  ): Promise<ActionOutcome> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return outcome;
    try {
      if (delivery === "steer") await chat.session.steer(text);
      else await chat.session.followUp(text);
      metadata.markActionStatus(outcome.actionId, "completed");
      broadcastRun(chat);
      return { ...outcome, status: "completed" };
    } catch (error) {
      metadata.markActionStatus(outcome.actionId, "failed");
      throw error;
    }
  }

  async function abort(chat: ChatRecord, outcome: ActionOutcome): Promise<ActionOutcome> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return outcome;
    if (!chat.run || chat.run.runId !== outcome.runId)
      throw new Error("Stop no longer targets the active run");
    chat.abortRequested = true;
    chat.runStatus = "stopping";
    broadcastRun(chat);
    try {
      await chat.session.abort();
      metadata.markActionStatus(outcome.actionId, "completed");
      return { ...outcome, status: "completed" };
    } catch (error) {
      metadata.markActionStatus(outcome.actionId, "failed");
      throw error;
    }
  }

  function acknowledgeInterrupted(chat: ChatRecord, outcome: ActionOutcome) {
    chat.revision = outcome.revision;
    if (chat.run) chat.run = { ...chat.run, requiresAcknowledgement: false };
    broadcastRun(chat);
  }

  async function performMutation<T>(
    chat: ChatRecord,
    outcome: ActionOutcome,
    work: () => T | Promise<T>,
  ): Promise<T | undefined> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return undefined;
    try {
      const value = await work();
      metadata.markActionStatus(outcome.actionId, "completed");
      broadcastRun(chat);
      return value;
    } catch (error) {
      metadata.markActionStatus(outcome.actionId, "failed");
      broadcastRun(chat);
      throw error;
    }
  }

  async function configure(chat: ChatRecord, input: Parameters<AdapterSession["configure"]>[0]) {
    await chat.session.configure(input);
    broadcast(chat, {
      type: "session",
      ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}),
      stats: chat.session.getStats(),
    });
    const contextUsage = chat.session.contextUsage;
    if (contextUsage) broadcast(chat, { type: "context_usage", usage: contextUsage });
  }
  function rename(chat: ChatRecord, name: string) {
    chat.session.rename(name);
    broadcast(chat, { type: "session", name, stats: chat.session.getStats() });
  }
  async function compact(chat: ChatRecord, instructions?: string) {
    chat.runStatus = "compacting";
    broadcastRun(chat);
    try {
      await chat.session.compact(instructions);
    } finally {
      chat.runStatus = "idle";
      broadcastRun(chat);
    }
  }
  function dispose(chat: ChatRecord) {
    chat.generation++;
    chat.unsubscribe();
    chat.session.dispose();
    owners.delete(chat.sessionKey);
    chats.delete(chat.id);
    for (const socket of chat.sockets) socket.close(1001, "Chat disposed");
  }
  function shutdown() {
    for (const chat of chats.values()) {
      if (chat.run && (chat.run.status === "accepted" || chat.run.status === "running"))
        metadata.markPromptStatus(chat.sessionKey, chat.run.runId, "interrupted");
      dispose(chat);
    }
  }
  return {
    pi,
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
    sendSnapshot,
    connect,
    startPrompt,
    deliverDuringRun,
    abort,
    acknowledgeInterrupted,
    toolOutput,
    transcriptPage,
    performMutation,
    clear,
    configure,
    rename,
    compact,
    dispose,
    shutdown,
  };
}

export type ChatManager = ReturnType<typeof makeChatManager>;

function broadcast(chat: ChatRecord, event: EventPayload) {
  const full = { ...event, eventId: ++chat.eventId, chatId: chat.id } as ServerEvent;
  chat.events.push(full);
  if (chat.events.length > 500) chat.events.shift();
  const data = JSON.stringify(full);
  for (const socket of chat.sockets) if (socket.readyState === 1) socket.send(data);
}

function upsert(chat: ChatRecord, item: TranscriptItem) {
  const index = chat.items.findIndex((entry) => entry.id === item.id);
  if (index >= 0) chat.items[index] = item;
  else chat.items.push(item);
}

function toolOutput(
  chat: ChatRecord,
  resourceId: string,
  offset: number,
  requestedLimit: number,
): ToolOutputChunk {
  const resource = chat.resources.get(resourceId);
  if (!resource)
    throw new Error("Tool output is no longer available; rerun the tool to regenerate it");
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
  };
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

function clear(chat: ChatRecord) {
  chat.session.clearQueue();
}
