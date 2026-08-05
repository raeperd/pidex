import { createHash, randomBytes } from "node:crypto";
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";

interface AuthPrincipal {
  readonly clientId: string;
  readonly kind: "desktop";
}

interface AuthGrant {
  readonly secret: string;
  readonly expiresAt: number;
}

interface AuthSession extends AuthPrincipal {
  readonly credential: string;
  readonly csrfToken: string;
}

export interface AuthenticatedSession extends AuthPrincipal {
  readonly csrfToken: string;
}

class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "AuthenticationError",
  { reason: Schema.Literals(["invalid", "expired"]) },
) {}

interface AuthOptions {
  readonly desktopBootstrapCredential: string;
  readonly grantLifetimeMillis?: number;
  readonly ticketLifetimeMillis?: number;
}

interface AuthService {
  readonly createDesktopGrant: (
    bootstrapCredential: string,
  ) => Effect.Effect<AuthGrant, AuthenticationError>;
  readonly exchangeDesktopGrant: (
    grantSecret: string,
  ) => Effect.Effect<AuthSession, AuthenticationError>;
  readonly authenticateSession: (
    sessionCredential: string,
  ) => Effect.Effect<AuthenticatedSession, AuthenticationError>;
  readonly createWebSocketTicket: (
    sessionCredential: string,
  ) => Effect.Effect<AuthGrant, AuthenticationError>;
  readonly consumeWebSocketTicket: (
    ticketSecret: string,
  ) => Effect.Effect<AuthPrincipal, AuthenticationError>;
}

interface GrantRecord {
  readonly expiresAt: number;
}

interface AuthState {
  readonly grants: ReadonlyMap<string, GrantRecord>;
  readonly sessions: ReadonlyMap<string, AuthenticatedSession>;
  readonly tickets: ReadonlyMap<string, GrantRecord & { readonly principal: AuthPrincipal }>;
}

export const Auth = Context.Service<AuthService>("@pidex/server/Auth");

export function makeAuthLayer(options: AuthOptions) {
  return Layer.effect(
    Auth,
    Effect.gen(function* () {
      const state = yield* Ref.make<AuthState>({
        grants: new Map(),
        sessions: new Map(),
        tickets: new Map(),
      });
      const bootstrapVerifier = verifier(options.desktopBootstrapCredential);
      const grantLifetimeMillis = options.grantLifetimeMillis ?? 60_000;
      const ticketLifetimeMillis = Math.min(options.ticketLifetimeMillis ?? 60_000, 60_000);
      const authenticateSession = Effect.fn("auth.session.authenticate")(function* (
        sessionCredential: string,
      ) {
        const record = (yield* Ref.get(state)).sessions.get(verifier(sessionCredential));
        if (!record) return yield* Effect.fail(AuthenticationError.make({ reason: "invalid" }));
        return record;
      });

      return {
        createDesktopGrant: Effect.fn("auth.desktopGrant.create")(function* (
          bootstrapCredential: string,
        ) {
          if (verifier(bootstrapCredential) !== bootstrapVerifier)
            return yield* Effect.fail(AuthenticationError.make({ reason: "invalid" }));
          const now = yield* Clock.currentTimeMillis;
          const secret = randomCredential();
          const expiresAt = now + grantLifetimeMillis;
          yield* Ref.update(state, ({ grants, sessions, tickets }) => ({
            grants: new Map(grants).set(verifier(secret), { expiresAt }),
            sessions,
            tickets,
          }));
          return { secret, expiresAt };
        }),
        exchangeDesktopGrant: Effect.fn("auth.desktopGrant.exchange")(function* (
          grantSecret: string,
        ) {
          const now = yield* Clock.currentTimeMillis;
          const grantVerifier = verifier(grantSecret);
          const record = yield* Ref.modify(state, ({ grants, sessions, tickets }) => {
            const current = grants.get(grantVerifier);
            if (!current) {
              const unchanged: readonly [GrantRecord | undefined, AuthState] = [
                undefined,
                {
                  grants,
                  sessions,
                  tickets,
                },
              ];
              return unchanged;
            }
            const next = new Map(grants);
            next.delete(grantVerifier);
            const consumed: readonly [GrantRecord | undefined, AuthState] = [
              current,
              {
                grants: next,
                sessions,
                tickets,
              },
            ];
            return consumed;
          });
          if (!record) return yield* Effect.fail(AuthenticationError.make({ reason: "invalid" }));
          if (record.expiresAt <= now)
            return yield* Effect.fail(AuthenticationError.make({ reason: "expired" }));
          const credential = randomCredential();
          const session: AuthSession = {
            kind: "desktop",
            clientId: randomCredential(),
            credential,
            csrfToken: randomCredential(),
          };
          yield* Ref.update(state, ({ grants, sessions, tickets }) => ({
            grants,
            sessions: new Map(sessions).set(verifier(credential), {
              kind: session.kind,
              clientId: session.clientId,
              csrfToken: session.csrfToken,
            }),
            tickets,
          }));
          return session;
        }),
        authenticateSession,
        createWebSocketTicket: Effect.fn("auth.websocketTicket.create")(function* (
          sessionCredential: string,
        ) {
          const session = yield* authenticateSession(sessionCredential);
          const now = yield* Clock.currentTimeMillis;
          const secret = randomCredential();
          const expiresAt = now + ticketLifetimeMillis;
          yield* Ref.update(state, ({ grants, sessions, tickets }) => ({
            grants,
            sessions,
            tickets: new Map(tickets).set(verifier(secret), {
              expiresAt,
              principal: { kind: session.kind, clientId: session.clientId },
            }),
          }));
          return { secret, expiresAt };
        }),
        consumeWebSocketTicket: Effect.fn("auth.websocketTicket.consume")(function* (
          ticketSecret: string,
        ) {
          const now = yield* Clock.currentTimeMillis;
          const ticketVerifier = verifier(ticketSecret);
          const record = yield* Ref.modify(state, ({ grants, sessions, tickets }) => {
            const current = tickets.get(ticketVerifier);
            if (!current) {
              const unchanged: readonly [typeof current, AuthState] = [
                current,
                {
                  grants,
                  sessions,
                  tickets,
                },
              ];
              return unchanged;
            }
            const next = new Map(tickets);
            next.delete(ticketVerifier);
            const consumed: readonly [typeof current, AuthState] = [
              current,
              {
                grants,
                sessions,
                tickets: next,
              },
            ];
            return consumed;
          });
          if (!record) return yield* Effect.fail(AuthenticationError.make({ reason: "invalid" }));
          if (record.expiresAt <= now)
            return yield* Effect.fail(AuthenticationError.make({ reason: "expired" }));
          return record.principal;
        }),
      };
    }),
  );
}

function randomCredential() {
  return randomBytes(32).toString("base64url");
}

function verifier(secret: string) {
  return createHash("sha256").update(secret).digest("base64url");
}
