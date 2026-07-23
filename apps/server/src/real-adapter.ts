import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionDialog, TextItem, ToolItem } from "@pidex/api";
import { bounded, boundedResource, type AdapterEvent, type AdapterSession, type AdapterSessionInfo, type AdapterWorkspaceInfo, type PiAdapter } from "./adapter.js";

const readOnly = ["read", "grep", "find", "ls"];
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: string; text?: string; thinking?: string } => typeof part === "object" && part !== null && "type" in part)
    .map((part) => part.type === "text" ? (part.text ?? "") : "").join("");
};
const thinkingOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((part): part is { type: string; thinking?: string } => typeof part === "object" && part !== null && "type" in part).map((part) => part.type === "thinking" ? (part.thinking ?? "") : "").join("")
  : "";
const messageId = (message: { role: string; timestamp?: number }) => `${message.role}-${message.timestamp ?? Date.now()}`;

function resolvedSessionDir(cwd: string, settings: SettingsManager): string | undefined {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (override) return path.resolve(cwd, override.replace(/^~(?=$|\/)/, getAgentDir().replace(/\/\.pi\/agent$/, "")));
  return settings.getSessionDir();
}

function trustState(cwd: string, settings: SettingsManager): { trusted: boolean | null; skipped: boolean } {
  if (!hasTrustRequiringProjectResources(cwd)) return { trusted: true, skipped: false };
  const saved = new ProjectTrustStore(getAgentDir()).get(cwd);
  const trusted = saved ?? (settings.getDefaultProjectTrust() === "always" ? true : null);
  return { trusted, skipped: trusted !== true };
}

