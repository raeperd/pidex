import type { ChatSnapshot, ServerEvent } from "@pidex/api";
import { describe, expect, it } from "vitest";
import {
  appendPendingTextDelta,
  applyPendingTextDeltas,
  type PendingTextDeltas,
} from "./text-deltas";

describe("streamed text delta batching", () => {
  it("preserves delta order across text and thinking channels", () => {
    const pending: PendingTextDeltas = new Map();
    appendPendingTextDelta(pending, delta("text", "Hello"));
    appendPendingTextDelta(pending, delta("thinking", "Plan"));
    appendPendingTextDelta(pending, delta("text", " world"));

    const next = applyPendingTextDeltas(snapshot(), pending);

    expect(next.items[0]).toMatchObject({
      type: "assistant",
      text: "Hello world",
      thinking: "Plan",
    });
  });

  it("does not mutate the current snapshot or unrelated messages", () => {
    const current = snapshot();
    const pending: PendingTextDeltas = new Map();
    appendPendingTextDelta(pending, delta("text", "next"));

    const updated = applyPendingTextDeltas(current, pending);

    expect(updated).not.toBe(current);
    expect(current.items[0]).toMatchObject({ text: "" });
    expect(updated.items[1]).toBe(current.items[1]);
  });

  it("returns the same snapshot when there is nothing to flush", () => {
    const current = snapshot();

    expect(applyPendingTextDeltas(current, new Map())).toBe(current);
  });
});

function delta(channel: "text" | "thinking", value: string) {
  return {
    type: "text_delta",
    eventId: 1,
    chatId: "chat-1",
    itemId: "assistant-1",
    channel,
    delta: value,
  } satisfies Extract<ServerEvent, { type: "text_delta" }>;
}

function snapshot(): ChatSnapshot {
  return {
    chatId: "chat-1",
    items: [
      {
        type: "assistant",
        id: "assistant-1",
        text: "",
        complete: false,
        timestamp: "2026-07-27T00:00:00.000Z",
      },
      {
        type: "user",
        id: "user-1",
        text: "Question",
        complete: true,
        timestamp: "2026-07-27T00:00:00.000Z",
      },
    ],
  } as ChatSnapshot;
}
