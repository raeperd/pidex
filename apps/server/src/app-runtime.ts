import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { makeChatManager, type ChatManager } from "./chat-manager.js";
import { applicationError } from "./errors.js";
import { makeMetadataStore, type MetadataStore } from "./metadata.js";
import { makePiSdk, type PiSdk } from "./pi-sdk.js";

export const Metadata = Context.Service<MetadataStore>("@pidex/server/Metadata");
export const PiAgent = Context.Service<PiSdk>("@pidex/server/PiAgent");
export const Chats = Context.Service<ChatManager>("@pidex/server/Chats");

export type ApplicationServices =
  | Context.Service.Identifier<typeof Metadata>
  | Context.Service.Identifier<typeof PiAgent>
  | Context.Service.Identifier<typeof Chats>;

export function makeApplicationRuntime() {
  return ManagedRuntime.make(ApplicationLive);
}

const MetadataLive = Layer.effect(
  Metadata,
  Effect.acquireRelease(
    Effect.try({
      try: makeMetadataStore,
      catch: (cause) => applicationError("metadata.initialize", cause),
    }),
    (metadata) => Effect.sync(() => metadata.close()),
  ),
);

const PiAgentLive = Layer.sync(PiAgent, makePiSdk);

const ChatsLive = Layer.effect(
  Chats,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const metadata = yield* Metadata;
      const pi = yield* PiAgent;
      return makeChatManager(pi, metadata);
    }),
    (chats) => Effect.sync(() => chats.shutdown()),
  ),
);

const ApplicationDependencies = Layer.mergeAll(MetadataLive, PiAgentLive);

const ApplicationLive = ChatsLive.pipe(Layer.provideMerge(ApplicationDependencies));