class RealSession implements AdapterSession {
  readonly nativeId: string;
  readonly nativePath: string | undefined;
  private listeners = new Set<(event: AdapterEvent) => void>();
  private unsubscribe?: () => void;
  private pendingDialogs = new Map<string, (value: string | boolean | null) => void>();
  constructor(private readonly session: AgentSession) {
    this.nativeId = session.sessionId;
    this.nativePath = session.sessionFile;
    this.unsubscribe = session.subscribe((event) => this.handle(event));
  }
  async bind() { await this.session.bindExtensions({ uiContext: this.uiContext(), mode: "rpc", onError: (error) => this.emit({ type: "notice", level: "error", text: `Extension error: ${error.error}` }) }); }
  get messages(): TextItem[] {
    return this.session.sessionManager.buildContextEntries().flatMap((entry) => {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
      const item: TextItem = { type: entry.message.role, id: entry.id, text: textOf(entry.message.content), complete: true, timestamp: entry.timestamp };
      const thinking = thinkingOf(entry.message.content); if (thinking) item.thinking = thinking;
      return [item];
    });
  }
  get model() { return this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined; }
  get thinkingLevel() { return this.session.thinkingLevel; }
  get activeTools() { return this.session.getActiveToolNames(); }
  get sessionName() { return this.session.sessionName; }
  get isIdle() { return this.session.isIdle; }
  subscribe(listener: (event: AdapterEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: AdapterEvent) { for (const listener of this.listeners) listener(event); }
  private handle(event: AgentSessionEvent) {
    if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "assistant")) {
      this.emit({ type: "message", item: { type: event.message.role, id: messageId(event.message), text: textOf(event.message.content), ...(thinkingOf(event.message.content) ? { thinking: thinkingOf(event.message.content) } : {}), complete: false, timestamp: new Date(event.message.timestamp ?? Date.now()).toISOString() } });
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") this.emit({ type: "delta", itemId: messageId(event.message), delta: update.delta, channel: "text" });
      if (update.type === "thinking_delta") this.emit({ type: "delta", itemId: messageId(event.message), delta: update.delta, channel: "thinking" });
    } else if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant")) {
      this.emit({ type: "message", item: { type: event.message.role, id: messageId(event.message), text: textOf(event.message.content), ...(thinkingOf(event.message.content) ? { thinking: thinkingOf(event.message.content) } : {}), complete: true, timestamp: new Date(event.message.timestamp ?? Date.now()).toISOString() } });
    } else if (event.type === "tool_execution_start") {
      const args = bounded(event.args, 800); this.emit({ type: "tool", item: { type: "tool", id: event.toolCallId, name: event.toolName, argumentSummary: args.text, state: "running", preview: "", truncated: args.truncated } });
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const value = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const output = boundedResource(value);
      const preview = bounded(output.text);
      const item: ToolItem = { type: "tool", id: event.toolCallId, name: event.toolName, argumentSummary: event.type === "tool_execution_update" ? bounded(event.args, 800).text : "", state: event.type === "tool_execution_update" ? "running" : event.isError ? "error" : "success", preview: preview.text, truncated: preview.truncated || output.sourceTruncated };
      this.emit({ type: "tool", item, output });
    } else if (event.type === "queue_update") this.emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
    else if (event.type === "agent_settled") this.emit({ type: "settled" });
    else if (event.type === "compaction_start") this.emit({ type: "notice", level: "info", text: `Compaction started (${event.reason}).` });
    else if (event.type === "compaction_end") this.emit({ type: "notice", level: event.errorMessage ? "error" : "info", text: event.errorMessage ?? "Compaction complete." });
    else if (event.type === "auto_retry_start") this.emit({ type: "notice", level: "warning", text: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
    else if (event.type === "auto_retry_end" && !event.success) this.emit({ type: "notice", level: "error", text: event.finalError ?? "Retry failed." });
  }
  private uiContext(): ExtensionUIContext {
    const ask = (dialog: Omit<ExtensionDialog, "id">) => new Promise<string | boolean | undefined>((resolve) => {
      const id = randomUUID().replaceAll("-", "");
      this.pendingDialogs.set(id, (value) => resolve(value === null ? undefined : value));
      this.emit({ type: "dialog", dialog: { ...dialog, id } });
    });
    const unsupported = async () => { this.emit({ type: "notice", level: "warning", text: "An extension requested a TUI-only interaction that Pidex cannot safely display." }); throw new Error("TUI-only extension interaction unsupported"); };
    return {
      select: async (title: string, options: string[]) => (await ask({ kind: "select", title, options })) as string | undefined,
      confirm: async (title: string, message: string) => Boolean(await ask({ kind: "confirm", title, message })),
      input: async (title: string, placeholder?: string) => (await ask({ kind: "input", title, ...(placeholder ? { placeholder } : {}) })) as string | undefined,
      editor: async (title: string, prefill?: string) => (await ask({ kind: "editor", title, ...(prefill ? { prefill } : {}) })) as string | undefined,
      notify: (message: string, type: "info" | "warning" | "error" = "info") => this.emit({ type: "notice", level: type, text: message }),
      setStatus: (_key: string, text: string | undefined) => { if (text) this.emit({ type: "notice", level: "info", text }); },
      setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
      onTerminalInput: () => () => {}, setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
      custom: unsupported, pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", addAutocompleteProvider: () => {},
      setEditorComponent: () => {}, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: "Theme UI unavailable" }),
      theme: undefined as never,
    } as unknown as ExtensionUIContext;
  }
  async prompt(text: string) { await this.session.prompt(text); }
  async steer(text: string) { await this.session.steer(text); }
  async followUp(text: string) { await this.session.followUp(text); }
  async abort() { this.session.clearQueue(); await this.session.abort(); }
  clearQueue() { this.session.clearQueue(); }
  async configure(input: { model?: string; thinkingLevel?: AdapterSession["thinkingLevel"]; toolMode?: "read-only" | "full" }) {
    if (!this.session.isIdle) throw new Error("Configuration can only change while idle");
    if (input.model) { const slash = input.model.indexOf("/"); const model = this.session.modelRuntime.getModel(input.model.slice(0, slash), input.model.slice(slash + 1)); if (!model) throw new Error("Model is no longer available"); await this.session.setModel(model); }
    if (input.thinkingLevel) this.session.setThinkingLevel(input.thinkingLevel);
    if (input.toolMode) this.session.setActiveToolsByName(input.toolMode === "read-only" ? readOnly : this.session.getAllTools().map((tool) => tool.name));
  }
  rename(name: string) { this.session.setSessionName(name); }
  async compact(instructions?: string) { await this.session.compact(instructions); }
  getStats() { const stats = this.session.getSessionStats(); return { messages: stats.totalMessages, toolCalls: stats.toolCalls, tokens: stats.tokens.total, cost: stats.cost }; }
  respondToDialog(requestId: string, value: string | boolean | null) { const resolve = this.pendingDialogs.get(requestId); if (!resolve) throw new Error("Dialog is no longer pending"); this.pendingDialogs.delete(requestId); resolve(value); this.emit({ type: "dialog" }); }
  dispose() { this.unsubscribe?.(); for (const resolve of this.pendingDialogs.values()) resolve(null); this.pendingDialogs.clear(); this.session.dispose(); this.listeners.clear(); }
}

