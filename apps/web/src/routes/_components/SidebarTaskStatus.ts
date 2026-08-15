import type { ChatSnapshot } from "@pidex/api";

export type SidebarStatus = "error" | "running" | "idle";

function fromLiveRunStatus(liveRunStatus: ChatSnapshot["runStatus"]): SidebarStatus {
  if (liveRunStatus === "running" || liveRunStatus === "stopping" || liveRunStatus === "compacting")
    return "running";
  return liveRunStatus === "error" ? "error" : "idle";
}

/**
 * The live snapshot wins for the task the user has open — it reflects run_status events
 * instantly, before the next listing refresh could ever catch up. Every other row has no
 * live snapshot to read, so it falls back to whatever the server last reported.
 */
export function resolveTaskStatus(input: {
  session: { id: string; status?: SidebarStatus };
  liveTaskId: string | undefined;
  liveRunStatus: ChatSnapshot["runStatus"] | undefined;
}): SidebarStatus {
  if (input.liveTaskId === input.session.id && input.liveRunStatus !== undefined)
    return fromLiveRunStatus(input.liveRunStatus);
  return input.session.status ?? "idle";
}

/**
 * error > running > idle: one priority table shared by every rollup consumer (the collapsed
 * project dot, the favicon aggregate) so the worst thing happening always wins — a task that
 * needs attention should never be masked by one that's merely still running, and a merely
 * running task should never be masked by the many that are quietly idle. Mirrors paseo's
 * STATUS_BUCKET_PRIORITY.
 */
export function rollupProjectStatus(statuses: Iterable<SidebarStatus>): SidebarStatus {
  let sawRunning = false;
  for (const status of statuses) {
    if (status === "error") return "error";
    if (status === "running") sawRunning = true;
  }
  return sawRunning ? "running" : "idle";
}
