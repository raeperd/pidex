import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { Auth, makeAuthLayer } from "./auth.js";
import { makeChatManager, type ChatManager } from "./chat-manager.js";
import { makeMetadataLayer, Metadata } from "./metadata.js";
import { makePiSdk, makePiSdkService, type PiSdkOptions, type PiSdkServiceApi } from "./pi-sdk.js";

export { Auth, Metadata };

export const PiAgent = Context.Service<PiSdkServiceApi>("@pidex/server/PiAgent");
export const Chats = Context.Service<ChatManager>("@pidex/server/Chats");

export type ApplicationServices =
  | Context.Service.Identifier<typeof Metadata>
  | Context.Service.Identifier<typeof Auth>
  | Context.Service.Identifier<typeof PiAgent>
  | Context.Service.Identifier<typeof Chats>;

interface ApplicationRuntimeOptions {
  readonly desktopBootstrapCredential: string;
  readonly metadataStateDir?: string;
  readonly pi?: PiSdkOptions;
}

export function makeApplicationRuntime(options: ApplicationRuntimeOptions) {
  const authLive = makeAuthLayer({
    desktopBootstrapCredential: options.desktopBootstrapCredential,
  });
  const metadataLive = makeMetadataLayer(options.metadataStateDir);
  const piAgentLive = Layer.succeed(PiAgent)(makePiSdkService(makePiSdk(options.pi)));
  const dependencies = Layer.mergeAll(authLive, metadataLive, piAgentLive);
  const chatsLive = Layer.effect(
    Chats,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const metadata = yield* Metadata;
        const pi = yield* PiAgent;
        return makeChatManager(pi, metadata);
      }),
      (chats) => chats.shutdown(),
    ),
  );
  return ManagedRuntime.make(chatsLive.pipe(Layer.provideMerge(dependencies)));
}
