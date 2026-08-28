import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  parseSkillBlock,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatSnapshot,
  ContextUsage,
  ExtensionDialog,
  ModelInfo,
  SessionSummary,
  SkillItem,
  TextItem,
  TranscriptItem,
  ToolItem,
} from "@pidex/api";
import { Effect, Queue, Scope, Stream } from "effect";
import { taggedAttempt, type TaggedOperationError } from "./errors.js";

type AdapterSessionError = TaggedOperationError<"AdapterSessionError">;

export type AdapterEvent =
  | { type: "message"; item: TextItem | SkillItem }
  | { type: "delta"; itemId: string; delta: string; channel: "text" | "thinking" }
  | { type: "tool"; item: ToolItem; output?: { text: string; sourceTruncated: boolean } }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "context_usage"; usage: ContextUsage }
  | { type: "settled" }
  | { type: "dialog"; dialog?: ExtensionDialog };

export interface AdapterToolOutput {
  readonly id: string;
  readonly text: string;
  readonly sourceTruncated: boolean;
}

export interface AdapterSessionInfo extends SessionSummary {
  nativeId: string;
  nativePath?: string;
}

export interface AdapterWorkspaceInfo {
  models: ModelInfo[];
  sessions: AdapterSessionInfo[];
  trusted: boolean | null;
  protectedResourcesSkipped: boolean;
  resourceDiagnostics: Array<{ level: "warning" | "error"; message: string }>;
  commands: Array<{ name: string; description?: string }>;
}

interface SessionLifecycle {
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface EffectAdapterSession {
  readonly state: {
    readonly nativeId: string;
    readonly nativePath: string | undefined;
    readonly messages: TranscriptItem[];
    readonly toolOutputs: ReadonlyMap<string, AdapterToolOutput>;
    readonly model: string | undefined;
    readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    readonly sessionName: string | undefined;
    readonly contextUsage: ContextUsage | undefined;
    readonly isIdle: boolean;
  };
  readonly events: Stream.Stream<AdapterEvent>;
  prompt(text: string): Effect.Effect<void, AdapterSessionError>;
  steer(text: string): Effect.Effect<void, AdapterSessionError>;
  followUp(text: string): Effect.Effect<void, AdapterSessionError>;
  abort(): Effect.Effect<void, AdapterSessionError>;
  clearQueue(): Effect.Effect<void, AdapterSessionError>;
  configure(input: {
    model?: string;
    thinkingLevel?: EffectAdapterSession["state"]["thinkingLevel"];
  }): Effect.Effect<void, AdapterSessionError>;
  rename(name: string): Effect.Effect<void, AdapterSessionError>;
  compact(instructions?: string): Effect.Effect<void, AdapterSessionError>;
  getStats(): Effect.Effect<ChatSnapshot["stats"], AdapterSessionError>;
  respondToDialog(
    requestId: string,
    value: string | boolean | null,
  ): Effect.Effect<void, AdapterSessionError>;
}

type PiSession = EffectAdapterSession & {
  readonly lifecycle: SessionLifecycle;
  readonly bind: () => Promise<void>;
  readonly dispose: () => void;
};
type AcquiredPiSession = EffectAdapterSession & { readonly lifecycle: SessionLifecycle };

type SessionMessageEvent = Extract<
  AgentSessionEvent,
  { type: "message_start" | "message_end" | "message_update" }
>;

type ToolExecutionEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

export interface PiSdkOptions {
  readonly agentDir?: string;
  readonly sessionDir?: string;
}

const isContentPart = (part: unknown): part is { type: string; text?: string; thinking?: string } =>
  typeof part === "object" && part !== null && "type" in part;
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isContentPart)
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
};
const thinkingOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(isContentPart)
        .map((part) => (part.type === "thinking" ? part.thinking?.trim() : undefined))
        .filter((thinking): thinking is string => Boolean(thinking))
        .join("\n\n")
    : "";
const messageId = (message: { role: string; timestamp?: number }) =>
  `${message.role}-${message.timestamp ?? Date.now()}`;

