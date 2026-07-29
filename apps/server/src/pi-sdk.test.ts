import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Stream } from "effect";
import {
  acquireAdapterSession,
  AdapterSessionError,
  type AdapterEvent,
  type AdapterSession,
} from "./adapter.js";
import { PiSdkError, PiSdkService } from "./pi-sdk.js";

describe("Effect Pi adapter", () => {
  it.effect("streams events in order and unsubscribes when the stream ends", () =>
    Effect.gen(function* () {
      const fixture = new SessionFixture();

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* acquireAdapterSession(Effect.succeed(fixture));
          const collected = yield* session.events.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* waitForSubscription(fixture);
          fixture.emit({ type: "notice", level: "info", text: "first" });
          fixture.emit({ type: "settled" });

          const result = yield* Fiber.join(collected);
          assert.strictEqual(fixture.listenerCount, 0);
          return result;
        }),
      );

      assert.deepEqual(events, [
        { type: "notice", level: "info", text: "first" },
        { type: "settled" },
      ]);
    }),
  );

  it.effect("maps rejected Pi operations to a typed local error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = new SessionFixture();
        fixture.promptFailure = new Error("prompt failed");
        const session = yield* acquireAdapterSession(Effect.succeed(fixture));

        assert.strictEqual(session.thinkingLevel, "minimal");
        assert.strictEqual(session.messages[0]?.id, fixture.sessionManager.getLeafId());
        const error = yield* session.prompt("hello").pipe(Effect.flip);

        assert.instanceOf(error, AdapterSessionError);
        assert.strictEqual(error.operation, "session.prompt");
        assert.strictEqual(error.message, "prompt failed");
      }),
    ),
  );

  it.effect("aborts interrupted prompts and disposes the session when its scope closes", () =>
    Effect.gen(function* () {
      const fixture = new SessionFixture();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* acquireAdapterSession(Effect.succeed(fixture));
          const prompt = yield* session.prompt("hello").pipe(Effect.forkScoped);

          yield* Effect.yieldNow;
          yield* Fiber.interrupt(prompt);

          assert.strictEqual(fixture.abortCount, 1);
          assert.isFalse(fixture.disposed);
        }),
      );

      assert.strictEqual(fixture.abortCount, 2);
      assert.isTrue(fixture.disposed);
      assert.strictEqual(fixture.listenerCount, 0);
    }),
  );
});

describe("PiSdkService", () => {
  it.effect("opens a real Pi session inside an Effect scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const pi = PiSdkService.make(fixture.agentDir);

        const session = yield* pi.createSession(fixture.cwd);

        assert.strictEqual(session.messages.length, 0);
        assert.strictEqual(session.isIdle, true);
        assert.include(session.nativePath ?? "", fixture.agentDir);
      }),
    ),
  );

  it.effect("inspects an isolated workspace and reports typed open failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const pi = PiSdkService.make(fixture.agentDir);

        const workspace = yield* pi.inspectWorkspace(fixture.cwd);
        assert.deepEqual(workspace.sessions, []);
        assert.deepEqual(workspace.commands, []);
        assert.isTrue(workspace.trusted);

        const error = yield* pi
          .resumeSession(fixture.cwd, fixture.corruptSession)
          .pipe(Effect.scoped, Effect.flip);
        assert.instanceOf(error, PiSdkError);
        assert.strictEqual(error.operation, "session.resume");
      }),
    ),
  );
});

const isolatedPiWorkspace = Effect.acquireRelease(
  Effect.tryPromise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pidex-pi-sdk-"));
    const cwd = path.join(root, "workspace");
    const corruptSession = path.join(cwd, "corrupt.jsonl");
    await mkdir(cwd);
    await writeFile(corruptSession, "not-json\n");
    return { root, cwd, corruptSession, agentDir: path.join(root, "agent") };
  }),
  (fixture) => Effect.promise(() => rm(fixture.root, { recursive: true, force: true })),
);

function waitForSubscription(fixture: SessionFixture): Effect.Effect<void> {
  return fixture.listenerCount === 1
    ? Effect.void
    : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => waitForSubscription(fixture))));
}

class SessionFixture implements AdapterSession {
  readonly sessionManager = SessionManager.inMemory("/fixture");
  readonly settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "minimal" });
  readonly nativeId = this.sessionManager.getSessionId();
  readonly nativePath = undefined;
  readonly messages: AdapterSession["messages"] = [
    {
      type: "user",
      id: this.sessionManager.appendMessage({
        role: "user",
        content: "fixture prompt",
        timestamp: 1,
      }),
      text: "fixture prompt",
      complete: true,
      timestamp: new Date(1).toISOString(),
    },
  ];
  readonly model = undefined;
  readonly thinkingLevel = this.settingsManager.getDefaultThinkingLevel() ?? "off";
  readonly sessionName = undefined;
  readonly contextUsage = undefined;
  readonly isIdle = true;
  promptFailure: Error | undefined;
  abortCount = 0;
  disposed = false;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private pendingPrompt: (() => void) | undefined;

  get listenerCount() {
    return this.listeners.size;
  }

  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AdapterEvent) {
    for (const listener of this.listeners) listener(event);
  }

  prompt() {
    if (this.promptFailure) return Promise.reject(this.promptFailure);
    return new Promise<void>((resolve) => {
      this.pendingPrompt = resolve;
    });
  }

  async steer() {}
  async followUp() {}

  async abort() {
    this.abortCount += 1;
    this.pendingPrompt?.();
    this.pendingPrompt = undefined;
  }

  clearQueue() {}
  async configure() {}
  rename() {}
  async compact() {}

  getStats() {
    return { messages: 0, toolCalls: 0, tokens: 0, cost: 0 };
  }

  respondToDialog() {}

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
