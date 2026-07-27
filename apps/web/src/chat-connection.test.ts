import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatConnection, type ConnectionState } from "./chat-connection";

describe("ChatConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:4783" });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("ignores malformed server frames without disrupting the active connection", () => {
    const events = vi.fn();
    const states: ConnectionState[] = [];
    const connection = new ChatConnection({
      onEvent: events,
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_12345");
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatch("open", {});

    expect(() => socket.dispatch("message", { data: "{" })).not.toThrow();
    expect(events).not.toHaveBeenCalled();
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  it("does not let a replaced socket report itself as connected", () => {
    const states: ConnectionState[] = [];
    const connection = new ChatConnection({
      onEvent: vi.fn(),
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_first");
    const first = FakeWebSocket.instances[0]!;
    connection.connect("chat_second");
    const second = FakeWebSocket.instances[1]!;

    first.dispatch("open", {});
    expect(first.closed).toBe(true);
    expect(states).toEqual(["reconnecting", "reconnecting"]);

    second.dispatch("open", {});
    expect(states).toEqual(["reconnecting", "reconnecting", "connected"]);
    expect(second.sent).toEqual([
      JSON.stringify({
        type: "hello",
        protocolVersion: 6,
        chatId: "chat_second",
      }),
    ]);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Array<(event: never) => void>>();
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  send(data: string) {
    this.sent.push(data);
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}
