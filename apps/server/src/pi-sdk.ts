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
import type { ContextUsage, ExtensionDialog, TextItem, ToolItem } from "@pidex/api";
import { Context, Effect, Layer, Schema, Scope } from "effect";
import {
  acquireAdapterSession,
  bounded,
  boundedResource,
  type AdapterEvent,
  type AdapterSession,
  type AdapterSessionInfo,
  type AdapterWorkspaceInfo,
  type EffectAdapterSession,
} from "./adapter.js";

export class PiSdkError extends Schema.TaggedErrorClass<PiSdkError>()("PiSdkError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface PiSdkServiceApi {
  inspectWorkspace(cwd: string): Effect.Effect<AdapterWorkspaceInfo, PiSdkError>;
  createSession(cwd: string): Effect.Effect<EffectAdapterSession, PiSdkError, Scope.Scope>;
  resumeSession(
    cwd: string,
    nativePath: string,
  ): Effect.Effect<EffectAdapterSession, PiSdkError, Scope.Scope>;
  setWorkspaceTrust(cwd: string, trusted: boolean): Effect.Effect<void, PiSdkError>;
  inheritWorkspaceTrust(sourceCwd: string, cwd: string): Effect.Effect<void, PiSdkError>;
  clearWorkspaceTrust(cwd: string): Effect.Effect<void, PiSdkError>;
}

export class PiSdkService extends Context.Service<PiSdkService, PiSdkServiceApi>()(
  "@pidex/server/PiSdkService",
) {
  static readonly layer = Layer.succeed(
    PiSdkService,
    makePiSdkService(getAgentDir, sessionDirOverride),
  );

  static make(agentDir: string): PiSdkServiceApi {
    return makePiSdkService(
      () => agentDir,
      () => path.join(agentDir, "sessions"),
    );
  }
}

export class PiSdk {
  inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo> {
    return Effect.runPromise(inspectWorkspace(cwd, getAgentDir, sessionDirOverride));
  }

  createSession(cwd: string): Promise<AdapterSession> {
    return Effect.runPromise(
      openSession(cwd, "session.create", SessionManager.create, getAgentDir, sessionDirOverride),
    );
  }

  resumeSession(cwd: string, nativePath: string): Promise<AdapterSession> {
    return Effect.runPromise(
      openSession(
        cwd,
        "session.resume",
        (_cwd, sessionDir) => SessionManager.open(nativePath, sessionDir, cwd),
        getAgentDir,
        sessionDirOverride,
      ),
    );
  }

  setWorkspaceTrust(cwd: string, trusted: boolean): Promise<void> {
    return Effect.runPromise(setWorkspaceTrust(cwd, trusted, getAgentDir));
  }

  inheritWorkspaceTrust(sourceCwd: string, cwd: string): Promise<void> {
    return Effect.runPromise(inheritWorkspaceTrust(sourceCwd, cwd, getAgentDir));
  }

  clearWorkspaceTrust(cwd: string): Promise<void> {
    return Effect.runPromise(clearWorkspaceTrust(cwd, getAgentDir));
  }
}

function makePiSdkService(
  resolveAgentDir: () => string,
  resolveSessionDirOverride: () => string | undefined,
): PiSdkServiceApi {
  return {
    inspectWorkspace: (cwd) => inspectWorkspace(cwd, resolveAgentDir, resolveSessionDirOverride),
    createSession: (cwd) =>
      acquireAdapterSession(
        openSession(
          cwd,
          "session.create",
          SessionManager.create,
          resolveAgentDir,
          resolveSessionDirOverride,
        ),
      ),
    resumeSession: (cwd, nativePath) =>
      acquireAdapterSession(
        openSession(
          cwd,
          "session.resume",
          (_cwd, sessionDir) => SessionManager.open(nativePath, sessionDir, cwd),
          resolveAgentDir,
          resolveSessionDirOverride,
        ),
      ),
    setWorkspaceTrust: (cwd, trusted) => setWorkspaceTrust(cwd, trusted, resolveAgentDir),
    inheritWorkspaceTrust: (sourceCwd, cwd) =>
      inheritWorkspaceTrust(sourceCwd, cwd, resolveAgentDir),
    clearWorkspaceTrust: (cwd) => clearWorkspaceTrust(cwd, resolveAgentDir),
  };
}

