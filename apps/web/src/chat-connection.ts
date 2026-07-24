import { PROTOCOL_VERSION, serverEventSchema, type ServerEvent } from "@pidex/api";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface ChatConnectionHandlers {
  onEvent: (event: ServerEvent) => void;
  onInvalidChat: () => void;
  onStateChange: (state: ConnectionState) => void;
}

export class ChatConnection {
  private chatId: string | undefined;
  private lastEventId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: WebSocket | undefined;

  constructor(private readonly handlers: ChatConnectionHandlers) {}

  connect(chatId: string) {
    this.chatId = chatId;
    this.lastEventId = 0;
    this.open();
  }

  reconnect() {
    if (this.chatId) this.open();
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.handlers.onStateChange("disconnected");
  }

  close() {
    this.chatId = undefined;
    this.lastEventId = 0;
    this.disconnect();
  }

  private open() {
    const chatId = this.chatId;
    if (!chatId) return;

    clearTimeout(this.reconnectTimer);
    this.handlers.onStateChange("reconnecting");

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/api/ws`);
    const previous = this.socket;
    this.socket = socket;
    previous?.close();

    socket.addEventListener("open", () => {
      this.handlers.onStateChange("connected");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          chatId,
          ...(this.lastEventId ? { lastEventId: this.lastEventId } : {}),
        }),
      );
    });
    socket.addEventListener("message", (message) => this.receive(socket, message.data));
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || !this.chatId) return;
      if (event.code === 1008) {
        this.chatId = undefined;
        this.lastEventId = 0;
        this.socket = undefined;
        this.handlers.onStateChange("disconnected");
        this.handlers.onInvalidChat();
        return;
      }
      if (!navigator.onLine) {
        this.handlers.onStateChange("disconnected");
        return;
      }
      this.handlers.onStateChange("reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), 800);
    });
  }

  private receive(socket: WebSocket, data: unknown) {
    if (this.socket !== socket) return;
    const raw: unknown = JSON.parse(String(data));
    if (typeof raw === "object" && raw !== null && "type" in raw && raw.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    const parsed = serverEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.chatId !== this.chatId) return;
    this.lastEventId = Math.max(this.lastEventId, parsed.data.eventId);
    socket.send(JSON.stringify({ type: "ack", eventId: parsed.data.eventId }));
    this.handlers.onEvent(parsed.data);
  }
}
