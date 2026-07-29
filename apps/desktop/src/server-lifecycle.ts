import { Duration, Effect, Schedule } from "effect";

export interface DesktopServerError {
  readonly _tag: "DesktopServerError";
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}

export interface ServerProcess {
  readonly exited: Effect.Effect<void, DesktopServerError>;
  readonly stop: Effect.Effect<void>;
}

export const superviseServer = Effect.fn("desktop.server.supervise")(function* (
  spawnServer: Effect.Effect<ServerProcess, DesktopServerError>,
) {
  const runServer = Effect.scoped(
    Effect.acquireRelease(spawnServer, (server) => server.stop).pipe(
      Effect.flatMap((server) => server.exited),
    ),
  ).pipe(Effect.catch((error) => Effect.logWarning(`${error.message}: ${String(error.cause)}`)));
  const restartSchedule = Schedule.exponential("300 millis", 2).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(5))),
    ),
  );
  return yield* runServer.pipe(Effect.repeat(restartSchedule));
});

export const waitForServer = Effect.fn("desktop.server.waitUntilReady")(function* (
  checkHealth: Effect.Effect<void, DesktopServerError>,
  recentLogs: Effect.Effect<ReadonlyArray<string>>,
  options: { readonly attempts?: number; readonly delay?: Duration.Input } = {},
) {
  const attempts = options.attempts ?? 80;
  const delay = options.delay ?? "125 millis";
  return yield* checkHealth.pipe(
    Effect.retry({ schedule: Schedule.spaced(delay), times: Math.max(0, attempts - 1) }),
    Effect.catch((error) =>
      recentLogs.pipe(
        Effect.flatMap((logs) =>
          Effect.fail(
            desktopServerError(
              "server.ready",
              `Pidex server did not become ready. Recent logs:\n${logs.slice(-20).join("\n")}`,
              error,
            ),
          ),
        ),
      ),
    ),
  );
});

export function desktopServerError(
  operation: string,
  message: string,
  cause: unknown,
): DesktopServerError {
  return { _tag: "DesktopServerError", operation, message, cause };
}
