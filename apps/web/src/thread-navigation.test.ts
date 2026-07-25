import type { ChatSnapshot } from "@pidex/api";
import { describe, expect, it } from "vitest";
import { ThreadSnapshotCache } from "./thread-navigation";

const snapshot = (workspaceId: string, sessionId: string, revision: number) =>
  ({ workspaceId, sessionId, revision }) as ChatSnapshot;

describe("ThreadSnapshotCache", () => {
  it("has no snapshot for a cold route", () => {
    expect(new ThreadSnapshotCache().get("workspace-1", "thread-1")).toBeUndefined();
  });

  it("returns the latest snapshot when a route is revisited", () => {
    const cache = new ThreadSnapshotCache();
    cache.set(snapshot("workspace-1", "thread-1", 1));
    cache.set(snapshot("workspace-1", "thread-1", 2));

    expect(cache.get("workspace-1", "thread-1")?.revision).toBe(2);
  });

  it("keeps identical session IDs isolated by workspace", () => {
    const cache = new ThreadSnapshotCache();
    cache.set(snapshot("workspace-1", "thread-1", 1));

    expect(cache.get("workspace-2", "thread-1")).toBeUndefined();
  });

  it("expires snapshots after the retention window", () => {
    let now = 0;
    const cache = new ThreadSnapshotCache(1_000, () => now);
    cache.set(snapshot("workspace-1", "thread-1", 1));
    now = 1_001;

    expect(cache.get("workspace-1", "thread-1")).toBeUndefined();
  });
});
