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
  ContextUsage,
  ExtensionDialog,
  SkillItem,
  TextItem,
  TranscriptItem,
  ToolItem,
} from "@pidex/api";
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
import { taggedAttempt, type TaggedOperationError } from "./errors.js";

type PiSdkError = TaggedOperationError<"PiSdkError">;

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
        .map((part) => (part.type === "thinking" ? part.thinking?.trim() : undefined))
        .filter((thinking): thinking is string => Boolean(thinking))
        .join("\n\n")
    : "";
const messageId = (message: { role: string; timestamp?: number }) =>
  `${message.role}-${message.timestamp ?? Date.now()}`;

function transcriptItems(entries: SessionEntry[]) {
  const items: TranscriptItem[] = [];
  const toolOutputs = new Map<string, { id: string; text: string; sourceTruncated: boolean }>();
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
    let resolved: ToolItem = {
      ...tool,
      state: message.isError ? "error" : "success",
      preview: preview.text,
      truncated: tool.truncated || preview.truncated || output.sourceTruncated,
    };
    if (preview.truncated || output.sourceTruncated) {
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
      (event.type === "message_start" || event.type === "message_end") &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
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
      if (event.type === "message_end" && event.message.role === "assistant")
        scheduleContextUsage();
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
    get messages(): TranscriptItem[] {
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
    bind,
    subscribe,
    prompt,
    steer: (text: string) => session.steer(text),
    followUp: (text: string) => session.followUp(text),
    abort,
    clearQueue: () => session.clearQueue(),
    configure,
    rename: (name: string) => session.setSessionName(name),
    compact: async (instructions?: string) => {
      await session.compact(instructions);
    },
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
    const { agentDir, settings, trust, loader, modelRuntime, sessionDir } = await services(cwd);
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
      agentDir: svc.agentDir,
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

export function makePiSdkService(sdk: PiSdk): PiSdkServiceApi {
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

const { promise: fromPiPromise } = taggedAttempt("PiSdkError");
