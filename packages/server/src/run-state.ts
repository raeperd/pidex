import type { ChatSnapshot, RunOutcome } from "@pidex/api";

/** What a live chat reports to connected clients while the server holds it in memory. */
export type LiveRunStatus = ChatSnapshot["runStatus"];

/** What a run records in SQLite, and therefore what survives a restart. */
type DurableRunStatus = RunOutcome["status"];

/**
 * Every transition the run lifecycle can make, as the live status it produces plus — only when
 * the transition is durable — the status to record. A missing `durable` key is a statement rather
 * than an omission: a stop request and both ends of a compaction change what clients see without
 * ever reaching disk, which is why no persisted run has ever held those values.
 */
export const runTransitions = {
  promptStarted: { live: "running", durable: "running" },
  promptFailed: { live: "error", durable: "failed" },
  runCompleted: { live: "idle", durable: "completed" },
  runCancelled: { live: "idle", durable: "cancelled" },
  stopRequested: { live: "stopping" },
  compactStarted: { live: "compacting" },
  compactEnded: { live: "idle" },
} as const satisfies Record<string, { live: LiveRunStatus; durable?: DurableRunStatus }>;

export type RunTransitionName = keyof typeof runTransitions;

/**
 * Coarsens run state down to what the sidebar needs. A live chat always wins over persisted
 * state (it is the more current source of truth); with no live chat, only a persisted failure
 * or an unacknowledged crash-interrupted run counts as "error" — everything else the server
 * knows (completed, cancelled, or an in-flight run left behind by a race) reads as idle rather
 * than inventing a status the server cannot actually stand behind.
 */
export function resolveSessionStatus(
  liveRunStatus: LiveRunStatus | undefined,
  persistedRun: RunOutcome | undefined,
): "running" | "error" | "idle" {
  if (liveRunStatus === "running" || liveRunStatus === "stopping" || liveRunStatus === "compacting")
    return "running";
  if (liveRunStatus === "error") return "error";
  if (liveRunStatus === "idle") return "idle";
  if (
    persistedRun?.status === "failed" ||
    (persistedRun?.status === "interrupted" && persistedRun.requiresAcknowledgement)
  )
    return "error";
  return "idle";
}
