import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpError } from "./errors.js";
import { canonicalWorkspace, isDescendant, parsePort, safeError } from "./security.js";

describe("local security", () => {
  it.effect("rejects path-prefix traps and symlink escapes", () =>
    Effect.gen(function* () {
      const base = yield* temporaryDirectory;
      const root = path.join(base, "work");
      const outside = path.join(base, "workspace-evil");
      yield* Effect.tryPromise(() => mkdir(root));
      yield* Effect.tryPromise(() => mkdir(outside));
      yield* Effect.tryPromise(() => symlink(outside, path.join(root, "escape")));
      const canonicalRoot = yield* Effect.tryPromise(() => realpath(root));
      assert.isFalse(isDescendant(canonicalRoot, outside));

      const escaped = yield* Effect.flip(
        canonicalWorkspace(path.join(root, "escape"), [canonicalRoot]),
      );
      if (!(escaped instanceof HttpError))
        return yield* Effect.die(new Error("Expected canonical workspace to fail with HttpError"));
      assert.strictEqual(escaped.status, 403);
      const forbidden = yield* Effect.flip(canonicalWorkspace(outside, [canonicalRoot]));
      if (!(forbidden instanceof HttpError))
        return yield* Effect.die(new Error("Expected forbidden workspace to fail with HttpError"));
      assert.strictEqual(forbidden.status, 403);
    }),
  );

  it("validates ports and redacts obvious bearer secrets", () => {
    assert.strictEqual(parsePort("4783"), 4783);
    assert.throws(() => parsePort("80"), /1024/);
    assert.throws(() => parsePort("oops"), /integer/);
    assert.notInclude(safeError(new Error("Bearer secret-token-value")), "secret-token-value");
  });

  it.effect("redacts common labeled secrets from errors", () =>
    Effect.sync(() => {
      const sanitized = safeError(
        new Error(
          "OPENAI_API_KEY=canary-api-key-value refresh_token: canary-refresh-token password=canary-password-value",
        ),
      );

      assert.notInclude(sanitized, "canary-api-key-value");
      assert.notInclude(sanitized, "canary-refresh-token");
      assert.notInclude(sanitized, "canary-password-value");
    }),
  );
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), "pidex-path-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);
