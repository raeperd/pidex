import type { ServerEvent } from "@pidex/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePidexApiClient } from "./AppShellApiClient";

describe("PidexApiClient live events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reconnects an event stream with the last event ID from metadata", async () => {
    const requests: Request[] = [];
    const event = runStatusEvent(8);
    const replayedEvent = runStatusEvent(9);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? new URL(input, "http://pidex.test") : input;
        requests.push(new Request(url, init));
        return Promise.resolve(
          eventResponse(requests.length === 1 ? event : replayedEvent, requests.length === 1),
        );
      }),
    );

    const api = makePidexApiClient();
    const events = await api.events(
      { chatId: event.chatId },
      { signal: new AbortController().signal },
    );

    await expect(events.next()).resolves.toMatchObject({ done: false, value: event });
    await expect(events.next()).resolves.toMatchObject({ done: false, value: replayedEvent });
    expect(requests[1]?.headers.get("last-event-id")).toBe("8");

    await events.return?.();
  });

  it("does not retry a stream while the browser is offline", async () => {
    const requests: Request[] = [];
    const event = runStatusEvent(8);
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? new URL(input, "http://pidex.test") : input;
        requests.push(new Request(url, init));
        return Promise.resolve(eventResponse(event, true));
      }),
    );

    const api = makePidexApiClient();
    const events = await api.events(
      { chatId: event.chatId },
      { signal: new AbortController().signal },
    );
    await events.next();

    await expect(events.next()).rejects.toThrow("connection lost");
    expect(requests).toHaveLength(1);
    await events.return?.();
  });

  it("does not retry a permanent oRPC error", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? new URL(input, "http://pidex.test") : input;
        requests.push(new Request(url, init));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              json: {
                code: "internal_error",
                message: "Chat was not found",
                defined: false,
                inferable: false,
              },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );

    const api = makePidexApiClient();
    await expect(
      api.events({ chatId: "chat_12345" }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(requests).toHaveLength(1);
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

function eventResponse(event: ServerEvent, failAfterEvent: boolean) {
  const encoded = new TextEncoder().encode(
    `event: message\nid: ${event.eventId}\nretry: 0\ndata: ${JSON.stringify({ json: event })}\n\n`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      if (failAfterEvent) setTimeout(() => controller.error(new Error("connection lost")), 0);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