function transcriptItems(entries: SessionEntry[]) {
  const items: TranscriptItem[] = [];
  const toolOutputs = new Map<string, AdapterToolOutput>();
  const toolIndexes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user" || message.role === "assistant") {
      const thinking = thinkingOf(message.content);
      items.push(
        ...messageItems({
          type: message.role,
          id: entry.id,
          text: textOf(message.content),
          complete: true,
          timestamp: entry.timestamp,
          ...(thinking ? { thinking } : {}),
        }),
      );
      if (message.role === "assistant")
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const argumentSummary = bounded(part.arguments, 800);
          toolIndexes.set(part.id, items.length);
          items.push({
            type: "tool",
            id: part.id,
            name: part.name,
            argumentSummary: argumentSummary.text,
            state: "running",
            preview: "",
            truncated: argumentSummary.truncated,
          });
        }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const toolIndex = toolIndexes.get(message.toolCallId);
    if (toolIndex === undefined) continue;
    const tool = items[toolIndex];
    if (!tool || tool.type !== "tool") continue;
    const output = boundedResource(textOf(message.content));
    const preview = bounded(output.text);
    const outputTruncated = preview.truncated || output.sourceTruncated;
    let resolved: ToolItem = {
      ...tool,
      state: message.isError ? "error" : "success",
      preview: preview.text,
      truncated: tool.truncated || outputTruncated,
    };
    if (outputTruncated) {
      const resourceId = randomUUID().replaceAll("-", "");
      toolOutputs.set(resourceId, { id: resourceId, ...output });
      resolved = { ...resolved, resourceId, outputSize: output.text.length };
    }
    items[toolIndex] = resolved;
  }
  for (const [index, item] of items.entries())
    if (item.type === "tool" && item.state === "running")
      items[index] = {
        ...item,
        state: "error",
        preview: "Tool execution was interrupted before a result was recorded.",
      };
  return { items, toolOutputs };
}

function messageItems(input: TextItem): Array<TextItem | SkillItem> {
  if (input.type !== "user") return [input];
  const skill = parseSkillBlock(input.text);
  if (!skill) return [input];
  const item: SkillItem = {
    type: "skill",
    id: `${input.id}-skill`,
    name: skill.name,
    content: skill.content,
    timestamp: input.timestamp,
  };
  return skill.userMessage ? [item, { ...input, text: skill.userMessage }] : [item];
}

type ResourceDiagnostic = AdapterWorkspaceInfo["resourceDiagnostics"][number];
const resourceDiagnostic = (type: string, message: string): ResourceDiagnostic => ({
  level: type === "error" ? "error" : "warning",
  message: message.slice(0, 1000),
});

