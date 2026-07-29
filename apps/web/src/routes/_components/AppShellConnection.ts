import { PROTOCOL_VERSION, serverEventSchema, type ServerEvent } from "@pidex/api";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface ChatConnectionHandlers {
  onEvent: (event: ServerEvent) => void;
  onInvalidChat: () => void;
  onStateChange: (state: ConnectionState) => void;
}

export function makeChatConnection(handlers: ChatConnectionHandlers) {
  let activeChatId: string | undefined;
  let lastEventId = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;

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
    const activeSocket = socket;
    socket = undefined;
    activeSocket?.close();
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
    handlers.onStateChange("reconnecting");

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const nextSocket = new WebSocket(`${scheme}://${location.host}/api/ws`);
    const previous = socket;
    socket = nextSocket;
    previous?.close();

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || activeChatId !== chatId) {
        nextSocket.close();
        return;
      }
      handlers.onStateChange("connected");
      nextSocket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          chatId,
          ...(lastEventId ? { lastEventId } : {}),
        }),
      );
    });
    nextSocket.addEventListener("message", (message) => receive(nextSocket, message.data));
    nextSocket.addEventListener("error", () => nextSocket.close());
    nextSocket.addEventListener("close", (event) => {
      if (socket !== nextSocket || !activeChatId) return;
      if (event.code === 1008) {
        activeChatId = undefined;
        lastEventId = 0;
        socket = undefined;
        handlers.onStateChange("disconnected");
        handlers.onInvalidChat();
        return;
      }
      if (!navigator.onLine) {
        handlers.onStateChange("disconnected");
        return;
      }
      handlers.onStateChange("reconnecting");
      reconnectTimer = setTimeout(open, 800);
    });
  }

  function receive(source: WebSocket, data: unknown) {
    if (socket !== source) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof raw === "object" && raw !== null && "type" in raw && raw.type === "ping") {
      source.send(JSON.stringify({ type: "pong" }));
      return;
    }

    const parsed = serverEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.chatId !== activeChatId) return;
    lastEventId = Math.max(lastEventId, parsed.data.eventId);
    source.send(JSON.stringify({ type: "ack", eventId: parsed.data.eventId }));
    handlers.onEvent(parsed.data);
  }

  return { connect, reconnect, disconnect, close };
}
