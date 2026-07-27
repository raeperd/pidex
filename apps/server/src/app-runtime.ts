import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { ChatManager } from "./chat-manager.js";
import { applicationError, type ApplicationError } from "./errors.js";
import { MetadataStore } from "./metadata.js";
import { PiSdk } from "./pi-sdk.js";

export class Metadata extends Context.Service<Metadata, MetadataStore>()(
  "@pidex/server/Metadata",
) {}

export class PiAgent extends Context.Service<PiAgent, PiSdk>()("@pidex/server/PiAgent") {}

export class Chats extends Context.Service<Chats, ChatManager>()("@pidex/server/Chats") {}

export type ApplicationServices = Metadata | PiAgent | Chats;
export type ApplicationRuntime = ManagedRuntime.ManagedRuntime<
  ApplicationServices,
  ApplicationError
>;

export function makeApplicationRuntime() {
  return ManagedRuntime.make(ApplicationLive);
}

export const MetadataLive = Layer.effect(
  Metadata,
  Effect.acquireRelease(
    Effect.try({
      try: () => new MetadataStore(),
      catch: (cause) => applicationError("metadata.initialize", cause),
    }),
    (metadata) => Effect.sync(() => metadata.close()),
  ),
);

export const PiAgentLive = Layer.sync(PiAgent, () => new PiSdk());

export const ChatsLive = Layer.effect(
  Chats,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const metadata = yield* Metadata;
      const pi = yield* PiAgent;
      return new ChatManager(pi, metadata);
    }),
    (chats) => Effect.sync(() => chats.shutdown()),
  ),
);

const ApplicationDependencies = Layer.mergeAll(MetadataLive, PiAgentLive);

export const ApplicationLive = ChatsLive.pipe(Layer.provideMerge(ApplicationDependencies));
