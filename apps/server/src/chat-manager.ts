import { randomUUID } from "node:crypto";
import type { ChatSnapshot, ServerEvent, TranscriptItem, ToolItem, Workspace } from "@pidex/api";
import type { WebSocket } from "ws";
import type { AdapterEvent, AdapterSession, AdapterSessionInfo, PiAdapter } from "./adapter.js";

interface WorkspaceRecord { id: string; path: string; info: Awaited<ReturnType<PiAdapter["inspectWorkspace"]>> }
interface ChatRecord { id: string; workspaceId: string; sessionOpaqueId: string; session: AdapterSession; toolMode: "read-only" | "full"; runStatus: ChatSnapshot["runStatus"]; items: TranscriptItem[]; steering: string[]; followUp: string[]; eventId: number; events: ServerEvent[]; sockets: Set<WebSocket>; generation: number; unsubscribe: () => void }
type EventPayload = ServerEvent extends infer Event ? Event extends ServerEvent ? Omit<Event, "eventId" | "chatId"> : never : never;
export class ChatManager {
  private workspaces = new Map<string, WorkspaceRecord>();
  private sessions = new Map<string, { opaque: string; info: AdapterSessionInfo; workspaceId: string }>();
  private chats = new Map<string, ChatRecord>();
  private owners = new Map<string, string>();
  constructor(readonly adapter: PiAdapter) {}
  async openWorkspace(id: string, canonicalPath: string): Promise<Workspace> {
    const info = await this.adapter.inspectWorkspace(canonicalPath); const record = { id, path: canonicalPath, info }; this.workspaces.set(id, record);
    const sessions = info.sessions.map((session) => { const key = session.nativePath ?? session.nativeId; let mapped = [...this.sessions.values()].find((entry) => (entry.info.nativePath ?? entry.info.nativeId) === key && entry.workspaceId === id); if (!mapped) { mapped = { opaque: randomUUID().replaceAll("-", ""), info: session, workspaceId: id }; this.sessions.set(mapped.opaque, mapped); } else mapped.info = session; return { ...session, id: mapped.opaque }; });
    return { id, path: canonicalPath, name: canonicalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? canonicalPath, trusted: info.trusted, protectedResourcesSkipped: info.protectedResourcesSkipped, models: info.models, sessions, commands: info.commands };
  }
  workspace(id: string) { const value = this.workspaces.get(id); if (!value) throw new Error("Workspace is no longer open"); return value; }
  async refreshSessions(workspaceId: string) { const ws = this.workspace(workspaceId); return (await this.openWorkspace(workspaceId, ws.path)).sessions; }
  private attach(workspaceId: string, session: AdapterSession, opaque?: string): ChatRecord {
    const nativeKey = session.nativePath ?? session.nativeId; const existingId = this.owners.get(nativeKey); if (existingId) return this.chat(existingId);
    const id = randomUUID().replaceAll("-", ""); const sessionOpaqueId = opaque ?? randomUUID().replaceAll("-", "");
    const chat = { id, workspaceId, sessionOpaqueId, session, toolMode: "read-only" as const, runStatus: "idle" as const, items: [...session.messages], steering: [], followUp: [], eventId: 0, events: [], sockets: new Set<WebSocket>(), generation: 1, unsubscribe: () => {} };
    const generation = chat.generation; chat.unsubscribe = session.subscribe((event) => { if (chat.generation === generation) this.handle(chat, event); });
    this.chats.set(id, chat); this.owners.set(nativeKey, id); return chat;
  }
  async create(workspaceId: string) { const ws = this.workspace(workspaceId); return this.attach(workspaceId, await this.adapter.createSession(ws.path, "read-only")); }
  async resume(workspaceId: string, opaque: string) {
    const ws = this.workspace(workspaceId); const fresh = await this.adapter.inspectWorkspace(ws.path); ws.info = fresh;
    const mapped = this.sessions.get(opaque); if (!mapped || mapped.workspaceId !== workspaceId) throw new Error("Session ID is invalid or stale");
    const listed = fresh.sessions.find((entry) => (entry.nativePath ?? entry.nativeId) === (mapped.info.nativePath ?? mapped.info.nativeId)); if (!listed?.nativePath) throw new Error("Session no longer exists");
    const owner = this.owners.get(listed.nativePath); if (owner) return this.chat(owner);
    return this.attach(workspaceId, await this.adapter.resumeSession(ws.path, listed.nativePath), opaque);
  }
  chat(id: string) { const chat = this.chats.get(id); if (!chat) throw new Error("Chat was not found"); return chat; }
  snapshot(chat: ChatRecord): ChatSnapshot { return { chatId: chat.id, workspaceId: chat.workspaceId, sessionId: chat.sessionOpaqueId, ...(chat.session.sessionName ? { sessionName: chat.session.sessionName } : {}), runStatus: chat.runStatus, ...(chat.session.model ? { model: chat.session.model } : {}), thinkingLevel: chat.session.thinkingLevel, toolMode: chat.toolMode, activeTools: chat.session.activeTools, items: chat.items, steeringQueue: chat.steering, followUpQueue: chat.followUp, stats: chat.session.getStats() }; }
  private broadcast(chat: ChatRecord, event: EventPayload) { const full = { ...event, eventId: ++chat.eventId, chatId: chat.id } as ServerEvent; chat.events.push(full); if (chat.events.length > 500) chat.events.shift(); const data = JSON.stringify(full); for (const socket of chat.sockets) if (socket.readyState === 1) socket.send(data); }
  sendSnapshot(chat: ChatRecord, socket: WebSocket) { const event = { type: "snapshot", eventId: ++chat.eventId, chatId: chat.id, snapshot: this.snapshot(chat) } as ServerEvent; chat.events.push(event); socket.send(JSON.stringify(event)); }
  connect(chat: ChatRecord, socket: WebSocket, lastEventId?: number) { chat.sockets.add(socket); const first = chat.events[0]?.eventId; if (lastEventId !== undefined && first !== undefined && lastEventId >= first - 1) { for (const event of chat.events) if (event.eventId > lastEventId) socket.send(JSON.stringify(event)); } else this.sendSnapshot(chat, socket); socket.once("close", () => chat.sockets.delete(socket)); }
  private upsert(chat: ChatRecord, item: TranscriptItem) { const index = chat.items.findIndex((entry) => entry.id === item.id); if (index >= 0) chat.items[index] = item; else chat.items.push(item); }
  private handle(chat: ChatRecord, event: AdapterEvent) {
    if (event.type === "message") { this.upsert(chat, event.item); this.broadcast(chat, { type: "message", item: event.item }); }
    else if (event.type === "delta") { const item = chat.items.find((entry) => entry.type !== "notice" && entry.id === event.itemId); if (item?.type === "assistant") { if (event.channel === "text") item.text += event.delta; else item.thinking = `${item.thinking ?? ""}${event.delta}`; } this.broadcast(chat, { type: "text_delta", itemId: event.itemId, delta: event.delta, channel: event.channel }); }
    else if (event.type === "tool") {
      const previous = chat.items.find((entry): entry is ToolItem => entry.type === "tool" && entry.id === event.item.id);
      const item = event.item.argumentSummary || !previous ? event.item : { ...event.item, argumentSummary: previous.argumentSummary };
      this.upsert(chat, item); this.broadcast(chat, { type: "tool", item });
    }
    else if (event.type === "queue") { chat.steering = event.steering; chat.followUp = event.followUp; this.broadcast(chat, { type: "queue", steering: event.steering, followUp: event.followUp }); }
    else if (event.type === "notice") { const item = { type: "notice" as const, id: randomUUID().replaceAll("-", ""), level: event.level, text: event.text }; chat.items.push(item); this.broadcast(chat, { type: "notice", item }); }
    else if (event.type === "dialog") this.broadcast(chat, { type: "extension_dialog", ...(event.dialog ? { dialog: event.dialog } : {}) });
    else if (event.type === "settled") { chat.runStatus = "idle"; this.broadcast(chat, { type: "run_status", status: "idle" }); this.broadcast(chat, { type: "session", ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}), stats: chat.session.getStats() }); }
  }
  startPrompt(chat: ChatRecord, text: string, delivery: "normal" | "steer" | "follow-up") {
    if (delivery === "normal") { if (!chat.session.isIdle) throw new Error("Use Steer or Follow-up while Pi is active"); chat.runStatus = "running"; this.broadcast(chat, { type: "run_status", status: "running" }); void chat.session.prompt(text).catch((error) => { chat.runStatus = "error"; this.handle(chat, { type: "notice", level: "error", text: error instanceof Error ? error.message : "Prompt failed" }); this.broadcast(chat, { type: "run_status", status: "error" }); }); }
    else if (delivery === "steer") void chat.session.steer(text); else void chat.session.followUp(text);
  }
  async abort(chat: ChatRecord) { chat.runStatus = "stopping"; this.broadcast(chat, { type: "run_status", status: "stopping" }); await chat.session.abort(); }
  clear(chat: ChatRecord) { chat.session.clearQueue(); }
  async configure(chat: ChatRecord, input: Parameters<AdapterSession["configure"]>[0]) { await chat.session.configure(input); if (input.toolMode) chat.toolMode = input.toolMode; this.broadcast(chat, { type: "session", ...(chat.session.sessionName ? { name: chat.session.sessionName } : {}), stats: chat.session.getStats() }); }
  rename(chat: ChatRecord, name: string) { chat.session.rename(name); this.broadcast(chat, { type: "session", name, stats: chat.session.getStats() }); }
  async compact(chat: ChatRecord, instructions?: string) { chat.runStatus = "compacting"; this.broadcast(chat, { type: "run_status", status: "compacting" }); try { await chat.session.compact(instructions); } finally { chat.runStatus = "idle"; this.broadcast(chat, { type: "run_status", status: "idle" }); } }
  dispose(chat: ChatRecord) { chat.generation++; chat.unsubscribe(); chat.session.dispose(); this.owners.delete(chat.session.nativePath ?? chat.session.nativeId); this.chats.delete(chat.id); for (const socket of chat.sockets) socket.close(1001, "Chat disposed"); }
}
