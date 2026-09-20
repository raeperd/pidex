import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

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

export const Conversation = Schema.Struct({
  id: Schema.String,
  modelName: Schema.String,
  setupError: Schema.NullOr(SetupError),
  status: Schema.Literals(["idle", "running", "stopping"]),
  runId: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  entries: Schema.Array(Entry),
  error: Schema.String,
});

export const ConversationUpdate = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Snapshot"), conversation: Conversation }),
  Schema.Struct({ _tag: Schema.Literal("EntryUpserted"), entry: Entry }),
  Schema.Struct({
    _tag: Schema.Literal("TextDelta"),
    id: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("StateChanged"),
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

export const ConversationApi = RpcGroup.make(
  Rpc.make("Subscribe", { success: ConversationUpdate, error: SubscribeError, stream: true }),
  Rpc.make("Send", {
    payload: { text: Schema.String, submissionId: Schema.optional(Schema.String) },
    error: SendError,
  }),
  Rpc.make("Stop", { payload: { runId: Schema.String }, error: StopError }),
);

export function applyConversationUpdate(
  current: typeof Conversation.Type,
  update: typeof ConversationUpdate.Type,
): typeof Conversation.Type {
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