function sessionDirOverride(): string | undefined {
  return process.env.PI_CODING_AGENT_SESSION_DIR;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text?: string; thinking?: string } =>
        typeof part === "object" && part !== null && "type" in part,
    )
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
};
const thinkingOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(
          (part): part is { type: string; thinking?: string } =>
            typeof part === "object" && part !== null && "type" in part,
        )
        .map((part) => (part.type === "thinking" ? (part.thinking ?? "") : ""))
        .join("")
    : "";
const messageId = (message: { role: string; timestamp?: number }) =>
  `${message.role}-${message.timestamp ?? Date.now()}`;

function resolvedSessionDir(
  cwd: string,
  agentDir: string,
  settings: SettingsManager,
  override: string | undefined,
): string | undefined {
  if (override)
    return path.resolve(
      cwd,
      override.replace(/^~(?=$|\/)/, agentDir.replace(/\/\.pi\/agent$/, "")),
    );
  return settings.getSessionDir();
}

function trustState(
  cwd: string,
  agentDir: string,
  settings: SettingsManager,
): { trusted: boolean | null; skipped: boolean } {
  if (!hasTrustRequiringProjectResources(cwd)) return { trusted: true, skipped: false };
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  const trusted = saved ?? (settings.getDefaultProjectTrust() === "always" ? true : null);
  return { trusted, skipped: trusted !== true };
}

type ResourceDiagnostic = AdapterWorkspaceInfo["resourceDiagnostics"][number];
const resourceDiagnostic = (type: string, message: string): ResourceDiagnostic => ({
  level: type === "error" ? "error" : "warning",
  message: message.slice(0, 1000),
});

