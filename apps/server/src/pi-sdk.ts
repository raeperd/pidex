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
import { Effect, Scope } from "effect";
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

interface PiSdkError {
  readonly _tag: "PiSdkError";
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}

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

export interface PiSdkOptions {
  readonly agentDir?: string;
  readonly sessionDir?: string;
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

function makePiSession(session: AgentSession) {
  const nativeId = session.sessionId;
  const nativePath = session.sessionFile;
  const listeners = new Set<(event: AdapterEvent) => void>();
  const pendingDialogs = new Map<string, (value: string | boolean | null) => void>();
  const unsubscribe = session.subscribe(handle);
  async function bind() {
    await session.bindExtensions({
      uiContext: uiContext(),
      mode: "rpc",
      onError: (error) =>
        emit({ type: "notice", level: "error", text: `Extension error: ${error.error}` }),
    });
  }
  function readMessages(): TextItem[] {
    return session.sessionManager.buildContextEntries().flatMap((entry) => {
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
  function readModel() {
    return session.model ? `${session.model.provider}/${session.model.id}` : undefined;
  }
  function readThinkingLevel() {
    return session.thinkingLevel;
  }
  function readSessionName() {
    return session.sessionName;
  }
  function readContextUsage(): ContextUsage | undefined {
    const usage = session.getContextUsage();
    if (!usage) return undefined;
    return {
      ...usage,
      totalProcessedTokens: session.getSessionStats().tokens.total,
      compactsAutomatically: session.settingsManager.getCompactionSettings().enabled,
    };
  }
  function readIsIdle() {
    return session.isIdle;
  }
  function subscribe(listener: (event: AdapterEvent) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function emit(event: AdapterEvent) {
    for (const listener of listeners) listener(event);
  }
  function handle(event: AgentSessionEvent) {
    if (
      event.type === "message_start" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      emit({
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
        emit({
          type: "delta",
          itemId: messageId(event.message),
          delta: update.delta,
          channel: "text",
        });
      if (update.type === "thinking_delta")
        emit({
          type: "delta",
          itemId: messageId(event.message),
          delta: update.delta,
          channel: "thinking",
        });
    } else if (
      event.type === "message_end" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      emit({
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
      if (event.message.role === "assistant") scheduleContextUsage();
    } else if (event.type === "tool_execution_start") {
      const args = bounded(event.args, 800);
      emit({
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
      emit({ type: "tool", item, output });
    } else if (event.type === "queue_update")
      emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
    else if (event.type === "agent_settled") emit({ type: "settled" });
    else if (event.type === "compaction_start")
      emit({ type: "notice", level: "info", text: `Compaction started (${event.reason}).` });
    else if (event.type === "compaction_end") {
      emit({
        type: "notice",
        level: event.errorMessage ? "error" : "info",
        text: event.errorMessage ?? "Compaction complete.",
      });
      scheduleContextUsage();
    } else if (event.type === "auto_retry_start")
      emit({
        type: "notice",
        level: "warning",
        text: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
      });
    else if (event.type === "auto_retry_end" && !event.success)
      emit({ type: "notice", level: "error", text: event.finalError ?? "Retry failed." });
  }
  function scheduleContextUsage() {
    queueMicrotask(() => {
      const usage = readContextUsage();
      if (usage) emit({ type: "context_usage", usage });
    });
  }
  function uiContext(): ExtensionUIContext {
    const ask = (dialog: Omit<ExtensionDialog, "id">) =>
      new Promise<string | boolean | undefined>((resolve) => {
        const id = randomUUID().replaceAll("-", "");
        pendingDialogs.set(id, (value) => resolve(value === null ? undefined : value));
        emit({ type: "dialog", dialog: { ...dialog, id } });
      });
    const unsupported = async () => {
      emit({
        type: "notice",
        level: "warning",
        text: "An extension requested a TUI-only interaction that Pidex cannot safely display.",
      });
      throw new Error("TUI-only extension interaction unsupported");
    };
    return {
      select: async (title: string, options: string[]) =>
        (await ask({ kind: "select", title, options })) as string | undefined,
      confirm: async (title: string, message: string) =>
        Boolean(await ask({ kind: "confirm", title, message })),
      input: async (title: string, placeholder?: string) =>
        (await ask({ kind: "input", title, ...(placeholder ? { placeholder } : {}) })) as
          | string
          | undefined,
      editor: async (title: string, prefill?: string) =>
        (await ask({ kind: "editor", title, ...(prefill ? { prefill } : {}) })) as
          | string
          | undefined,
      notify: (message: string, type: "info" | "warning" | "error" = "info") =>
        emit({ type: "notice", level: type, text: message }),
      setStatus: (_key: string, text: string | undefined) => {
        if (text) emit({ type: "notice", level: "info", text });
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
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme UI unavailable" }),
      theme: undefined as never,
    } as unknown as ExtensionUIContext;
  }
  async function prompt(text: string) {
    await session.prompt(text);
  }
  async function steer(text: string) {
    await session.steer(text);
  }
  async function followUp(text: string) {
    await session.followUp(text);
  }
  async function abort() {
    session.clearQueue();
    await session.abort();
  }
  function clearQueue() {
    session.clearQueue();
  }
  async function configure(input: {
    model?: string;
    thinkingLevel?: AdapterSession["thinkingLevel"];
  }) {
    if (!session.isIdle) throw new Error("Configuration can only change while idle");
    if (input.model) {
      const slash = input.model.indexOf("/");
      const model = session.modelRuntime.getModel(
        input.model.slice(0, slash),
        input.model.slice(slash + 1),
      );
      if (!model) throw new Error("Model is no longer available");
      await session.setModel(model);
    }
    if (input.thinkingLevel) session.setThinkingLevel(input.thinkingLevel);
  }
  function rename(name: string) {
    session.setSessionName(name);
  }
  async function compact(instructions?: string) {
    await session.compact(instructions);
  }
  function getStats() {
    const stats = session.getSessionStats();
    return {
      messages: stats.totalMessages,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens.total,
      cost: stats.cost,
      subscription: session.model
        ? session.modelRuntime.isUsingOAuth(session.model.provider)
        : false,
    };
  }
  function respondToDialog(requestId: string, value: string | boolean | null) {
    const resolve = pendingDialogs.get(requestId);
    if (!resolve) throw new Error("Dialog is no longer pending");
    pendingDialogs.delete(requestId);
    resolve(value);
    emit({ type: "dialog" });
  }
  function dispose() {
    unsubscribe?.();
    for (const resolve of pendingDialogs.values()) resolve(null);
    pendingDialogs.clear();
    session.dispose();
    listeners.clear();
  }
  return {
    nativeId,
    nativePath,
    get messages() {
      return readMessages();
    },
    get model() {
      return readModel();
    },
    get thinkingLevel() {
      return readThinkingLevel();
    },
    get sessionName() {
      return readSessionName();
    },
    get contextUsage() {
      return readContextUsage();
    },
    get isIdle() {
      return readIsIdle();
    },
    bind,
    subscribe,
    prompt,
    steer,
    followUp,
    abort,
    clearQueue,
    configure,
    rename,
    compact,
    getStats,
    respondToDialog,
    dispose,
  };
}

export function makePiSdk(options: PiSdkOptions = {}) {
  async function services(cwd: string) {
    const agentDir = options.agentDir ?? getAgentDir();
    const settings = SettingsManager.create(cwd, agentDir);
    const trust = trustState(cwd, agentDir, settings);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
    await loader.reload({ resolveProjectTrust: async () => trust.trusted === true });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    await modelRuntime.refresh({ allowNetwork: false });
    return {
      agentDir,
      settings,
      trust,
      loader,
      modelRuntime,
      sessionDir: resolvedSessionDir(
        cwd,
        agentDir,
        settings,
        options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR,
      ),
    };
  }

  async function inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo> {
    const { trust, loader, modelRuntime, sessionDir } = await services(cwd);
    const sessions = await SessionManager.list(cwd, sessionDir);
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
      models: (await modelRuntime.getAvailable()).map((model) => ({
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
  }

  async function open(cwd: string, manager: SessionManager) {
    const { agentDir, settings, loader, modelRuntime } = await services(cwd);
    const result = await createAgentSession({
      cwd,
      agentDir,
      settingsManager: settings,
      resourceLoader: loader,
      modelRuntime,
      sessionManager: manager,
    });
    const wrapped = makePiSession(result.session);
    try {
      await wrapped.bind();
    } catch (error) {
      wrapped.dispose();
      throw error;
    }
    return wrapped;
  }

  async function createSession(cwd: string) {
    const { sessionDir } = await services(cwd);
    return open(cwd, SessionManager.create(cwd, sessionDir));
  }

  async function resumeSession(cwd: string, nativePath: string) {
    const { sessionDir } = await services(cwd);
    return open(cwd, SessionManager.open(nativePath, sessionDir, cwd));
  }

  async function setWorkspaceTrust(cwd: string, trusted: boolean) {
    new ProjectTrustStore(options.agentDir ?? getAgentDir()).set(cwd, trusted);
  }

  async function inheritWorkspaceTrust(sourceCwd: string, cwd: string) {
    const trust = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    const decision = trust.get(sourceCwd);
    if (decision !== null) trust.set(cwd, decision);
  }

  async function clearWorkspaceTrust(cwd: string) {
    new ProjectTrustStore(options.agentDir ?? getAgentDir()).set(cwd, null);
  }
  return {
    inspectWorkspace,
    createSession,
    resumeSession,
    setWorkspaceTrust,
    inheritWorkspaceTrust,
    clearWorkspaceTrust,
  };
}

export type PiSdk = ReturnType<typeof makePiSdk>;

export function makePiSdkService(sdk: Pick<PiSdk, keyof PiSdk>): PiSdkServiceApi {
  return {
    inspectWorkspace: (cwd) => fromPiPromise("workspace.inspect", () => sdk.inspectWorkspace(cwd)),
    createSession: (cwd) =>
      acquireAdapterSession(fromPiPromise("session.create", () => sdk.createSession(cwd))),
    resumeSession: (cwd, nativePath) =>
      acquireAdapterSession(
        fromPiPromise("session.resume", () => sdk.resumeSession(cwd, nativePath)),
      ),
    setWorkspaceTrust: (cwd, trusted) =>
      fromPiPromise("workspace.trust.set", () => sdk.setWorkspaceTrust(cwd, trusted)),
    inheritWorkspaceTrust: (sourceCwd, cwd) =>
      fromPiPromise("workspace.trust.inherit", () => sdk.inheritWorkspaceTrust(sourceCwd, cwd)),
    clearWorkspaceTrust: (cwd) =>
      fromPiPromise("workspace.trust.clear", () => sdk.clearWorkspaceTrust(cwd)),
  };
}

function fromPiPromise<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, PiSdkError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => piSdkError(operation, cause),
  });
}

function piSdkError(operation: string, cause: unknown): PiSdkError {
  return {
    _tag: "PiSdkError",
    operation,
    message: cause instanceof Error ? cause.message : `Unexpected failure during ${operation}`,
    cause,
  };
}
