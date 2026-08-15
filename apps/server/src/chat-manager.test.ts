import type { RunOutcome } from "@pidex/api";
import { describe, expect, it } from "@effect/vitest";
import { resolveSessionStatus } from "./chat-manager.js";

const runOutcome = (status: RunOutcome["status"], requiresAcknowledgement = false): RunOutcome => ({
  runId: "run_12345678",
  actionId: "action_12345678",
  status,
  requiresAcknowledgement,
});

describe("resolveSessionStatus", () => {
  it("maps an active live run status to running", () => {
    expect(resolveSessionStatus("running", undefined)).toBe("running");
    expect(resolveSessionStatus("stopping", undefined)).toBe("running");
    expect(resolveSessionStatus("compacting", undefined)).toBe("running");
  });

  it("maps a live error status to error", () => {
    expect(resolveSessionStatus("error", undefined)).toBe("error");
  });

  it("maps a live idle status to idle", () => {
    expect(resolveSessionStatus("idle", undefined)).toBe("idle");
  });

  it("prefers the live status over any persisted run when a chat is live", () => {
    expect(resolveSessionStatus("idle", runOutcome("failed"))).toBe("idle");
    expect(resolveSessionStatus("running", runOutcome("failed"))).toBe("running");
  });

  it("reports error for a persisted failed run with no live chat", () => {
    expect(resolveSessionStatus(undefined, runOutcome("failed"))).toBe("error");
  });

  it("reports error for a persisted interrupted run awaiting acknowledgement", () => {
    expect(resolveSessionStatus(undefined, runOutcome("interrupted", true))).toBe("error");
  });

  it("reports idle for a persisted interrupted run already acknowledged", () => {
    expect(resolveSessionStatus(undefined, runOutcome("interrupted", false))).toBe("idle");
  });

  it("reports idle for completed, cancelled, or in-flight persisted runs with no live chat", () => {
    expect(resolveSessionStatus(undefined, runOutcome("completed"))).toBe("idle");
    expect(resolveSessionStatus(undefined, runOutcome("cancelled"))).toBe("idle");
    expect(resolveSessionStatus(undefined, runOutcome("accepted"))).toBe("idle");
    expect(resolveSessionStatus(undefined, runOutcome("running"))).toBe("idle");
  });

  it("reports idle when there is neither a live chat nor persisted run state", () => {
    expect(resolveSessionStatus(undefined, undefined)).toBe("idle");
  });
});
