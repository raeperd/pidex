import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOutcome } from "@pidex/api";
import { Effect, Stream } from "effect";
import { afterAll, assert, describe, expect, it, layer } from "@effect/vitest";
import type { EffectAdapterSession } from "./adapter.js";
import { makeChatManager } from "./chat-manager.js";
import { Metadata, makeMetadataLayer, requestDigest } from "./metadata.js";
import type { PiSdkServiceApi } from "./pi-sdk.js";
import { resolveSessionStatus } from "./run-state.js";

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

describe("attach", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "pidex-chat-manager-attach-"));
  const workspaceId = "attach_workspace_1";

  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  layer(makeMetadataLayer(stateDir))((effectIt) => {
    effectIt.effect("reports a live running status for a prompt that outlived its chat", () =>
      Effect.gen(function* () {
        // Crash recovery rewrites `accepted`/`running` rows to `interrupted` when the database
        // opens, so a persisted active run cannot survive a restart. It can still survive a
        // chat: disposing one drops the owner entry without settling the run, and the next
        // attach for the same session key reads the row back as active.
        const metadata = yield* Metadata;
        const manager = makeChatManager(stubPiService(), metadata);
        yield* manager.openWorkspace(workspaceId, "/tmp/pidex-attach-workspace");
        const chat = yield* manager.create(workspaceId);
        const accepted = yield* metadata.acceptPrompt({
          actionId: "attachaction0001",
          clientId: "chat_manager_test_client",
          expectedRevision: 0,
          requestDigest: requestDigest({ text: "Prompt that never settles" }),
          sessionKey: chat.sessionKey,
        });
        yield* manager.startPrompt(chat, "Prompt that never settles", accepted);
        yield* manager.dispose(chat);
        assert.strictEqual(
          (yield* metadata.sessionState(chat.sessionKey)).run?.status,
          "running",
          "disposing a chat must leave the persisted run active",
        );

        const reattached = yield* manager.create(workspaceId);

        assert.strictEqual(reattached.runStatus, "running");
        assert.strictEqual(reattached.run?.runId, accepted.runId);
      }),
    );
  });
});

/**
 * A Pi service whose one session never settles, so a started run stays active until the chat
 * holding it is disposed. Both `createSession` calls hand back that same session, which is what
 * makes the second attach land on the session key the first one left a run behind on.
 */
function stubPiService(): PiSdkServiceApi {
  const session: EffectAdapterSession = {
    state: {
      nativeId: "attach_session_key",
      nativePath: undefined,
      messages: [],
      toolOutputs: new Map(),
      model: undefined,
      thinkingLevel: "off",
      sessionName: undefined,
      contextUsage: undefined,
      isIdle: true,
    },
    events: Stream.never,
    prompt: () => Effect.never,
    steer: () => Effect.void,
    followUp: () => Effect.void,
    abort: () => Effect.void,
    clearQueue: () => Effect.void,
    configure: () => Effect.void,
    rename: () => Effect.void,
    compact: () => Effect.void,
    getStats: () =>
      Effect.succeed({ messages: 0, toolCalls: 0, tokens: 0, cost: 0, subscription: false }),
    respondToDialog: () => Effect.void,
  };
  return {
    inspectWorkspace: () =>
      Effect.succeed({
        models: [],
        sessions: [],
        trusted: true,
        protectedResourcesSkipped: false,
        resourceDiagnostics: [],
        commands: [],
      }),
    createSession: () => Effect.succeed(session),
    resumeSession: () => Effect.succeed(session),
    setWorkspaceTrust: () => Effect.void,
    inheritWorkspaceTrust: () => Effect.void,
    clearWorkspaceTrust: () => Effect.void,
  };
}
