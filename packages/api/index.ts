import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// Paths cross a native filesystem boundary; reject embedded NULs.
// oxlint-disable-next-line no-control-regex
export const ProjectPath = Schema.String.check(Schema.isPattern(/^\/[^\0]*$/));

// Names the session a request targets. A session draft has no file until its first saved reply;
// the server then finds the file by session ID.
export const SessionLocator = Schema.Struct({
  projectPath: ProjectPath,
  sessionId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)),
  sessionFile: Schema.optional(ProjectPath),
});

export class HistoryError extends Schema.TaggedError<HistoryError>()("HistoryError", {
  path: ProjectPath,
  message: Schema.String,
}) {}

export const SavedSession = Schema.Struct({
  ...SessionLocator.fields,
  sessionFile: ProjectPath,
  title: Schema.String.check(Schema.isNonEmpty()),
  modified: Schema.String.check(Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)),
});

export const SessionList = Schema.Struct({
  projectPath: ProjectPath,
  sessions: Schema.Array(SavedSession),
  errors: Schema.Array(HistoryError),
});

const Entry = Schema.Union([
  Schema.Struct({
    // User or assistant text message.
    id: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    submissionId: Schema.optional(Schema.String),
    text: Schema.String,
  }),
  Schema.Struct({
    // Tool call with its input, result, and execution status.
    id: Schema.String,
    role: Schema.Literal("tool"),
    name: Schema.String,
    input: Schema.String,
    result: Schema.String,
    status: Schema.Literals(["running", "completed", "failed"]),
  }),
]);

export class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
  reason: Schema.Literals(["authentication", "model"]),
  message: Schema.String,
}) {}

// A model is identified within its provider; display names can repeat.
export const ModelIdentity = Schema.Struct({ provider: Schema.String, id: Schema.String });

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

export class ModelListError extends Schema.TaggedError<ModelListError>()("ModelListError", {
  message: Schema.String,
}) {}

export const ModelList = Schema.Struct({
  projectPath: ProjectPath,
  sessionId: SessionLocator.fields.sessionId,
  models: Schema.Array(Schema.Struct({ ...ModelIdentity.fields, name: Schema.String })),
  errors: Schema.Array(ProviderError),
});

export const Conversation = Schema.Struct({
  id: Schema.String,
  sessionFile: ProjectPath,
  projectPath: Schema.String,
  modelName: Schema.String,
  model: Schema.NullOr(ModelIdentity),
  setupError: Schema.NullOr(SetupError),
  status: Schema.Literals(["idle", "running", "stopping", "unavailable"]),
  runId: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  entries: Schema.Array(Entry),
  error: Schema.String,
});

export const ConversationUpdate = Schema.Union([
  // The active run's conversation, sent to a new subscriber while a run is active.
  Schema.Struct({ _tag: Schema.Literal("Snapshot"), conversation: Conversation }),
  // Sent to new subscribers when no run is active.
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({
    _tag: Schema.Literal("EntryUpserted"),
    sessionId: Schema.optional(Schema.String),
    entry: Entry,
  }),
  Schema.Struct({
    _tag: Schema.Literal("TextDelta"),
    sessionId: Schema.optional(Schema.String),
    id: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("StateChanged"),
    sessionId: Schema.optional(Schema.String),
    status: Conversation.fields.status,
    runId: Conversation.fields.runId,
    messageCount: Conversation.fields.messageCount,
    error: Conversation.fields.error,
  }),
]);

export class SubscribeError extends Schema.TaggedError<SubscribeError>()("SubscribeError", {
  reason: Schema.Literals(["slow-consumer", "payload-too-large"]),
  message: Schema.String,
}) {}

export class SendError extends Schema.TaggedError<SendError>()("SendError", {
  message: Schema.String,
}) {}

export class StopError extends Schema.TaggedError<StopError>()("StopError", {
  message: Schema.String,
}) {}

export class ReadSessionError extends Schema.TaggedError<ReadSessionError>()("ReadSessionError", {
  // missing: the project folder or session file does not exist; unavailable: it cannot be used;
  // busy: a run for another session is active.
  reason: Schema.Literals(["missing", "unavailable", "busy"]),
  path: ProjectPath,
  code: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export const ConversationApi = RpcGroup.make(
  Rpc.make("ListSessions", {
    payload: { projectPath: ProjectPath },
    success: SessionList,
    error: HistoryError,
  }),
  Rpc.make("ReadSession", {
    // `writable` also requires a session draft to be able to save its first reply.
    payload: { ...SessionLocator.fields, writable: Schema.optional(Schema.Boolean) },
    success: Conversation,
    error: ReadSessionError,
  }),
  Rpc.make("ListModels", {
    payload: { projectPath: ProjectPath, sessionId: SessionLocator.fields.sessionId },
    success: ModelList,
    error: ModelListError,
  }),
  Rpc.make("Subscribe", {
    success: ConversationUpdate,
    error: SubscribeError,
    stream: true,
  }),
  Rpc.make("Send", {
    payload: {
      target: SessionLocator,
      text: Schema.String,
      submissionId: Schema.optional(Schema.String),
    },
    error: SendError,
  }),
  Rpc.make("Stop", { payload: { runId: Schema.String }, error: StopError }),
);

export function applyConversationUpdate(
  current: typeof Conversation.Type,
  update: typeof ConversationUpdate.Type,
): typeof Conversation.Type {
  if (update._tag === "Idle") return current;
  if (update._tag !== "Snapshot" && update.sessionId && update.sessionId !== current.id)
    return current;
  switch (update._tag) {
    case "Snapshot":
      return update.conversation;
    case "StateChanged":
      return {
        ...current,
        status: update.status,
        runId: update.runId,
        messageCount: update.messageCount,
        error: update.error,
      };
    case "EntryUpserted":
      return {
        ...current,
        entries: current.entries.some((entry) => entry.id === update.entry.id)
          ? current.entries.map((entry) => (entry.id === update.entry.id ? update.entry : entry))
          : [...current.entries, update.entry],
      };
    case "TextDelta":
      return {
        ...current,
        entries: current.entries.some((entry) => entry.id === update.id)
          ? current.entries.map((entry) =>
              entry.id === update.id && entry.role === "assistant"
                ? { ...entry, text: entry.text + update.delta }
                : entry,
            )
          : [...current.entries, { id: update.id, role: "assistant", text: update.delta }],
      };
  }
}
