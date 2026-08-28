import type { ServerEvent } from "@pidex/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeChatConnection, type ConnectionState } from "./AppShellConnection";

describe("ChatConnection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delivers typed events from the stream", async () => {
    const event = runStatusEvent(1);
    const transport = makeTransport([oneEvent(event)]);
    const events: ServerEvent[] = [];
    const states: ConnectionState[] = [];
    const connection = makeChatConnection(
      {
        onEvent: (received) => events.push(received),
        onInvalidChat: vi.fn(),
        onStateChange: (state) => states.push(state),
      },
      transport,
    );

    connection.connect("chat_12345");
    await vi.waitFor(() => expect(events).toEqual([event]));

    expect(transport.inputs).toEqual([{ chatId: "chat_12345" }]);
    expect(states).toContain("connected");
    connection.close();
  });

  it("resumes with the last received event ID after a stream error", async () => {
    const transport = makeTransport([errorAfter(runStatusEvent(7)), oneEvent(runStatusEvent(8))]);
    const received = vi.fn();
    const connection = makeChatConnection(
      {
        onEvent: received,
        onInvalidChat: vi.fn(),
        onStateChange: vi.fn(),
      },
      transport,
    );

    connection.connect("chat_12345");
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    connection.reconnect();
    await vi.waitFor(() => expect(transport.inputs).toHaveLength(2));

    expect(transport.inputs[1]).toEqual({ chatId: "chat_12345", lastEventId: 7 });
    connection.close();
  });
});

function runStatusEvent(eventId: number): ServerEvent {
  return {
    type: "run_status",
    eventId,
    chatId: "chat_12345",
    status: "idle",
    revision: 0,
  };
}

function oneEvent(event: ServerEvent): AsyncIterator<ServerEvent> {
  return {
    next: vi
      .fn<AsyncIterator<ServerEvent>["next"]>()
      .mockResolvedValueOnce({ done: false, value: event })
      .mockResolvedValue({ done: true, value: undefined }),
  };
}

function errorAfter(event: ServerEvent): AsyncIterator<ServerEvent> {
  return {
    next: vi
      .fn<AsyncIterator<ServerEvent>["next"]>()
      .mockResolvedValueOnce({ done: false, value: event })
      .mockRejectedValue(new Error("connection lost")),
  };
}

function makeTransport(streams: AsyncIterator<ServerEvent>[]) {
  const inputs: Array<{ chatId: string; lastEventId?: number }> = [];
  return {
    inputs,
    close: vi.fn(),
    events: vi.fn(async (input: { chatId: string; lastEventId?: number }) => {
      inputs.push(input);
      const stream = streams.shift();
      if (!stream) throw new Error("No stream available");
      return stream;
    }),
  };
}
