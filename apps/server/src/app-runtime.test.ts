import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { makeApplicationRuntime, PiAgent } from "./app-runtime.js";
import { Metadata } from "./metadata.js";

it.effect("composes the Effect-native Metadata and Pi services", () =>
  Effect.acquireUseRelease(
    Effect.tryPromise(async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pidex-runtime-"));
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      return { root, workspace };
    }),
    ({ root, workspace }) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          makeApplicationRuntime({
            desktopBootstrapCredential: "desktop-bootstrap-test-credential",
            metadataStateDir: path.join(root, "state"),
            pi: {
              agentDir: path.join(root, "agent"),
              sessionDir: path.join(root, "sessions"),
            },
          }),
        ),
        (runtime) =>
          Effect.gen(function* () {
            const context = yield* Effect.promise(() => runtime.context());
            const metadata = Context.get(context, Metadata);
            const pi = Context.get(context, PiAgent);

            assert.isTrue(Effect.isEffect(metadata.recent()));
            assert.isTrue(Effect.isEffect(pi.inspectWorkspace(workspace)));

            const workspaceId = yield* metadata.rememberWorkspace(workspace);
            assert.strictEqual(yield* metadata.workspaceId(workspace), workspaceId);
            assert.deepEqual((yield* pi.inspectWorkspace(workspace)).sessions, []);
          }),
        (runtime) => Effect.promise(() => runtime.dispose()),
      ),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ),
);
