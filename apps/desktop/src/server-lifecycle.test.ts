import { NodeServices } from "@effect/platform-node";
import { assert, expect, it, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import {
  desktopServerError,
  issueAuthGrantForTrustedSender,
  makeAuthenticatedServerCommand,
  superviseServer,
  waitForServer,
} from "./server-lifecycle.js";

layer(NodeServices.layer)("desktop server bootstrap channel", (test) => {
  test.effect("passes the credential through fd3 without argv or environment exposure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "fd3-only-desktop-bootstrap-credential";
        const script = [
          'const fs = require("node:fs")',
          'const fd3 = fs.readFileSync(3, "utf8")',
          'process.stdout.write(JSON.stringify({ argv: process.argv, environmentContains: Object.values(process.env).includes(fd3), fd3, supervised: process.env.PIDEX_DESKTOP_SUPERVISED === "1" }))',
        ].join(";");
        const handle = yield* makeAuthenticatedServerCommand(
          process.execPath,
          ["-e", script],
          secret,
          {
            env: {
              PIDEX_ALLOW_ENV_BOOTSTRAP: "1",
              PIDEX_BOOTSTRAP_PROBE: "1",
              PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL: secret,
            },
            extendEnv: true,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const output = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
        yield* handle.exitCode;
        const result: unknown = JSON.parse(output);
        if (!isBootstrapProbe(result)) throw new Error("Invalid bootstrap probe output");

        assert.deepStrictEqual(result.argv.includes(secret), false);
        assert.isFalse(result.environmentContains);
        assert.strictEqual(result.fd3, secret);
        assert.isTrue(result.supervised);
      }),
    ),
  );
});

it("issues a fresh auth grant for every trusted renderer request", async () => {
  let issued = 0;
  const issueGrant = async () => `grant-${++issued}`;

  await expect(issueAuthGrantForTrustedSender(false, issueGrant)).resolves.toBeNull();
  await expect(issueAuthGrantForTrustedSender(true, issueGrant)).resolves.toBe("grant-1");
  await expect(issueAuthGrantForTrustedSender(true, issueGrant)).resolves.toBe("grant-2");
  expect(issued).toBe(2);
});

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

function isBootstrapProbe(value: unknown): value is {
  readonly argv: string[];
  readonly environmentContains: boolean;
  readonly fd3: string;
  readonly supervised: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "argv" in value &&
    Array.isArray(value.argv) &&
    value.argv.every((argument) => typeof argument === "string") &&
    "environmentContains" in value &&
    typeof value.environmentContains === "boolean" &&
    "fd3" in value &&
    typeof value.fd3 === "string" &&
    "supervised" in value &&
    typeof value.supervised === "boolean"
  );
}
