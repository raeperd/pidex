import { describe, expect, it } from "vitest";
import { sessionRouteId } from "./session-route-id.js";

describe("sessionRouteId", () => {
  it("is stable for the same workspace and native session", () => {
    expect(sessionRouteId("workspace-1", "/sessions/thread.jsonl")).toBe(
      sessionRouteId("workspace-1", "/sessions/thread.jsonl"),
    );
  });

  it("isolates identical native session keys between workspaces", () => {
    expect(sessionRouteId("workspace-1", "/sessions/thread.jsonl")).not.toBe(
      sessionRouteId("workspace-2", "/sessions/thread.jsonl"),
    );
  });

  it("produces a compact URL-safe identifier", () => {
    expect(sessionRouteId("workspace-1", "/sessions/thread.jsonl")).toMatch(/^[\w-]{22}$/);
  });
});
