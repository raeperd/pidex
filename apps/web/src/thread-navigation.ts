import type { ChatSnapshot } from "@pidex/api";

const DEFAULT_RETENTION_MS = 5 * 60 * 1_000;

export class ThreadSnapshotCache {
  private snapshots = new Map<string, { snapshot: ChatSnapshot; retainedAt: number }>();

  constructor(
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly now = Date.now,
  ) {}

  get(workspaceId: string, sessionId: string) {
    const key = this.key(workspaceId, sessionId);
    const cached = this.snapshots.get(key);
    if (!cached) return undefined;
    if (this.now() - cached.retainedAt <= this.retentionMs) return cached.snapshot;
    this.snapshots.delete(key);
    return undefined;
  }

  set(snapshot: ChatSnapshot) {
    const retainedAt = this.now();
    for (const [key, cached] of this.snapshots)
      if (retainedAt - cached.retainedAt > this.retentionMs) this.snapshots.delete(key);
    this.snapshots.set(this.key(snapshot.workspaceId, snapshot.sessionId), {
      snapshot,
      retainedAt,
    });
  }

  clear() {
    this.snapshots.clear();
  }

  private key(workspaceId: string, sessionId: string) {
    return `${workspaceId}\0${sessionId}`;
  }
}

export const threadPath = (workspaceId: string, sessionId: string) =>
  `/w/${encodeURIComponent(workspaceId)}/t/${encodeURIComponent(sessionId)}`;

export const newThreadPath = (workspaceId: string) => `/w/${encodeURIComponent(workspaceId)}/new`;
