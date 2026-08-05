import { Duration, Effect, Schedule, Stream, type Scope } from "effect";
import { ChildProcess } from "effect/unstable/process";

export interface DesktopServerError {
  readonly _tag: "DesktopServerError";
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}

export function makeAuthenticatedServerCommand(
  executable: string,
  args: ReadonlyArray<string>,
  desktopBootstrapCredential: string,
  options: Omit<ChildProcess.CommandOptions, "additionalFds">,
) {
  const environment = { ...options.env };
  delete environment.PIDEX_ALLOW_ENV_BOOTSTRAP;
  delete environment.PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL;
  return ChildProcess.make(executable, args, {
    ...options,
    env: environment,
    extendEnv: false,
    additionalFds: {
      fd3: {
        type: "input",
        stream: Stream.make(new TextEncoder().encode(desktopBootstrapCredential)),
      },
    },
  });
}

export async function issueAuthGrantForTrustedSender(
  trusted: boolean,
  issueGrant: () => Promise<string>,
) {
  return trusted ? issueGrant() : null;
}

export const superviseServer = Effect.fn("desktop.server.supervise")(function* <R>(
  runServer: Effect.Effect<void, DesktopServerError, Scope.Scope | R>,
) {
  const runScoped = Effect.scoped(runServer).pipe(
    Effect.catch((error) => Effect.logWarning(`${error.message}: ${String(error.cause)}`)),
  );
  const restartSchedule = Schedule.exponential("300 millis", 2).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(5))),
    ),
  );
  return yield* runScoped.pipe(Effect.repeat(restartSchedule));
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
