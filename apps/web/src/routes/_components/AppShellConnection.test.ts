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

  it("ignores malformed server frames without disrupting the active connection", () => {
    const events = vi.fn();
    const states: ConnectionState[] = [];
    const connection = makeChatConnection({
      onEvent: events,
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_12345");
    const socket = fakeWebSockets[0]!;
    socket.dispatch("open", {});

    expect(() => socket.dispatch("message", { data: "{" })).not.toThrow();
    expect(events).not.toHaveBeenCalled();
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  it("does not let a replaced socket report itself as connected", () => {
    const states: ConnectionState[] = [];
    const connection = makeChatConnection({
      onEvent: vi.fn(),
      onInvalidChat: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    connection.connect("chat_first");
    const first = fakeWebSockets[0]!;
    connection.connect("chat_second");
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
