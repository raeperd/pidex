import type { ChatSnapshot } from "@pidex/api";

const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;

export class TaskSnapshotCache {
  private snapshots = new Map<string, { snapshot: ChatSnapshot; retainedAt: number }>();

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now = Date.now,
  ) {}

  get(taskId: string) {
    const cached = this.snapshots.get(taskId);
    if (!cached) return undefined;
    if (this.now() - cached.retainedAt <= this.retentionMs) return cached.snapshot;
    this.snapshots.delete(taskId);
    return undefined;
  }

  set(snapshot: ChatSnapshot) {
    const retainedAt = this.now();
    for (const [taskId, cached] of this.snapshots)
      if (retainedAt - cached.retainedAt > this.retentionMs) this.snapshots.delete(taskId);
    this.snapshots.set(snapshot.taskId, { snapshot, retainedAt });
  }

  clear() {
    this.snapshots.clear();
  }
}

export const taskPath = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;
