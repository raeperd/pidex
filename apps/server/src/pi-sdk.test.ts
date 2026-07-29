import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Stream } from "effect";
import { acquireAdapterSession, type AdapterEvent, type AdapterSession } from "./adapter.js";
import { makePiSdk, makePiSdkService } from "./pi-sdk.js";

describe("Effect Pi adapter", () => {
  it.effect("streams events in order and unsubscribes when the stream ends", () =>
    Effect.gen(function* () {
      const fixture = makeSessionFixture();

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
        const fixture = makeSessionFixture();
        fixture.promptFailure = new Error("prompt failed");
        const session = yield* acquireAdapterSession(Effect.succeed(fixture));

        assert.strictEqual(session.state.thinkingLevel, "minimal");
        assert.strictEqual(session.state.messages[0]?.id, fixture.sessionManager.getLeafId());
        const error = yield* session.prompt("hello").pipe(Effect.flip);

        assert.propertyVal(error, "_tag", "AdapterSessionError");
        assert.strictEqual(error.operation, "session.prompt");
        assert.strictEqual(error.message, "prompt failed");
      }),
    ),
  );

  it.effect("aborts interrupted prompts and disposes the session when its scope closes", () =>
    Effect.gen(function* () {
      const fixture = makeSessionFixture();

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

describe("Pi SDK Effect service", () => {
  it.effect("opens a real Pi session inside an Effect scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const pi = makePiSdkService(
          makePiSdk({
            agentDir: fixture.agentDir,
            sessionDir: path.join(fixture.agentDir, "sessions"),
          }),
        );

        const session = yield* pi.createSession(fixture.cwd);

        assert.strictEqual(session.state.messages.length, 0);
        assert.strictEqual(session.state.isIdle, true);
        assert.include(session.state.nativePath ?? "", fixture.agentDir);
      }),
    ),
  );

  it.effect("restores tool calls and results from a persisted Pi session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const sessionDir = path.join(fixture.agentDir, "sessions");
        const manager = SessionManager.create(fixture.cwd, sessionDir);
        const userId = manager.appendMessage({
          role: "user",
          content: "Summarize this repository",
          timestamp: 1,
        });
        const assistantId = manager.appendMessage({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Planning repository inspection" },
            { type: "thinking", thinking: "Planning key file reading" },
            {
              type: "toolCall",
              id: "tool-readme",
              name: "bash",
              arguments: { command: "ls -la" },
            },
            {
              type: "toolCall",
              id: "tool-missing",
              name: "read",
              arguments: { path: "missing.txt" },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        });
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "tool-readme",
          toolName: "bash",
          content: [{ type: "text", text: "README.md\npackage.json\n" }],
          isError: false,
          timestamp: 3,
        });
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "tool-missing",
          toolName: "read",
          content: [{ type: "text", text: "File not found" }],
          isError: true,
          timestamp: 4,
        });
        const finalId = manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "This is a desktop coding client." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 5,
        });
        const nativePath = manager.getSessionFile();
        if (!nativePath) return yield* Effect.die("Persisted session has no file path");

        const pi = makePiSdkService(makePiSdk({ agentDir: fixture.agentDir, sessionDir }));
        const session = yield* pi.resumeSession(fixture.cwd, nativePath);

        assert.deepEqual(
          session.state.messages.map((item) =>
            item.type === "tool" ? item : { ...item, timestamp: "timestamp" },
          ),
          [
            {
              type: "user",
              id: userId,
              text: "Summarize this repository",
              complete: true,
              timestamp: "timestamp",
            },
            {
              type: "assistant",
              id: assistantId,
              text: "",
              thinking: "Planning repository inspection\n\nPlanning key file reading",
              complete: true,
              timestamp: "timestamp",
            },
            {
              type: "tool",
              id: "tool-readme",
              name: "bash",
              argumentSummary: '{\n  "command": "ls -la"\n}',
              state: "success",
              preview: "README.md\npackage.json\n",
              truncated: false,
            },
            {
              type: "tool",
              id: "tool-missing",
              name: "read",
              argumentSummary: '{\n  "path": "missing.txt"\n}',
              state: "error",
              preview: "File not found",
              truncated: false,
            },
            {
              type: "assistant",
              id: finalId,
              text: "This is a desktop coding client.",
              complete: true,
              timestamp: "timestamp",
            },
          ],
        );
      }),
    ),
  );

  it.effect("restores full oversized tool output and finalizes orphaned calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const sessionDir = path.join(fixture.agentDir, "sessions");
        const manager = SessionManager.create(fixture.cwd, sessionDir);
        const oversizedOutput = "x".repeat(12_100);
        manager.appendMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-large",
              name: "read",
              arguments: { path: "large.log" },
            },
            {
              type: "toolCall",
              id: "tool-orphaned",
              name: "bash",
              arguments: { command: "sleep 30" },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        });
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "tool-large",
          toolName: "read",
          content: [{ type: "text", text: oversizedOutput }],
          isError: false,
          timestamp: 2,
        });
        const nativePath = manager.getSessionFile();
        if (!nativePath) return yield* Effect.die("Persisted session has no file path");

        const pi = makePiSdkService(makePiSdk({ agentDir: fixture.agentDir, sessionDir }));
        const session = yield* pi.resumeSession(fixture.cwd, nativePath);
        const large = session.state.messages.find((item) => item.id === "tool-large");
        const orphaned = session.state.messages.find((item) => item.id === "tool-orphaned");

        assert.strictEqual(large?.type, "tool");
        if (large?.type !== "tool") return yield* Effect.die("Large tool call was not restored");
        assert.strictEqual(large.state, "success");
        assert.isTrue(large.truncated);
        assert.exists(large.resourceId);
        assert.strictEqual(large.outputSize, oversizedOutput.length);
        assert.strictEqual(session.state.toolOutputs.get(large.resourceId)?.text, oversizedOutput);
        assert.deepInclude(orphaned, {
          type: "tool",
          id: "tool-orphaned",
          state: "error",
          preview: "Tool execution was interrupted before a result was recorded.",
        });
      }),
    ),
  );

  it.effect("inspects an isolated workspace and reports typed open failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const pi = makePiSdkService(
          makePiSdk({
            agentDir: fixture.agentDir,
            sessionDir: path.join(fixture.agentDir, "sessions"),
          }),
        );

        const workspace = yield* pi.inspectWorkspace(fixture.cwd);
        assert.deepEqual(workspace.sessions, []);
        assert.deepEqual(workspace.commands, []);
        assert.isTrue(workspace.trusted);

        const error = yield* pi
          .resumeSession(fixture.cwd, fixture.corruptSession)
          .pipe(Effect.scoped, Effect.flip);
        assert.propertyVal(error, "_tag", "PiSdkError");
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

