import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  nativeTheme: {},
}));

import { desktopServerError, superviseServer, waitForServer } from "./main.js";

it.effect("releases the server process when supervision is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();
    const stopped = yield* Ref.make(false);
    const runServer = Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
      Ref.set(stopped, true),
    ).pipe(Effect.andThen(Deferred.await(exited)));

    const fiber = yield* superviseServer(runServer).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);

    assert.isTrue(yield* Ref.get(stopped));
  }),
);

it.effect("reports recent logs after readiness retries are exhausted", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const checkHealth = Ref.update(attempts, (count) => count + 1).pipe(
      Effect.andThen(
        Effect.fail(desktopServerError("server.health", "Health request failed", "offline")),
      ),
    );

    const error = yield* waitForServer(checkHealth, Effect.succeed(["server failed"]), {
      attempts: 3,
      delay: 0,
    }).pipe(Effect.flip);

    assert.strictEqual(yield* Ref.get(attempts), 3);
    assert.include(error.message, "server failed");
  }),
);
