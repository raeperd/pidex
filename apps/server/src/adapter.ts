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

export type AdapterEvent =
  | { type: "message"; item: TextItem | SkillItem }
  | { type: "delta"; itemId: string; delta: string; channel: "text" | "thinking" }
  | { type: "tool"; item: ToolItem; output?: { text: string; sourceTruncated: boolean } }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "context_usage"; usage: ContextUsage }
  | { type: "settled" }
  | { type: "dialog"; dialog?: ExtensionDialog };

interface AdapterToolOutput {
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
export interface AdapterSession {
  readonly nativeId: string;
  readonly nativePath: string | undefined;
  readonly messages: TranscriptItem[];
  readonly toolOutputs: ReadonlyMap<string, AdapterToolOutput>;
  readonly model: string | undefined;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionName: string | undefined;
  readonly contextUsage: ContextUsage | undefined;
  readonly isIdle: boolean;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue(kind?: "steering" | "follow-up" | "all"): void;
  configure(input: {
    model?: string;
    thinkingLevel?: AdapterSession["thinkingLevel"];
  }): Promise<void>;
  rename(name: string): void;
  compact(instructions?: string): Promise<void>;
  getStats(): ChatSnapshot["stats"];
  respondToDialog(requestId: string, value: string | boolean | null): void;
  dispose(): void;
}

interface AdapterSessionError {
  readonly _tag: "AdapterSessionError";
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}

export interface EffectAdapterSession {
  readonly state: Pick<
    AdapterSession,
    | "nativeId"
    | "nativePath"
    | "messages"
    | "toolOutputs"
    | "model"
    | "thinkingLevel"
    | "sessionName"
    | "contextUsage"
    | "isIdle"
  >;
  readonly events: Stream.Stream<AdapterEvent>;
  prompt(text: string): Effect.Effect<void, AdapterSessionError>;
  steer(text: string): Effect.Effect<void, AdapterSessionError>;
  followUp(text: string): Effect.Effect<void, AdapterSessionError>;
  abort(): Effect.Effect<void, AdapterSessionError>;
  clearQueue(kind?: "steering" | "follow-up" | "all"): Effect.Effect<void, AdapterSessionError>;
  configure(input: {
    model?: string;
    thinkingLevel?: AdapterSession["thinkingLevel"];
  }): Effect.Effect<void, AdapterSessionError>;
  rename(name: string): Effect.Effect<void, AdapterSessionError>;
  compact(instructions?: string): Effect.Effect<void, AdapterSessionError>;
  getStats(): Effect.Effect<ChatSnapshot["stats"], AdapterSessionError>;
  respondToDialog(
    requestId: string,
    value: string | boolean | null,
  ): Effect.Effect<void, AdapterSessionError>;
}

export function acquireAdapterSession<E, R>(
  acquire: Effect.Effect<AdapterSession, E, R>,
): Effect.Effect<EffectAdapterSession, E, R | Scope.Scope> {
  return Effect.acquireRelease(acquire, releaseAdapterSession).pipe(
    Effect.map(toEffectAdapterSession),
  );
}

function toEffectAdapterSession(session: AdapterSession): EffectAdapterSession {
  return {
    state: session,
    events: sessionEvents(session),
    prompt: (text) =>
      attemptPromise("session.prompt", () => session.prompt(text)).pipe(
        Effect.onInterrupt(() => abortForCleanup(session)),
      ),
    steer: (text) => attemptPromise("session.steer", () => session.steer(text)),
    followUp: (text) => attemptPromise("session.followUp", () => session.followUp(text)),
    abort: () => attemptPromise("session.abort", () => session.abort()),
    clearQueue: (kind) =>
      attemptSync("session.clearQueue", () => {
        session.clearQueue(kind);
      }),
    configure: (input) => attemptPromise("session.configure", () => session.configure(input)),
    rename: (name) =>
      attemptSync("session.rename", () => {
        session.rename(name);
      }),
    compact: (instructions) =>
      attemptPromise("session.compact", () => session.compact(instructions)),
    getStats: () => attemptSync("session.getStats", () => session.getStats()),
    respondToDialog: (requestId, value) =>
      attemptSync("session.respondToDialog", () => {
        session.respondToDialog(requestId, value);
      }),
  };
}

function sessionEvents(session: AdapterSession): Stream.Stream<AdapterEvent> {
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

function releaseAdapterSession(session: AdapterSession): Effect.Effect<void> {
  return abortForCleanup(session).pipe(
    Effect.andThen(
      Effect.try({
        try: () => session.dispose(),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
    ),
  );
}

function abortForCleanup(session: AdapterSession): Effect.Effect<void> {
  return Effect.tryPromise(() => session.abort()).pipe(Effect.ignore);
}

function attemptPromise<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, AdapterSessionError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => adapterSessionError(operation, cause),
  });
}

function attemptSync<A>(
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, AdapterSessionError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => adapterSessionError(operation, cause),
  });
}

function adapterSessionError(operation: string, cause: unknown): AdapterSessionError {
  return {
    _tag: "AdapterSessionError",
    operation,
    message: cause instanceof Error ? cause.message : `Unexpected failure during ${operation}`,
    cause,
  };
}

export function bounded(value: unknown, max = 12_000): { text: string; truncated: boolean } {
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

export function boundedResource(
  value: unknown,
  max = 1_000_000,
): { text: string; sourceTruncated: boolean } {
  const serialized = bounded(value, max);
  return { text: serialized.text, sourceTruncated: serialized.truncated };
}
