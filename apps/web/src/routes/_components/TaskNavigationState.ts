import type { ChatSnapshot } from "@pidex/api";

const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;

export function makeTaskSnapshotCache(retentionMs = DEFAULT_RETENTION_MS, now = Date.now) {
  const snapshots = new Map<string, { snapshot: ChatSnapshot; retainedAt: number }>();

  function get(taskId: string) {
    const cached = snapshots.get(taskId);
    if (!cached) return undefined;
    if (now() - cached.retainedAt <= retentionMs) return cached.snapshot;
    snapshots.delete(taskId);
    return undefined;
  }

  function set(snapshot: ChatSnapshot) {
    const retainedAt = now();
    for (const [taskId, cached] of snapshots)
      if (retainedAt - cached.retainedAt > retentionMs) snapshots.delete(taskId);
    snapshots.set(snapshot.taskId, { snapshot, retainedAt });
  }

  function clear() {
    snapshots.clear();
  }

  return { get, set, clear };
}

export const taskPath = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;
