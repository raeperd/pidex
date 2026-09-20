import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

const Entry = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});

export const Conversation = Schema.Struct({
  id: Schema.String,
  modelName: Schema.String,
  status: Schema.Literals(["idle", "running"]),
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
    messageCount: Conversation.fields.messageCount,
    error: Conversation.fields.error,
  }),
]);

export class SendError extends Schema.TaggedError<SendError>()("SendError", {
  message: Schema.String,
}) {}

export const ConversationApi = RpcGroup.make(
  Rpc.make("Subscribe", { success: ConversationUpdate, stream: true }),
  Rpc.make("Send", { payload: { text: Schema.String }, error: SendError }),
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
