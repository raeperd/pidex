import { describe, expect, it } from "vitest";
import { resolveTaskStatus, rollupProjectStatus } from "./SidebarTaskStatus";

describe("resolveTaskStatus", () => {
  it("prefers the live snapshot over the listing status for the open task", () => {
    expect(
      resolveTaskStatus({
        session: { id: "task-1", status: "idle" },
        liveTaskId: "task-1",
        liveRunStatus: "running",
      }),
    ).toBe("running");
  });

  it("reads stopping and compacting live statuses as running", () => {
    for (const liveRunStatus of ["stopping", "compacting"] as const)
      expect(
        resolveTaskStatus({
          session: { id: "task-1" },
          liveTaskId: "task-1",
          liveRunStatus,
        }),
      ).toBe("running");
  });

  it("reads a live error status as error", () => {
    expect(
      resolveTaskStatus({
        session: { id: "task-1", status: "running" },
        liveTaskId: "task-1",
        liveRunStatus: "error",
      }),
    ).toBe("error");
  });

  it("falls back to the listing status for a task that isn't the open one", () => {
    expect(
      resolveTaskStatus({
        session: { id: "task-2", status: "error" },
        liveTaskId: "task-1",
        liveRunStatus: "running",
      }),
    ).toBe("error");
  });

  it("falls back to the listing status when there is no live snapshot at all", () => {
    expect(
      resolveTaskStatus({
        session: { id: "task-1", status: "running" },
        liveTaskId: undefined,
        liveRunStatus: undefined,
      }),
    ).toBe("running");
  });

  it("treats a missing listing status as idle", () => {
    expect(
      resolveTaskStatus({
        session: { id: "task-2" },
        liveTaskId: "task-1",
        liveRunStatus: "running",
      }),
    ).toBe("idle");
  });
});

describe("rollupProjectStatus", () => {
  it("picks error over running and idle", () => {
    expect(rollupProjectStatus(["idle", "running", "error"])).toBe("error");
  });

  it("picks running over idle when there is no error", () => {
    expect(rollupProjectStatus(["idle", "running", "idle"])).toBe("running");
  });

  it("reads idle when every status is idle", () => {
    expect(rollupProjectStatus(["idle", "idle"])).toBe("idle");
  });

  it("reads idle for an empty iterable", () => {
    expect(rollupProjectStatus([])).toBe("idle");
  });
});
