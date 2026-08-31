import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterAll, assert, describe, layer } from "@effect/vitest";
import { ActionProtocolError } from "./errors.js";
import { Metadata, makeMetadataLayer, requestDigest } from "./metadata.js";

describe("metadata Effect service", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "pidex-metadata-effect-"));

  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  layer(makeMetadataLayer(stateDir))((effectIt) => {
    effectIt.effect("persists metadata through Effect-returning methods", () =>
      Effect.gen(function* () {
        const metadata = yield* Metadata;
        const workspaceId = yield* metadata.rememberWorkspace("/tmp/effect-project");

        assert.strictEqual(yield* metadata.workspaceId("/tmp/effect-project"), workspaceId);
        assert.deepStrictEqual(yield* metadata.recent(), [
          { id: workspaceId, path: "/tmp/effect-project" },
        ]);
      }),
    );

    effectIt.effect("translates transaction throws into typed metadata errors", () =>
      Effect.gen(function* () {
        const metadata = yield* Metadata;
        const error = yield* metadata.reorderWorkspaces(["missing-workspace"]).pipe(Effect.flip);

        assert.propertyVal(error, "_tag", "MetadataError");
        assert.strictEqual(error.operation, "reorderWorkspaces");
      }),
    );

    effectIt.effect("preserves typed action protocol errors", () =>
      Effect.gen(function* () {
        const metadata = yield* Metadata;
        const request = promptRequest("effect-session", "effectaction0001");
        yield* metadata.acceptPrompt(request);

        const error = yield* metadata
          .acceptPrompt({
            ...request,
            requestDigest: requestDigest({ text: "changed" }),
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, ActionProtocolError);
        assert.strictEqual(error.code, "action_conflict");
      }),
    );

    effectIt.effect("validates rows read from SQLite with the Drizzle-derived Effect schema", () =>
      Effect.gen(function* () {
        const database = new DatabaseSync(path.join(stateDir, "pidex.sqlite"));
        database
          .prepare(
            `INSERT INTO session_state
              (session_key, revision, run_id, prompt_action_id, run_status,
               requires_acknowledgement, updated_at)
             VALUES (?, 1, ?, ?, 'corrupt', 0, datetime('now'))`,
          )
          .run("corrupt-session", "corrupt-run", "corrupt-action");
        database.close();

        const metadata = yield* Metadata;
        const error = yield* metadata.sessionState("corrupt-session").pipe(Effect.flip);

        assert.propertyVal(error, "_tag", "MetadataError");
        assert.strictEqual(error.operation, "sessionState");
      }),
    );

    effectIt.effect("persists action transitions through the public service", () =>
      Effect.gen(function* () {
        const metadata = yield* Metadata;
        const request = promptRequest("transition-session", "transitionprompt1");
        const accepted = yield* metadata.acceptPrompt(request);
        const steerRequest = {
          ...request,
          actionId: "transitionsteer1",
          expectedRevision: accepted.revision,
          requestDigest: requestDigest({ text: "adjust" }),
          runId: accepted.runId,
          kind: "steer" as const,
        };

        const steer = yield* metadata.acceptRunMutation(steerRequest);
        yield* metadata.markActionStatus(steerRequest.actionId, "completed");
        const replay = yield* metadata.acceptRunMutation(steerRequest);

        assert.strictEqual(steer.revision, 2);
        assert.strictEqual(replay.replayed, true);
        assert.strictEqual(replay.status, "completed");
      }),
    );
  });
});

function promptRequest(sessionKey: string, actionId: string) {
  return {
    actionId,
    clientId: `client-${sessionKey}`,
    expectedRevision: 0,
    requestDigest: requestDigest({ text: "work" }),
    sessionKey,
  };
}
