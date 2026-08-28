import type { ChatSnapshot } from "@pidex/api";
import { describe, expect, it } from "vitest";
import { makeTaskSnapshotCache, taskPath } from "./TaskNavigationState";

const snapshot = (taskId: string, revision: number) => ({ taskId, revision }) as ChatSnapshot;

describe("TaskSnapshotCache", () => {
  it("has no snapshot for a cold route", () => {
    expect(makeTaskSnapshotCache().get("task-1")).toBeUndefined();
  });

  it("returns the latest snapshot when a task is revisited", () => {
    const cache = makeTaskSnapshotCache();
    cache.set(snapshot("task-1", 1));
    cache.set(snapshot("task-1", 2));

    expect(cache.get("task-1")?.revision).toBe(2);
  });

  it("keeps tasks isolated by their globally unique IDs", () => {
    const cache = makeTaskSnapshotCache();
    cache.set(snapshot("task-1", 1));

    expect(cache.get("task-2")).toBeUndefined();
  });

  it("expires snapshots after the retention window", () => {
    let now = 0;
    const cache = makeTaskSnapshotCache(1_000, () => now);
    cache.set(snapshot("task-1", 1));
    now = 1_001;

    expect(cache.get("task-1")).toBeUndefined();
  });
});

describe("taskPath", () => {
  it("uses the public task namespace", () => {
    expect(taskPath("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/tasks/550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