class PiSession implements AdapterSession {
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
  async bind() {
    await this.session.bindExtensions({
      uiContext: this.uiContext(),
      mode: "rpc",
      onError: (error) =>
        this.emit({ type: "notice", level: "error", text: `Extension error: ${error.error}` }),
    });
  }
  get messages(): TextItem[] {
    return this.session.sessionManager.buildContextEntries().flatMap((entry) => {
      if (
        entry.type !== "message" ||
        (entry.message.role !== "user" && entry.message.role !== "assistant")
      )
        return [];
      const item: TextItem = {
        type: entry.message.role,
        id: entry.id,
        text: textOf(entry.message.content),
        complete: true,
        timestamp: entry.timestamp,
      };
      const thinking = thinkingOf(entry.message.content);
      if (thinking) item.thinking = thinking;
      return [item];
    });
  }
  get model() {
    return this.session.model
      ? `${this.session.model.provider}/${this.session.model.id}`
      : undefined;
  }
  get thinkingLevel() {
    return this.session.thinkingLevel;
  }
  get sessionName() {
    return this.session.sessionName;
  }
  get contextUsage(): ContextUsage | undefined {
    const usage = this.session.getContextUsage();
    if (!usage) return undefined;
    return {
      ...usage,
      totalProcessedTokens: this.session.getSessionStats().tokens.total,
      compactsAutomatically: this.session.settingsManager.getCompactionSettings().enabled,
    };
  }
  get isIdle() {
    return this.session.isIdle;
  }
  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: AdapterEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private handle(event: AgentSessionEvent) {
    if (
      event.type === "message_start" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      this.emit({
        type: "message",
        item: {
          type: event.message.role,
          id: messageId(event.message),
          text: textOf(event.message.content),
          ...(thinkingOf(event.message.content)
            ? { thinking: thinkingOf(event.message.content) }
            : {}),
          complete: false,
          timestamp: new Date(event.message.timestamp ?? Date.now()).toISOString(),
        },
      });
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta")
        this.emit({
          type: "delta",
          itemId: messageId(event.message),
          delta: update.delta,
          channel: "text",
        });
      if (update.type === "thinking_delta")
        this.emit({
          type: "delta",
          itemId: messageId(event.message),
          delta: update.delta,
          channel: "thinking",
        });
    } else if (
      event.type === "message_end" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      this.emit({
        type: "message",
        item: {
          type: event.message.role,
          id: messageId(event.message),
          text: textOf(event.message.content),
          ...(thinkingOf(event.message.content)
            ? { thinking: thinkingOf(event.message.content) }
            : {}),
          complete: true,
          timestamp: new Date(event.message.timestamp ?? Date.now()).toISOString(),
        },
      });
      if (event.message.role === "assistant") this.scheduleContextUsage();
    } else if (event.type === "tool_execution_start") {
      const args = bounded(event.args, 800);
      this.emit({
        type: "tool",
        item: {
          type: "tool",
          id: event.toolCallId,
          name: event.toolName,
          argumentSummary: args.text,
          state: "running",
          preview: "",
          truncated: args.truncated,
        },
      });
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const value = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const output = boundedResource(value);
      const preview = bounded(output.text);
      const item: ToolItem = {
        type: "tool",
        id: event.toolCallId,
        name: event.toolName,
        argumentSummary:
          event.type === "tool_execution_update" ? bounded(event.args, 800).text : "",
        state:
          event.type === "tool_execution_update" ? "running" : event.isError ? "error" : "success",
        preview: preview.text,
        truncated: preview.truncated || output.sourceTruncated,
      };
      this.emit({ type: "tool", item, output });
    } else if (event.type === "queue_update")
      this.emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
    else if (event.type === "agent_settled") this.emit({ type: "settled" });
    else if (event.type === "compaction_start")
      this.emit({ type: "notice", level: "info", text: `Compaction started (${event.reason}).` });
    else if (event.type === "compaction_end") {
      this.emit({
        type: "notice",
        level: event.errorMessage ? "error" : "info",
        text: event.errorMessage ?? "Compaction complete.",
      });
      this.scheduleContextUsage();
    } else if (event.type === "auto_retry_start")
      this.emit({
        type: "notice",
        level: "warning",
        text: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
      });
    else if (event.type === "auto_retry_end" && !event.success)
      this.emit({ type: "notice", level: "error", text: event.finalError ?? "Retry failed." });
  }
  private scheduleContextUsage() {
    queueMicrotask(() => {
      const usage = this.contextUsage;
      if (usage) this.emit({ type: "context_usage", usage });
    });
  }
  private uiContext(): ExtensionUIContext {
    const session = this.session;
    const ask = (dialog: Omit<ExtensionDialog, "id">) =>
      new Promise<string | boolean | undefined>((resolve) => {
        const id = randomUUID().replaceAll("-", "");
        this.pendingDialogs.set(id, (value) => resolve(value === null ? undefined : value));
        this.emit({ type: "dialog", dialog: { ...dialog, id } });
      });
    const askForText = async (dialog: Omit<ExtensionDialog, "id">) => {
      const value = await ask(dialog);
      return typeof value === "string" ? value : undefined;
    };
    const unsupported = async <A>(): Promise<A> => {
      this.emit({
        type: "notice",
        level: "warning",
        text: "An extension requested a TUI-only interaction that Pidex cannot safely display.",
      });
      throw new Error("TUI-only extension interaction unsupported");
    };
    return {
      select: (title: string, options: string[]) => askForText({ kind: "select", title, options }),
      confirm: async (title: string, message: string) =>
        Boolean(await ask({ kind: "confirm", title, message })),
      input: (title: string, placeholder?: string) =>
        askForText({ kind: "input", title, ...(placeholder ? { placeholder } : {}) }),
      editor: (title: string, prefill?: string) =>
        askForText({ kind: "editor", title, ...(prefill ? { prefill } : {}) }),
      notify: (message: string, type: "info" | "warning" | "error" = "info") =>
        this.emit({ type: "notice", level: type, text: message }),
      setStatus: (_key: string, text: string | undefined) => {
        if (text) this.emit({ type: "notice", level: "info", text });
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: unsupported,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        const value = session.resourceLoader.getThemes().themes[0];
        if (!value) throw new Error("Theme UI unavailable");
        return value;
      },
      getAllThemes: () =>
        session.resourceLoader.getThemes().themes.map((theme) => ({
          name: theme.name ?? "unnamed",
          path: theme.sourcePath,
        })),
      getTheme: (name) =>
        session.resourceLoader.getThemes().themes.find((theme) => theme.name === name),
      setTheme: () => ({ success: false, error: "Theme UI unavailable" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
  async prompt(text: string) {
    await this.session.prompt(text);
  }
  async steer(text: string) {
    await this.session.steer(text);
  }
  async followUp(text: string) {
    await this.session.followUp(text);
  }
  async abort() {
    this.session.clearQueue();
    await this.session.abort();
  }
  clearQueue() {
    this.session.clearQueue();
  }
  async configure(input: { model?: string; thinkingLevel?: AdapterSession["thinkingLevel"] }) {
    if (!this.session.isIdle) throw new Error("Configuration can only change while idle");
    if (input.model) {
      const slash = input.model.indexOf("/");
      const model = this.session.modelRuntime.getModel(
        input.model.slice(0, slash),
        input.model.slice(slash + 1),
      );
      if (!model) throw new Error("Model is no longer available");
      await this.session.setModel(model);
    }
    if (input.thinkingLevel) this.session.setThinkingLevel(input.thinkingLevel);
  }
  rename(name: string) {
    this.session.setSessionName(name);
  }
  async compact(instructions?: string) {
    await this.session.compact(instructions);
  }
  getStats() {
    const stats = this.session.getSessionStats();
    return {
      messages: stats.totalMessages,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens.total,
      cost: stats.cost,
    };
  }
  respondToDialog(requestId: string, value: string | boolean | null) {
    const resolve = this.pendingDialogs.get(requestId);
    if (!resolve) throw new Error("Dialog is no longer pending");
    this.pendingDialogs.delete(requestId);
    resolve(value);
    this.emit({ type: "dialog" });
  }
  dispose() {
    this.unsubscribe?.();
    for (const resolve of this.pendingDialogs.values()) resolve(null);
    this.pendingDialogs.clear();
    this.session.dispose();
    this.listeners.clear();
  }
}

interface PiServices {
  readonly agentDir: string;
  readonly settings: SettingsManager;
  readonly trust: { trusted: boolean | null; skipped: boolean };
  readonly loader: DefaultResourceLoader;
  readonly modelRuntime: ModelRuntime;
  readonly sessionDir: string | undefined;
}

type SessionManagerFactory = (cwd: string, sessionDir: string | undefined) => SessionManager;

function inspectWorkspace(
  cwd: string,
  resolveAgentDir: () => string,
  resolveSessionDirOverride: () => string | undefined,
): Effect.Effect<AdapterWorkspaceInfo, PiSdkError> {
  return Effect.gen(function* () {
    const { trust, loader, modelRuntime, sessionDir } = yield* loadServices(
      cwd,
      "workspace.inspect",
      resolveAgentDir,
      resolveSessionDirOverride,
    );
    const sessions = yield* attemptPiPromise("workspace.inspect", () =>
      SessionManager.list(cwd, sessionDir),
    );
    const models = yield* attemptPiPromise("workspace.inspect", () => modelRuntime.getAvailable());
    const diagnostics: AdapterWorkspaceInfo["resourceDiagnostics"] = [
      ...loader
        .getSkills()
        .diagnostics.map((entry) => resourceDiagnostic(entry.type, entry.message)),
      ...loader
        .getPrompts()
        .diagnostics.map((entry) => resourceDiagnostic(entry.type, entry.message)),
      ...loader
        .getThemes()
        .diagnostics.map((entry) => resourceDiagnostic(entry.type, entry.message)),
      ...loader
        .getExtensions()
        .errors.map((entry) =>
          resourceDiagnostic("error", `Extension ${path.basename(entry.path)}: ${entry.error}`),
        ),
    ].slice(0, 50);
    return {
      models: models.map((model) => ({
        id: `${model.provider}/${model.id}`,
        provider: model.provider,
        name: model.name,
        reasoning: model.reasoning,
      })),
      sessions: sessions.map(
        (entry): AdapterSessionInfo => ({
          id: entry.id,
          nativeId: entry.id,
          nativePath: entry.path,
          ...(entry.name ? { name: entry.name } : {}),
          firstMessage: entry.firstMessage.slice(0, 500),
          createdAt: entry.created.toISOString(),
          modifiedAt: entry.modified.toISOString(),
          messageCount: entry.messageCount,
        }),
      ),
      trusted: trust.trusted,
      protectedResourcesSkipped: trust.skipped,
      resourceDiagnostics: diagnostics,
      commands: loader.getPrompts().prompts.map((prompt) => ({
        name: prompt.name,
        ...(prompt.description ? { description: prompt.description } : {}),
      })),
    };
  });
}

function openSession(
  cwd: string,
  operation: "session.create" | "session.resume",
  makeManager: SessionManagerFactory,
  resolveAgentDir: () => string,
  resolveSessionDirOverride: () => string | undefined,
): Effect.Effect<AdapterSession, PiSdkError> {
  return Effect.gen(function* () {
    const { agentDir, settings, loader, modelRuntime, sessionDir } = yield* loadServices(
      cwd,
      operation,
      resolveAgentDir,
      resolveSessionDirOverride,
    );
    const manager = yield* attemptPiSync(operation, () => makeManager(cwd, sessionDir));
    const result = yield* attemptPiPromise(operation, () =>
      createAgentSession({
        cwd,
        agentDir,
        settingsManager: settings,
        resourceLoader: loader,
        modelRuntime,
        sessionManager: manager,
      }),
    );
    const wrapped = new PiSession(result.session);
    yield* attemptPiPromise(operation, () => wrapped.bind()).pipe(
      Effect.onError(() => Effect.sync(() => wrapped.dispose())),
    );
    return wrapped;
  });
}

function loadServices(
  cwd: string,
  operation: string,
  resolveAgentDir: () => string,
  resolveSessionDirOverride: () => string | undefined,
): Effect.Effect<PiServices, PiSdkError> {
  return Effect.gen(function* () {
    const agentDir = yield* attemptPiSync(operation, resolveAgentDir);
    const settings = yield* attemptPiSync(operation, () => SettingsManager.create(cwd, agentDir));
    const trust = yield* attemptPiSync(operation, () => trustState(cwd, agentDir, settings));
    const loader = yield* attemptPiSync(
      operation,
      () => new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings }),
    );
    yield* attemptPiPromise(operation, () =>
      loader.reload({ resolveProjectTrust: async () => trust.trusted === true }),
    );
    const modelRuntime = yield* attemptPiPromise(operation, () =>
      ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      }),
    );
    yield* attemptPiPromise(operation, () => modelRuntime.refresh({ allowNetwork: false }));
    const override = yield* attemptPiSync(operation, resolveSessionDirOverride);
    const sessionDir = yield* attemptPiSync(operation, () =>
      resolvedSessionDir(cwd, agentDir, settings, override),
    );
    return { agentDir, settings, trust, loader, modelRuntime, sessionDir };
  });
}

