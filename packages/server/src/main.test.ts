import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import { safeError } from "./security.js";

describe("server startup", () => {
  it.effect("reports EADDRINUSE when the configured port is occupied", () =>
    Effect.gen(function* () {
      const occupied = yield* occupiedPort;
      const address = occupied.address();
      if (!address || typeof address === "string")
        return yield* Effect.die(new Error("Expected TCP server address"));
      const error = yield* Effect.scoped(
        HttpServer.HttpServer.pipe(
          Effect.provide(
            NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: address.port }),
          ),
        ),
      ).pipe(Effect.flip);

      assert.include(safeError(error), "EADDRINUSE");
    }),
  );
});

const occupiedPort = Effect.acquireRelease(
  Effect.tryPromise(
    () =>
      new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);
