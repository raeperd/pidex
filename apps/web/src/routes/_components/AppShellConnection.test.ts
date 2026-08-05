import { PROTOCOL_VERSION } from "@pidex/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeChatConnection, type ConnectionState } from "./AppShellConnection";

describe("ChatConnection", () => {
  beforeEach(() => {
    fakeWebSockets.length = 0;
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:4783" });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("WebSocket", function (url: string) {
      return makeFakeWebSocket(url);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("gets a one-time ticket before opening a live connection", async () => {
    const events = vi.fn();
    const states: ConnectionState[] = [];
    const connection = makeChatConnection({
      getWebSocketTicket: vi.fn().mockResolvedValue("ticket_12345"),
      onEvent: events,
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_12345");
    await Promise.resolve();
    const socket = fakeWebSockets[0]!;
    expect(socket.url).toBe("ws://localhost:4783/api/ws?ticket=ticket_12345");
    socket.dispatch("open", {});

    expect(() => socket.dispatch("message", { data: "{" })).not.toThrow();
    expect(events).not.toHaveBeenCalled();
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  it("does not let a replaced socket report itself as connected", async () => {
    const states: ConnectionState[] = [];
    const connection = makeChatConnection({
      getWebSocketTicket: vi.fn().mockResolvedValue("ticket_12345"),
      onEvent: vi.fn(),
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_first");
    await Promise.resolve();
    const first = fakeWebSockets[0]!;
    connection.connect("chat_second");
    await Promise.resolve();
    const second = fakeWebSockets[1]!;

    first.dispatch("open", {});
    expect(first.closed).toBe(true);
    expect(states).toEqual(["reconnecting", "reconnecting"]);

    second.dispatch("open", {});
    expect(states).toEqual(["reconnecting", "reconnecting", "connected"]);
    expect(second.sent).toEqual([
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        chatId: "chat_second",
      }),
    ]);
  });
});

interface FakeWebSocket {
  readonly url: string;
  readonly listeners: Map<string, Array<(event: never) => void>>;
  readonly sent: string[];
  closed: boolean;
  addEventListener: (type: string, listener: (event: never) => void) => void;
  close: () => void;
  send: (data: string) => void;
  dispatch: (type: string, event: unknown) => void;
}

function makeFakeWebSocket(url: string): FakeWebSocket {
  const listeners = new Map<string, Array<(event: never) => void>>();
  const sent: string[] = [];
  const socket = {
    url,
    listeners,
    sent,
    closed: false,
    addEventListener(type: string, listener: (event: never) => void) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    close() {
      socket.closed = true;
    },
    send(data: string) {
      sent.push(data);
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    },
  };
  fakeWebSockets.push(socket);
  return socket;
}

const fakeWebSockets: FakeWebSocket[] = [];
