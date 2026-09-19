import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Conversation = Schema.Struct({
  id: Schema.String,
  modelName: Schema.String,
  status: Schema.Literal("idle"),
  messageCount: Schema.Number,
});

export const ConversationApi = RpcGroup.make(
  Rpc.make("GetConversation", { success: Conversation }),
);
