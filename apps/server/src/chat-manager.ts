import { randomUUID } from "node:crypto";
import type { ActionOutcome, ChatSnapshot, RunOutcome, ServerEvent, ToolOutputChunk, TranscriptItem, TranscriptPage, ToolItem, Workspace } from "@pidex/api";
import type { WebSocket } from "ws";
import type { AdapterEvent, AdapterSession, AdapterSessionInfo, PiAdapter } from "./adapter.js";
import type { MetadataStore } from "./metadata.js";

interface WorkspaceRecord { id: string; path: string; info: Awaited<ReturnType<PiAdapter["inspectWorkspace"]>> }
interface ToolResource { id: string; text: string; sourceTruncated: boolean }
interface ChatRecord {
  id: string;
  workspaceId: string;
  sessionOpaqueId: string;
  sessionKey: string;
  session: AdapterSession;
  toolMode: "read-only" | "full";
  revision: number;
  run?: RunOutcome;
  runStatus: ChatSnapshot["runStatus"];
  items: TranscriptItem[];
  steering: string[];
  followUp: string[];
  resources: Map<string, ToolResource>;
  eventId: number;
  events: ServerEvent[];
  sockets: Set<WebSocket>;
  generation: number;
  abortRequested: boolean;
  unsubscribe: () => void;
}
type EventPayload = ServerEvent extends infer Event ? Event extends ServerEvent ? Omit<Event, "eventId" | "chatId"> : never : never;

export class ChatManager {
  private workspaces = new Map<string, WorkspaceRecord>();
  private sessions = new Map<string, { opaque: string; info: AdapterSessionInfo; workspaceId: string }>();
  private chats = new Map<string, ChatRecord>();
  private owners = new Map<string, string>();

  constructor(readonly adapter: PiAdapter, private readonly metadata: MetadataStore) {}

  async openWorkspace(id: string, canonicalPath: string): Promise<Workspace> {
    const info = await this.adapter.inspectWorkspace(canonicalPath);
    const record = { id, path: canonicalPath, info };
    this.workspaces.set(id, record);
    const sessions = info.sessions.map((session) => {
      const key = session.nativePath ?? session.nativeId;
      let mapped = [...this.sessions.values()].find((entry) => (entry.info.nativePath ?? entry.info.nativeId) === key && entry.workspaceId === id);
      if (!mapped) {
        mapped = { opaque: randomUUID().replaceAll("-", ""), info: session, workspaceId: id };
        this.sessions.set(mapped.opaque, mapped);
      } else mapped.info = session;
      return { ...session, id: mapped.opaque };
    });
    return { id, path: canonicalPath, name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? canonicalPath, trusted: info.trusted, protectedResourcesSkipped: info.protectedResourcesSkipped, resourceDiagnostics: info.resourceDiagnostics, models: info.models, sessions, commands: info.commands };
  }

  workspace(id: string) {
    const value = this.workspaces.get(id);
    if (!value) throw new Error("Workspace is no longer open");
    return value;
  }

  async refreshSessions(workspaceId: string) {
    const ws = this.workspace(workspaceId);
    return (await this.openWorkspace(workspaceId, ws.path)).sessions;
  }

  private attach(workspaceId: string, session: AdapterSession, opaque?: string): ChatRecord {
    const sessionKey = session.nativePath ?? session.nativeId;
    const existingId = this.owners.get(sessionKey);
    if (existingId) return this.chat(existingId);
    const persisted = this.metadata.sessionState(sessionKey);
    const runIsActive = persisted.run?.status === "accepted" || persisted.run?.status === "running";
    const id = randomUUID().replaceAll("-", "");
    const sessionOpaqueId = opaque ?? randomUUID().replaceAll("-", "");
    const chat: ChatRecord = {
      id,
      workspaceId,
      sessionOpaqueId,
      sessionKey,
      session,
      toolMode: "read-only",
      revision: persisted.revision,
      ...(persisted.run ? { run: persisted.run } : {}),
      runStatus: runIsActive ? "running" : "idle",
      items: [...session.messages],
      steering: [],
      followUp: [],
      resources: new Map(),
      eventId: 0,
      events: [],
      sockets: new Set<WebSocket>(),
      generation: 1,
      abortRequested: false,
      unsubscribe: () => {},
    };
    const generation = chat.generation;
    chat.unsubscribe = session.subscribe((event) => { if (chat.generation === generation) this.handle(chat, event); });
    this.chats.set(id, chat);
    this.owners.set(sessionKey, id);
    return chat;
  }

