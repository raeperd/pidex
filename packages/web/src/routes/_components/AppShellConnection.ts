import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { PROTOCOL_VERSION, type PidexApiContractClient, type ServerEvent } from "@pidex/api";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface ChatConnectionHandlers {
  onEvent: (event: ServerEvent) => void;
  onInvalidChat: () => void;
  onStateChange: (state: ConnectionState) => void;
}

interface ChatEventTransport {
  events: (
    input: { chatId: string; lastEventId?: number },
    options: { signal: AbortSignal },
  ) => Promise<AsyncIterator<ServerEvent>>;
  close: () => void;
}

export function makeChatConnection(
  handlers: ChatConnectionHandlers,
  transport: ChatEventTransport = makeWebSocketTransport(),
) {
  let activeChatId: string | undefined;
  let lastEventId = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
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

    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
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
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        handlers.onStateChange("disconnected");
        return;
      }
      handlers.onStateChange("reconnecting");
      reconnectTimer = setTimeout(open, 800);
    }
  }

  return { connect, reconnect, disconnect, close };
}

function makeWebSocketTransport(): ChatEventTransport {
  let socket: WebSocket | undefined;
  const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
  return {
    events: (input, options) => {
      const link = new RPCLink({
        connect: () => {
          socket = new WebSocket(endpoint);
          return socket;
        },
      });
      const client: PidexApiContractClient = createORPCClient(link);
      return client.live.events({ protocolVersion: PROTOCOL_VERSION, ...input }, options);
    },
    close: () => {
      socket?.close();
      socket = undefined;
    },
  };
}
