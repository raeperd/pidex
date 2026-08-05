import { assert, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { Auth, makeAuthLayer } from "./auth.js";

layer(makeAuthLayer({ desktopBootstrapCredential: "desktop-bootstrap-test-credential" }))(
  "Auth",
  (it) => {
    it.effect("exchanges a desktop grant exactly once under concurrent use", () =>
      Effect.gen(function* () {
        const auth = yield* Auth;
        const grant = yield* auth.createDesktopGrant("desktop-bootstrap-test-credential");

        const attempts = yield* Effect.all(
          [auth.exchangeDesktopGrant(grant.secret), auth.exchangeDesktopGrant(grant.secret)].map(
            Effect.result,
          ),
          { concurrency: "unbounded" },
        );

        assert.strictEqual(attempts.filter(Result.isSuccess).length, 1);
        assert.strictEqual(attempts.filter(Result.isFailure).length, 1);
      }),
    );
  },
);

layer(
  makeAuthLayer({
    desktopBootstrapCredential: "desktop-bootstrap-test-credential",
    ticketLifetimeMillis: 1_000,
  }),
)("WebSocket ticket expiry", (it) => {
  it.effect("rejects a ticket after its short lifetime", () =>
    Effect.gen(function* () {
      const auth = yield* Auth;
      const grant = yield* auth.createDesktopGrant("desktop-bootstrap-test-credential");
      const session = yield* auth.exchangeDesktopGrant(grant.secret);
      const ticket = yield* auth.createWebSocketTicket(session.credential);

      yield* TestClock.adjust("1 second");

      const error = yield* auth.consumeWebSocketTicket(ticket.secret).pipe(Effect.flip);
      assert.strictEqual(error.reason, "expired");
    }),
  );
});
