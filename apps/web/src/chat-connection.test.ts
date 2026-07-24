import type { ServerEvent } from "@pidex/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConnection } from "./chat-connection";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeSocketEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit("close");
  }

  emit(type: string, event: FakeSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface FakeSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

const queueEvent = (chatId: string, eventId: number): ServerEvent => ({
  type: "queue",
  chatId,
  eventId,
  steering: [],
  followUp: [],
});

describe("ChatConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:4783" });
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores queued events from a socket replaced by another chat", () => {
    const onEvent = vi.fn();
    const connection = new ChatConnection({
      onEvent,
      onInvalidChat: vi.fn(),
      onStateChange: vi.fn(),
    });
    connection.connect("old-chat-123");
    const oldSocket = FakeWebSocket.instances[0]!;

    connection.connect("new-chat-456");
    oldSocket.emit("message", { data: JSON.stringify(queueEvent("old-chat-123", 1)) });

    expect(onEvent).not.toHaveBeenCalled();
    expect(oldSocket.sent).toEqual([]);
  });

  it("ignores an event for another chat on the current socket", () => {
    const onEvent = vi.fn();
    const connection = new ChatConnection({
      onEvent,
      onInvalidChat: vi.fn(),
      onStateChange: vi.fn(),
    });
    connection.connect("current-chat-123");
    const socket = FakeWebSocket.instances[0]!;

    socket.emit("message", { data: JSON.stringify(queueEvent("other-chat-456", 1)) });

    expect(onEvent).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });

  it("stops retrying and invalidates the chat after a policy close", () => {
    vi.useFakeTimers();
    const onInvalidChat = vi.fn();
    const onStateChange = vi.fn();
    const connection = new ChatConnection({
      onEvent: vi.fn(),
      onStateChange,
      onInvalidChat,
    });
    connection.connect("expired-chat-123");
    const socket = FakeWebSocket.instances[0]!;

    socket.emit("close", { code: 1008, reason: "Chat not found" });
    vi.advanceTimersByTime(1_000);

    expect(onStateChange).toHaveBeenLastCalledWith("disconnected");
    expect(onInvalidChat).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