function setWorkspaceTrust(
  cwd: string,
  trusted: boolean,
  resolveAgentDir: () => string,
): Effect.Effect<void, PiSdkError> {
  return attemptPiSync("workspace.trust.set", () => {
    new ProjectTrustStore(resolveAgentDir()).set(cwd, trusted);
  });
}

function inheritWorkspaceTrust(
  sourceCwd: string,
  cwd: string,
  resolveAgentDir: () => string,
): Effect.Effect<void, PiSdkError> {
  return attemptPiSync("workspace.trust.inherit", () => {
    const trust = new ProjectTrustStore(resolveAgentDir());
    const decision = trust.get(sourceCwd);
    if (decision !== null) trust.set(cwd, decision);
  });
}

function clearWorkspaceTrust(
  cwd: string,
  resolveAgentDir: () => string,
): Effect.Effect<void, PiSdkError> {
  return attemptPiSync("workspace.trust.clear", () => {
    new ProjectTrustStore(resolveAgentDir()).set(cwd, null);
  });
}

function attemptPiPromise<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, PiSdkError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => piSdkError(operation, cause),
  });
}

function attemptPiSync<A>(operation: string, evaluate: () => A): Effect.Effect<A, PiSdkError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => piSdkError(operation, cause),
  });
}

function piSdkError(operation: string, cause: unknown): PiSdkError {
  return PiSdkError.make({
    operation,
    message: cause instanceof Error ? cause.message : `Unexpected failure during ${operation}`,
    cause,
  });
}