export class RealPiAdapter implements PiAdapter {
  readonly name = "real" as const;
  private async services(cwd: string) {
    const agentDir = getAgentDir(); const settings = SettingsManager.create(cwd, agentDir); const trust = trustState(cwd, settings);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
    await loader.reload({ resolveProjectTrust: async () => trust.trusted === true });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
    await modelRuntime.refresh({ allowNetwork: false });
    return { agentDir, settings, trust, loader, modelRuntime, sessionDir: resolvedSessionDir(cwd, settings) };
  }
  async inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo> {
    const { trust, loader, modelRuntime, sessionDir } = await this.services(cwd);
    const sessions = await SessionManager.list(cwd, sessionDir);
    const diagnostics = [
      ...loader.getSkills().diagnostics.map((entry) => ({ level: entry.type === "error" ? "error" as const : "warning" as const, message: entry.message.slice(0, 1000) })),
      ...loader.getPrompts().diagnostics.map((entry) => ({ level: entry.type === "error" ? "error" as const : "warning" as const, message: entry.message.slice(0, 1000) })),
      ...loader.getThemes().diagnostics.map((entry) => ({ level: entry.type === "error" ? "error" as const : "warning" as const, message: entry.message.slice(0, 1000) })),
      ...loader.getExtensions().errors.map((entry) => ({ level: "error" as const, message: `Extension ${path.basename(entry.path)}: ${entry.error}`.slice(0, 1000) })),
    ].slice(0, 50);
    return { models: (await modelRuntime.getAvailable()).map((model) => ({ id: `${model.provider}/${model.id}`, provider: model.provider, name: model.name, reasoning: model.reasoning })), sessions: sessions.map((entry): AdapterSessionInfo => ({ id: entry.id, nativeId: entry.id, nativePath: entry.path, ...(entry.name ? { name: entry.name } : {}), firstMessage: entry.firstMessage.slice(0, 500), createdAt: entry.created.toISOString(), modifiedAt: entry.modified.toISOString(), messageCount: entry.messageCount })), trusted: trust.trusted, protectedResourcesSkipped: trust.skipped, resourceDiagnostics: diagnostics, commands: loader.getPrompts().prompts.map((prompt) => ({ name: prompt.name, ...(prompt.description ? { description: prompt.description } : {}) })) };
  }
  private async open(cwd: string, manager: SessionManager, toolMode: "read-only" | "full") {
    const { agentDir, settings, loader, modelRuntime } = await this.services(cwd);
    const result = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime, sessionManager: manager, ...(toolMode === "read-only" ? { tools: readOnly } : {}) });
    const wrapped = new RealSession(result.session); await wrapped.bind(); return wrapped;
  }
  async createSession(cwd: string, toolMode: "read-only" | "full") { const { sessionDir } = await this.services(cwd); return this.open(cwd, SessionManager.create(cwd, sessionDir), toolMode); }
  async resumeSession(cwd: string, nativePath: string) { const { sessionDir } = await this.services(cwd); return this.open(cwd, SessionManager.open(nativePath, sessionDir, cwd), "read-only"); }
  async setWorkspaceTrust(cwd: string, trusted: boolean) { new ProjectTrustStore(getAgentDir()).set(cwd, trusted); }
}
