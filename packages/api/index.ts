import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Conversation = Schema.Struct({
  id: Schema.String,
  modelName: Schema.String,
  status: Schema.Literals(["idle", "running"]),
  messageCount: Schema.Number,
  entries: Schema.Array(
    Schema.Union([
      Schema.Struct({
        id: Schema.String,
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
      }),
      Schema.Struct({
        id: Schema.String,
        role: Schema.Literal("tool"),
        name: Schema.String,
        input: Schema.String,
        result: Schema.String,
        status: Schema.Literals(["running", "completed", "failed"]),
      }),
    ]),
  ),
  error: Schema.String,
});

export class SendError extends Schema.TaggedError<SendError>()("SendError", {
  message: Schema.String,
}) {}

export const ConversationApi = RpcGroup.make(
  Rpc.make("GetConversation", { success: Conversation }),
  Rpc.make("Watch", { success: Conversation, stream: true }),
  Rpc.make("Send", { payload: { text: Schema.String }, error: SendError }),
);