function makePiSession(session: AgentSession): PiSession {
  const nativeId = session.sessionId;
  const nativePath = session.sessionFile;
  const restoredTranscript = transcriptItems(session.sessionManager.buildContextEntries());
  const listeners = new Set<(event: AdapterEvent) => void>();
  const pendingDialogs = new Map<string, (value: string | boolean | null) => void>();
  let settlementGeneration = 0;
  const unsubscribe = session.subscribe(handle);
  async function bind() {
    await session.bindExtensions({
      uiContext: uiContext(),
      mode: "rpc",
      onError: (error) =>
        emit({ type: "notice", level: "error", text: `Extension error: ${error.error}` }),
    });
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
  function subscribe(listener: (event: AdapterEvent) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function emit(event: AdapterEvent) {
    for (const listener of listeners) listener(event);
  }
  function emitSettled() {
    settlementGeneration += 1;
    emit({ type: "settled" });
  }
  function handle(event: AgentSessionEvent) {
    if (
      event.type === "message_start" ||
      event.type === "message_end" ||
      event.type === "message_update"
    )
      handleMessage(event);
    else if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    )
      handleTool(event);
    else if (event.type === "queue_update")
      emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
    else if (event.type === "agent_settled") emitSettled();
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
  function handleMessage(event: SessionMessageEvent) {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta")
        emit({
          type: "delta",
          itemId: messageId(event.message),
          delta: update.delta,
          channel: update.type === "text_delta" ? "text" : "thinking",
        });
      return;
    }
    if (event.message.role !== "user" && event.message.role !== "assistant") return;
    const thinking = thinkingOf(event.message.content);
    const item: TextItem = {
      type: event.message.role,
      id: messageId(event.message),
      text: textOf(event.message.content),
      ...(thinking ? { thinking } : {}),
      complete: event.type === "message_end",
      timestamp: new Date(event.message.timestamp ?? Date.now()).toISOString(),
    };
    for (const message of messageItems(item)) emit({ type: "message", item: message });
    if (event.type === "message_end" && event.message.role === "assistant") scheduleContextUsage();
  }
  function handleTool(event: ToolExecutionEvent) {
    if (event.type === "tool_execution_start") {
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
      return;
    }
    const running = event.type === "tool_execution_update";
    const output = boundedResource(running ? event.partialResult : event.result);
    const preview = bounded(output.text);
    const item: ToolItem = {
      type: "tool",
      id: event.toolCallId,
      name: event.toolName,
      argumentSummary: running ? bounded(event.args, 800).text : "",
      state: running ? "running" : event.isError ? "error" : "success",
      preview: preview.text,
      truncated: preview.truncated || output.sourceTruncated,
    };
    emit({ type: "tool", item, output });
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
    const previousSettlement = settlementGeneration;
    await session.prompt(text);
    if (session.isIdle && settlementGeneration === previousSettlement) emitSettled();
  }
  async function abort() {
    session.clearQueue();
    await session.abort();
  }
  async function configure(input: {
    model?: string;
    thinkingLevel?: EffectAdapterSession["state"]["thinkingLevel"];
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
  const lifecycle: SessionLifecycle = {
    subscribe,
    abort,
    dispose,
  };
  const state: EffectAdapterSession["state"] = {
    get nativeId() {
      return nativeId;
    },
    get nativePath() {
      return nativePath;
    },
    get messages() {
      return restoredTranscript.items;
    },
    get toolOutputs() {
      return restoredTranscript.toolOutputs;
    },
    get model() {
      return session.model ? `${session.model.provider}/${session.model.id}` : undefined;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    get sessionName() {
      return session.sessionName;
    },
    get contextUsage() {
      return readContextUsage();
    },
    get isIdle() {
      return session.isIdle;
    },
  };
  return {
    state,
    events: sessionEvents(lifecycle),
    bind,
    lifecycle,
    prompt: (text) =>
      attemptSessionPromise("session.prompt", () => prompt(text)).pipe(
        Effect.onInterrupt(() => abortForCleanup(lifecycle)),
      ),
    steer: (text) => attemptSessionPromise("session.steer", () => session.steer(text)),
    followUp: (text) => attemptSessionPromise("session.followUp", () => session.followUp(text)),
    abort: () => attemptSessionPromise("session.abort", abort),
    clearQueue: () =>
      attemptSessionSync("session.clearQueue", () => {
        session.clearQueue();
      }),
    configure: (input) => attemptSessionPromise("session.configure", () => configure(input)),
    rename: (name) =>
      attemptSessionSync("session.rename", () => {
        session.setSessionName(name);
      }),
    compact: (instructions) =>
      attemptSessionPromise("session.compact", () => session.compact(instructions)),
    getStats: () => attemptSessionSync("session.getStats", getStats),
    respondToDialog: (requestId, value) =>
      attemptSessionSync("session.respondToDialog", () => {
        respondToDialog(requestId, value);
      }),
    dispose,
  };
}

export function makePiSdk(options: PiSdkOptions = {}) {
  const agentDir = options.agentDir ?? getAgentDir();

  async function services(cwd: string) {
    const settings = SettingsManager.create(cwd, agentDir);
    let trust: { trusted: boolean | null; skipped: boolean };
    if (!hasTrustRequiringProjectResources(cwd)) {
      trust = { trusted: true, skipped: false };
    } else {
      const saved = new ProjectTrustStore(agentDir).get(cwd);
      const trusted = saved ?? (settings.getDefaultProjectTrust() === "always" ? true : null);
      trust = { trusted, skipped: trusted !== true };
    }
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
    await loader.reload({ resolveProjectTrust: async () => trust.trusted === true });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    await modelRuntime.refresh({ allowNetwork: false });
    const sessionDirOverride = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
    return {
      settings,
      trust,
      loader,
      modelRuntime,
      sessionDir: sessionDirOverride
        ? path.resolve(
            cwd,
            sessionDirOverride.replace(/^~(?=$|\/)/, agentDir.replace(/\/\.pi\/agent$/, "")),
          )
        : settings.getSessionDir(),
    };
  }

  async function inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo> {
    const { settings, trust, loader, modelRuntime, sessionDir } = await services(cwd);
    const sessions = await SessionManager.list(cwd, sessionDir);
    const result = await createAgentSession({
      cwd,
      agentDir,
      settingsManager: settings,
      resourceLoader: loader,
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const commands: AdapterWorkspaceInfo["commands"] = [];
    const commandNames = new Set<string>();
    const addCommand = (name: string, description?: string) => {
      if (commandNames.has(name)) return;
      commandNames.add(name);
      commands.push({ name, ...(description ? { description } : {}) });
    };
    try {
      for (const command of result.session.extensionRunner.getRegisteredCommands())
        addCommand(command.invocationName, command.description);
      for (const prompt of result.session.promptTemplates)
        addCommand(prompt.name, prompt.description);
      for (const skill of result.session.resourceLoader.getSkills().skills)
        addCommand(`skill:${skill.name}`, skill.description);
    } finally {
      result.session.dispose();
    }
    const diagnostics: AdapterWorkspaceInfo["resourceDiagnostics"] = [
      ...[
        ...loader.getSkills().diagnostics,
        ...loader.getPrompts().diagnostics,
        ...loader.getThemes().diagnostics,
      ].map((entry) => resourceDiagnostic(entry.type, entry.message)),
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
      commands,
    };
  }

  async function open(
    cwd: string,
    svc: Awaited<ReturnType<typeof services>>,
    manager: SessionManager,
  ) {
    const result = await createAgentSession({
      cwd,
      agentDir,
      settingsManager: svc.settings,
      resourceLoader: svc.loader,
      modelRuntime: svc.modelRuntime,
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
    const svc = await services(cwd);
    return open(cwd, svc, SessionManager.create(cwd, svc.sessionDir));
  }

  async function resumeSession(cwd: string, nativePath: string) {
    const svc = await services(cwd);
    return open(cwd, svc, SessionManager.open(nativePath, svc.sessionDir, cwd));
  }

  async function setWorkspaceTrust(cwd: string, trusted: boolean) {
    new ProjectTrustStore(agentDir).set(cwd, trusted);
  }

  async function inheritWorkspaceTrust(sourceCwd: string, cwd: string) {
    const trust = new ProjectTrustStore(agentDir);
    const decision = trust.get(sourceCwd);
    if (decision !== null) trust.set(cwd, decision);
  }

  async function clearWorkspaceTrust(cwd: string) {
    new ProjectTrustStore(agentDir).set(cwd, null);
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

const { promise: attemptSessionPromise, sync: attemptSessionSync } =
  taggedAttempt("AdapterSessionError");

function sessionEvents(session: SessionLifecycle): Stream.Stream<AdapterEvent> {
  return Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        session.subscribe((event) => {
          Queue.offerUnsafe(queue, event);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

function abortForCleanup(session: SessionLifecycle): Effect.Effect<void> {
  return Effect.tryPromise(() => session.abort()).pipe(Effect.ignore);
}

function releasePiSession(session: AcquiredPiSession): Effect.Effect<void> {
  return abortForCleanup(session.lifecycle).pipe(
    Effect.andThen(
      Effect.try({
        try: () => session.lifecycle.dispose(),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
    ),
  );
}

export function acquireAdapterSession<E, R>(
  acquire: Effect.Effect<AcquiredPiSession, E, R>,
): Effect.Effect<EffectAdapterSession, E, R | Scope.Scope> {
  return Effect.acquireRelease(acquire, releasePiSession);
}

function bounded(value: unknown, max = 12_000): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = "[unserializable output]";
  }
  return text.length <= max
    ? { text, truncated: false }
    : { text: `${text.slice(0, max)}\n… output truncated`, truncated: true };
}

function boundedResource(
  value: unknown,
  max = 1_000_000,
): { text: string; sourceTruncated: boolean } {
  const serialized = bounded(value, max);
  return { text: serialized.text, sourceTruncated: serialized.truncated };
}

export type PiSdk = ReturnType<typeof makePiSdk>;

export function makePiSdkService(sdk: PiSdk) {
  return {
    inspectWorkspace: (cwd: string) =>
      fromPiPromise("workspace.inspect", () => sdk.inspectWorkspace(cwd)),
    createSession: (cwd: string) =>
      acquireAdapterSession(fromPiPromise("session.create", () => sdk.createSession(cwd))),
    resumeSession: (cwd: string, nativePath: string) =>
      acquireAdapterSession(
        fromPiPromise("session.resume", () => sdk.resumeSession(cwd, nativePath)),
      ),
    setWorkspaceTrust: (cwd: string, trusted: boolean) =>
      fromPiPromise("workspace.trust.set", () => sdk.setWorkspaceTrust(cwd, trusted)),
    inheritWorkspaceTrust: (sourceCwd: string, cwd: string) =>
      fromPiPromise("workspace.trust.inherit", () => sdk.inheritWorkspaceTrust(sourceCwd, cwd)),
    clearWorkspaceTrust: (cwd: string) =>
      fromPiPromise("workspace.trust.clear", () => sdk.clearWorkspaceTrust(cwd)),
  };
}

export type PiSdkServiceApi = ReturnType<typeof makePiSdkService>;

const { promise: fromPiPromise } = taggedAttempt("PiSdkError");