  async create(workspaceId: string) {
    const ws = this.workspace(workspaceId);
    return this.attach(workspaceId, await this.adapter.createSession(ws.path, "read-only"));
  }

  async resume(workspaceId: string, opaque: string) {
    const ws = this.workspace(workspaceId);
    const fresh = await this.adapter.inspectWorkspace(ws.path);
    ws.info = fresh;
    const mapped = this.sessions.get(opaque);
    if (!mapped || mapped.workspaceId !== workspaceId) throw new Error("Session ID is invalid or stale");
    const listed = fresh.sessions.find((entry) => (entry.nativePath ?? entry.nativeId) === (mapped.info.nativePath ?? mapped.info.nativeId));
    if (!listed?.nativePath) throw new Error("Session no longer exists");
    const owner = this.owners.get(listed.nativePath);
    if (owner) return this.chat(owner);
    return this.attach(workspaceId, await this.adapter.resumeSession(ws.path, listed.nativePath), opaque);
  }

  chat(id: string) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error("Chat was not found");
    return chat;
  }

  snapshot(chat: ChatRecord): ChatSnapshot {
    const transcript = this.transcriptPage(chat, chat.items.length, 200);
    return {
      chatId: chat.id,
      workspaceId: chat.workspaceId,
      sessionId: chat.sessionOpaqueId,
      ...(chat.session.sessionName ? { sessionName: chat.session.sessionName } : {}),
      revision: chat.revision,
      ...(chat.run ? { run: chat.run } : {}),
      runStatus: chat.runStatus,
      ...(chat.session.model ? { model: chat.session.model } : {}),
      thinkingLevel: chat.session.thinkingLevel,
      toolMode: chat.toolMode,
      activeTools: chat.session.activeTools,
      items: transcript.items,
      transcriptStart: transcript.start,
      transcriptTotal: transcript.total,
      steeringQueue: chat.steering,
      followUpQueue: chat.followUp,
      stats: chat.session.getStats(),
    };
  }

  private broadcast(chat: ChatRecord, event: EventPayload) {
    const full = { ...event, eventId: ++chat.eventId, chatId: chat.id } as ServerEvent;
    chat.events.push(full);
    if (chat.events.length > 500) chat.events.shift();
    const data = JSON.stringify(full);
    for (const socket of chat.sockets) if (socket.readyState === 1) socket.send(data);
  }

  private broadcastRun(chat: ChatRecord) {
    this.broadcast(chat, { type: "run_status", status: chat.runStatus, revision: chat.revision, ...(chat.run ? { run: chat.run } : {}) });
  }

  sendSnapshot(chat: ChatRecord, socket: WebSocket) {
    const event = { type: "snapshot", eventId: ++chat.eventId, chatId: chat.id, snapshot: this.snapshot(chat) } as ServerEvent;
    chat.events.push(event);
    socket.send(JSON.stringify(event));
  }

  connect(chat: ChatRecord, socket: WebSocket, lastEventId?: number) {
    chat.sockets.add(socket);
    const first = chat.events[0]?.eventId;
    if (lastEventId !== undefined && first !== undefined && lastEventId >= first - 1 && lastEventId <= chat.eventId) {
      for (const event of chat.events) if (event.eventId > lastEventId) socket.send(JSON.stringify(event));
    } else this.sendSnapshot(chat, socket);
    socket.once("close", () => chat.sockets.delete(socket));
  }

  private upsert(chat: ChatRecord, item: TranscriptItem) {
    const index = chat.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) chat.items[index] = item;
    else chat.items.push(item);
  }

  private handle(chat: ChatRecord, event: AdapterEvent) {
    if (event.type === "message") {
      this.upsert(chat, event.item);
      this.broadcast(chat, { type: "message", item: event.item });
    } else if (event.type === "delta") {
      const item = chat.items.find((entry) => entry.type !== "notice" && entry.id === event.itemId);
      if (item?.type === "assistant") {
        if (event.channel === "text") item.text += event.delta;
        else item.thinking = `${item.thinking ?? ""}${event.delta}`;
      }
      this.broadcast(chat, { type: "text_delta", itemId: event.itemId, delta: event.delta, channel: event.channel });
    } else if (event.type === "tool") {
      const previous = chat.items.find((entry): entry is ToolItem => entry.type === "tool" && entry.id === event.item.id);
      let item = event.item.argumentSummary || !previous ? event.item : { ...event.item, argumentSummary: previous.argumentSummary };
      if (event.output && (item.truncated || event.output.sourceTruncated)) {
        const resourceId = previous?.resourceId ?? randomUUID().replaceAll("-", "");
        chat.resources.set(resourceId, { id: resourceId, text: event.output.text, sourceTruncated: event.output.sourceTruncated });
        item = { ...item, resourceId, outputSize: event.output.text.length, truncated: true };
      }
      this.upsert(chat, item);
      this.broadcast(chat, { type: "tool", item });
    } else if (event.type === "queue") {
      chat.steering = event.steering;
      chat.followUp = event.followUp;
      this.broadcast(chat, { type: "queue", steering: event.steering, followUp: event.followUp });
    } else if (event.type === "notice") {
      const item = { type: "notice" as const, id: randomUUID().replaceAll("-", ""), level: event.level, text: event.text };
      chat.items.push(item);
      this.broadcast(chat, { type: "notice", item });
    } else if (event.type === "dialog") {
      this.broadcast(chat, { type: "extension_dialog", ...(event.dialog ? { dialog: event.dialog } : {}) });
    } else if (event.type === "settled") {
      const outcome = chat.abortRequested ? "cancelled" : "completed";
      if (chat.run) {
        this.metadata.markPromptStatus(chat.sessionKey, chat.run.runId, outcome);
        chat.run = { ...chat.run, status: outcome, requiresAcknowledgement: false };
      }
      chat.abortRequested = false;
      chat.runStatus = "idle";
      this.broadcastRun(chat);
      this.broadcast(chat, { type: "session", ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}), stats: chat.session.getStats() });
    }
  }

  startPrompt(chat: ChatRecord, text: string, outcome: ActionOutcome) {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return;
    if (!chat.session.isIdle) throw new Error("A run is already active");
    chat.run = { runId: outcome.runId, actionId: outcome.actionId, status: "running", requiresAcknowledgement: false };
    chat.runStatus = "running";
    this.metadata.markPromptStatus(chat.sessionKey, outcome.runId, "running");
    this.broadcastRun(chat);
    void chat.session.prompt(text).catch((error) => {
      this.metadata.markPromptStatus(chat.sessionKey, outcome.runId, "failed");
      chat.run = { runId: outcome.runId, actionId: outcome.actionId, status: "failed", requiresAcknowledgement: false };
      chat.runStatus = "error";
      this.handle(chat, { type: "notice", level: "error", text: error instanceof Error ? error.message : "Prompt failed" });
      this.broadcastRun(chat);
    });
  }

  async deliverDuringRun(chat: ChatRecord, text: string, delivery: "steer" | "follow-up", outcome: ActionOutcome): Promise<ActionOutcome> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return outcome;
    try {
      if (delivery === "steer") await chat.session.steer(text);
      else await chat.session.followUp(text);
      this.metadata.markActionStatus(outcome.actionId, "completed");
      this.broadcastRun(chat);
      return { ...outcome, status: "completed" };
    } catch (error) {
      this.metadata.markActionStatus(outcome.actionId, "failed");
      throw error;
    }
  }

  async abort(chat: ChatRecord, outcome: ActionOutcome): Promise<ActionOutcome> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return outcome;
    if (!chat.run || chat.run.runId !== outcome.runId) throw new Error("Stop no longer targets the active run");
    chat.abortRequested = true;
    chat.runStatus = "stopping";
    this.broadcastRun(chat);
    try {
      await chat.session.abort();
      this.metadata.markActionStatus(outcome.actionId, "completed");
      return { ...outcome, status: "completed" };
    } catch (error) {
      this.metadata.markActionStatus(outcome.actionId, "failed");
      throw error;
    }
  }

  acknowledgeInterrupted(chat: ChatRecord, outcome: ActionOutcome) {
    chat.revision = outcome.revision;
    if (chat.run) chat.run = { ...chat.run, requiresAcknowledgement: false };
    this.broadcastRun(chat);
  }

  toolOutput(chat: ChatRecord, resourceId: string, offset: number, requestedLimit: number): ToolOutputChunk {
    const resource = chat.resources.get(resourceId);
    if (!resource) throw new Error("Tool output is no longer available; rerun the tool to regenerate it");
    const limit = Math.min(Math.max(requestedLimit, 1), 16_384);
    const safeOffset = Math.min(offset, resource.text.length);
    const text = resource.text.slice(safeOffset, safeOffset + limit);
    const nextOffset = safeOffset + text.length;
    return { resourceId, offset: safeOffset, nextOffset, total: resource.text.length, text, complete: nextOffset >= resource.text.length, sourceTruncated: resource.sourceTruncated };
  }

  transcriptPage(chat: ChatRecord, requestedBefore: number, requestedLimit: number): TranscriptPage {
    const before = Math.min(Math.max(requestedBefore, 0), chat.items.length);
    const limit = Math.min(Math.max(requestedLimit, 1), 200);
    let start = before;
    let size = 0;
    while (start > 0 && before - start < limit) {
      const nextSize = JSON.stringify(chat.items[start - 1]).length;
      if (size > 0 && size + nextSize > 512_000) break;
      size += nextSize; start--;
    }
    return { items: chat.items.slice(start, before), start, total: chat.items.length };
  }

  async performMutation<T>(chat: ChatRecord, outcome: ActionOutcome, work: () => T | Promise<T>): Promise<T | undefined> {
    chat.revision = Math.max(chat.revision, outcome.revision);
    if (outcome.replayed) return undefined;
    try { const value = await work(); this.metadata.markActionStatus(outcome.actionId, "completed"); this.broadcastRun(chat); return value; }
    catch (error) { this.metadata.markActionStatus(outcome.actionId, "failed"); this.broadcastRun(chat); throw error; }
  }

  clear(chat: ChatRecord) { chat.session.clearQueue(); }
  async configure(chat: ChatRecord, input: Parameters<AdapterSession["configure"]>[0]) { await chat.session.configure(input); if (input.toolMode) chat.toolMode = input.toolMode; this.broadcast(chat, { type: "session", ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}), stats: chat.session.getStats() }); }
  rename(chat: ChatRecord, name: string) { chat.session.rename(name); this.broadcast(chat, { type: "session", name, stats: chat.session.getStats() }); }
  async compact(chat: ChatRecord, instructions?: string) { chat.runStatus = "compacting"; this.broadcastRun(chat); try { await chat.session.compact(instructions); } finally { chat.runStatus = "idle"; this.broadcastRun(chat); } }
  dispose(chat: ChatRecord) { chat.generation++; chat.unsubscribe(); chat.session.dispose(); this.owners.delete(chat.sessionKey); this.chats.delete(chat.id); for (const socket of chat.sockets) socket.close(1001, "Chat disposed"); }
  shutdown() { for (const chat of [...this.chats.values()]) { if (chat.run && (chat.run.status === "accepted" || chat.run.status === "running")) this.metadata.markPromptStatus(chat.sessionKey, chat.run.runId, "interrupted"); this.dispose(chat); } }
}