interface SessionFixture extends AdapterSession {
  readonly sessionManager: SessionManager;
  promptFailure: Error | undefined;
  readonly abortCount: number;
  readonly disposed: boolean;
  readonly listenerCount: number;
  emit(event: AdapterEvent): void;
}

function makeSessionFixture(): SessionFixture {
  const sessionManager = SessionManager.inMemory("/fixture");
  const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "minimal" });
  const listeners = new Set<(event: AdapterEvent) => void>();
  let promptFailure: Error | undefined;
  let pendingPrompt: (() => void) | undefined;
  let abortCount = 0;
  let disposed = false;

  const messages: AdapterSession["messages"] = [
    {
      type: "user",
      id: sessionManager.appendMessage({
        role: "user",
        content: "fixture prompt",
        timestamp: 1,
      }),
      text: "fixture prompt",
      complete: true,
      timestamp: new Date(1).toISOString(),
    },
  ];

  return {
    sessionManager,
    nativeId: sessionManager.getSessionId(),
    nativePath: undefined,
    messages,
    toolOutputs: new Map(),
    model: undefined,
    thinkingLevel: settingsManager.getDefaultThinkingLevel() ?? "off",
    sessionName: undefined,
    contextUsage: undefined,
    isIdle: true,
    get promptFailure() {
      return promptFailure;
    },
    set promptFailure(error) {
      promptFailure = error;
    },
    get abortCount() {
      return abortCount;
    },
    get disposed() {
      return disposed;
    },
    get listenerCount() {
      return listeners.size;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    prompt: () => {
      if (promptFailure) return Promise.reject(promptFailure);
      return new Promise<void>((resolve) => {
        pendingPrompt = resolve;
      });
    },
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {
      abortCount += 1;
      pendingPrompt?.();
      pendingPrompt = undefined;
    },
    clearQueue: () => {},
    configure: async () => {},
    rename: () => {},
    compact: async () => {},
    getStats: () => ({ messages: 0, toolCalls: 0, tokens: 0, cost: 0 }),
    respondToDialog: () => {},
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}
