import { ORPCError } from "@orpc/client";
import type { ServerEvent } from "@pidex/api";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export function makeChatConnection(
  handlers: {
    onEvent: (event: ServerEvent) => void;
    onInvalidChat: () => void;
    onStateChange: (state: ConnectionState) => void;
  },
  transport: {
    events: (
      input: { chatId: string; lastEventId?: number },
      options: { signal: AbortSignal },
    ) => Promise<AsyncIterator<ServerEvent>>;
    close: () => void;
  },
) {
  let activeChatId: string | undefined;
  let lastEventId = 0;
  let stream: AsyncIterator<ServerEvent> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;

  function connect(chatId: string) {
    activeChatId = chatId;
    lastEventId = 0;
    open();
  }

  function reconnect() {
    if (activeChatId) open();
  }

  function disconnect() {
    generation++;
    controller?.abort();
    controller = undefined;
    void stream?.return?.();
    stream = undefined;
    transport.close();
    handlers.onStateChange("disconnected");
  }

  function close() {
    activeChatId = undefined;
    lastEventId = 0;
    disconnect();
  }

  function open() {
    const chatId = activeChatId;
    if (!chatId) return;

    controller?.abort();
    void stream?.return?.();
    stream = undefined;
    transport.close();
    handlers.onStateChange("reconnecting");

    const currentGeneration = ++generation;
    const currentController = new AbortController();
    controller = currentController;
    void consume(chatId, currentGeneration, currentController);
  }

  async function consume(chatId: string, currentGeneration: number, signal: AbortController) {
    try {
      const events = await transport.events(
        { chatId, ...(lastEventId ? { lastEventId } : {}) },
        { signal: signal.signal },
      );
      if (currentGeneration !== generation || activeChatId !== chatId) {
        await events.return?.();
        return;
      }
      stream = events;
      handlers.onStateChange("connected");
      while (true) {
        const result = await events.next();
        if (currentGeneration !== generation || activeChatId !== chatId) return;
        if (result.done) throw new Error("Chat event stream ended");
        lastEventId = Math.max(lastEventId, result.value.eventId);
        handlers.onEvent(result.value);
      }
    } catch (error) {
      if (currentGeneration !== generation || signal.signal.aborted || activeChatId !== chatId)
        return;
      if (error instanceof ORPCError && error.code === "internal_error") {
        activeChatId = undefined;
        lastEventId = 0;
        handlers.onStateChange("disconnected");
        handlers.onInvalidChat();
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        handlers.onStateChange("disconnected");
        return;
      }
      handlers.onStateChange("disconnected");
    }
  }

  return { connect, reconnect, disconnect, close };
}
