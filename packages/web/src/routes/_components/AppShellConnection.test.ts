import type { ServerEvent } from "@pidex/api";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeChatConnection, type ConnectionState } from "./AppShellConnection";

describe("ChatConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it("cancels the active HTTP stream when disconnected", async () => {
    const stream = pendingStream();
    const transport = makeTransport([stream]);
    const states: ConnectionState[] = [];
    const connection = makeChatConnection(
      {
        onEvent: vi.fn(),
        onInvalidChat: vi.fn(),
        onStateChange: (state) => states.push(state),
      },
      transport,
    );

    connection.connect("chat_12345");
    await vi.waitFor(() => expect(transport.options).toHaveLength(1));
    connection.disconnect();

    expect(transport.options[0]?.signal.aborted).toBe(true);
    expect(stream.return).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("disconnected");
  });

  it("does not schedule a second retry after a transport-owned stream error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    const transport = makeTransport([errorStream()]);
    const states: ConnectionState[] = [];
    const connection = makeChatConnection(
      {
        onEvent: vi.fn(),
        onInvalidChat: vi.fn(),
        onStateChange: (state) => states.push(state),
      },
      transport,
    );

    connection.connect("chat_12345");
    await vi.waitFor(() => expect(transport.inputs).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(800);

    expect(transport.inputs).toHaveLength(1);
    expect(states.at(-1)).toBe("disconnected");
    connection.close();
  });

  it("disconnects once for a permanent invalid-chat error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    const onInvalidChat = vi.fn();
    const transport = makeTransport([errorStream(new ORPCError("internal_error"))]);
    const states: ConnectionState[] = [];
    const connection = makeChatConnection(
      {
        onEvent: vi.fn(),
        onInvalidChat,
        onStateChange: (state) => states.push(state),
      },
      transport,
    );

    connection.connect("chat_12345");
    await vi.waitFor(() => expect(onInvalidChat).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(800);

    expect(transport.inputs).toHaveLength(1);
    expect(states.at(-1)).toBe("disconnected");
    connection.close();
  });
});

function runStatusEvent(eventId: number): ServerEvent {
  return {
    source: "pidex",
    eventId,
    chatId: "chat_12345",
    event: {
      type: "run_status",
      status: "idle",
      revision: 0,
    },
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

function pendingStream(): AsyncIterator<ServerEvent> {
  return {
    next: vi.fn(() => new Promise<IteratorResult<ServerEvent>>(() => {})),
    return: vi.fn(
      async (): Promise<IteratorResult<ServerEvent>> => ({
        done: true,
        value: undefined,
      }),
    ),
  };
}

function errorStream(error = new Error("connection lost")): AsyncIterator<ServerEvent> {
  return { next: vi.fn().mockRejectedValue(error) };
}

function makeTransport(streams: AsyncIterator<ServerEvent>[]) {
  const inputs: Array<{ chatId: string; lastEventId?: number }> = [];
  const requests: Array<{ signal: AbortSignal }> = [];
  return {
    inputs,
    options: requests,
    events: vi.fn(
      async (
        input: { chatId: string; lastEventId?: number },
        transportOptions: { signal: AbortSignal },
      ) => {
        inputs.push(input);
        requests.push(transportOptions);
        const stream = streams.shift();
        if (!stream) throw new Error("No stream available");
        return stream;
      },
    ),
  };
}
