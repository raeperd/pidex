import type { ChatSnapshot, ServerEvent } from "@pidex/api";

export interface PendingTextDelta {
  text: string;
  thinking: string;
}

export type PendingTextDeltas = Map<string, PendingTextDelta>;

export function appendPendingTextDelta(
  pending: PendingTextDeltas,
  event: Extract<ServerEvent, { type: "text_delta" }>,
): void {
  const current = pending.get(event.itemId) ?? { text: "", thinking: "" };
  pending.set(event.itemId, {
    ...current,
    [event.channel]: current[event.channel] + event.delta,
  });
}

export function applyPendingTextDeltas(
  snapshot: ChatSnapshot,
  pending: PendingTextDeltas,
): ChatSnapshot {
  if (pending.size === 0) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      const delta = pending.get(item.id);
      if (!delta || item.type !== "assistant") return item;
      return {
        ...item,
        text: item.text + delta.text,
        thinking: (item.thinking ?? "") + delta.thinking,
      };
    }),
  };
}
