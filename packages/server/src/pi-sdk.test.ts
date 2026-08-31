import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Queue, Stream } from "effect";
import {
  acquireAdapterSession,
  type AdapterEvent,
  type EffectAdapterSession,
  makePiSdk,
  makePiSdkService,
} from "./pi-sdk.js";

describe("Effect Pi adapter", () => {
  it.effect("preserves raw Pi events for downstream consumers", () =>
    Effect.gen(function* () {
      const fixture = makeSessionFixture();
      const session = yield* acquireAdapterSession(Effect.succeed(fixture));
      const collected = yield* session.events.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* waitForSubscription(fixture);
      fixture.emit({ type: "pi", event: { type: "agent_start" } });

      assert.deepEqual(yield* Fiber.join(collected), [
        { type: "pi", event: { type: "agent_start" } },
      ]);
    }),
  );

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
        fixture.failPrompt(new Error("prompt failed"));
        const session = yield* acquireAdapterSession(Effect.succeed(fixture));

        assert.strictEqual(session.state.thinkingLevel, "minimal");
        assert.strictEqual(session.state.messages[0]?.id, "fixture-message");
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
  it.effect("discovers Pi extension, prompt template, and skill commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        yield* Effect.tryPromise(async () => {
          await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
          await mkdir(path.join(fixture.agentDir, "prompts"), { recursive: true });
          await mkdir(path.join(fixture.agentDir, "skills", "diagnose"), { recursive: true });
          await writeFile(
            path.join(fixture.agentDir, "extensions", "review.ts"),
            `export default function (pi) {
  pi.registerCommand("review", {
    description: "Review the current changes",
    handler: async () => {},
  });
}
`,
          );
          await writeFile(
            path.join(fixture.agentDir, "prompts", "release.md"),
            `---
description: Prepare a release
---
Prepare the current branch for release.
`,
          );
          await writeFile(
            path.join(fixture.agentDir, "prompts", "review.md"),
            `---
description: Run the review prompt
---
Review the current changes with the prompt template.
`,
          );
          await writeFile(
            path.join(fixture.agentDir, "skills", "diagnose", "SKILL.md"),
            `---
name: diagnose
description: Diagnose a failing command
---
Diagnose the failure before proposing a fix.
`,
          );
        });
        const pi = piFor(fixture);

        const workspace = yield* pi.inspectWorkspace(fixture.cwd);

        assert.deepEqual(
          workspace.commands.filter((command) =>
            ["review", "release", "skill:diagnose"].includes(command.name),
          ),
          [
            { name: "review", description: "Review the current changes" },
            { name: "release", description: "Prepare a release" },
            { name: "skill:diagnose", description: "Diagnose a failing command" },
          ],
        );
      }),
    ),
  );

  it.effect("settles a prompt handled immediately by an extension command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        yield* Effect.tryPromise(async () => {
          await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
          await writeFile(
            path.join(fixture.agentDir, "extensions", "finish.ts"),
            `export default function (pi) {
  pi.registerCommand("finish", {
    handler: async (_args, ctx) => ctx.ui.notify("command finished"),
  });
}
`,
          );
        });
        const sdk = makePiSdk({
          agentDir: fixture.agentDir,
          sessionDir: path.join(fixture.agentDir, "sessions"),
        });
        const commandSession = yield* Effect.acquireRelease(
          Effect.tryPromise(() => sdk.createSession(fixture.cwd)),
          (session) => Effect.sync(() => session.dispose()),
        );
        const events: AdapterEvent[] = [];
        const unsubscribe = commandSession.lifecycle.subscribe((event) => events.push(event));

        yield* commandSession.prompt("/finish");
        unsubscribe();

        assert.deepEqual(events, [
          { type: "notice", level: "info", text: "command finished" },
          { type: "settled" },
        ]);
      }),
    ),
  );

  it.effect("opens a real Pi session inside an Effect scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const pi = piFor(fixture);

        const session = yield* pi.createSession(fixture.cwd);

        assert.strictEqual(session.state.messages.length, 0);
        assert.strictEqual(session.state.isIdle, true);
        assert.include(session.state.nativePath ?? "", fixture.agentDir);
      }),
    ),
  );

  it.effect("restores native Pi skill invocations as skill activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* isolatedPiWorkspace;
        const sessionDir = path.join(fixture.agentDir, "sessions");
        const manager = SessionManager.create(fixture.cwd, sessionDir);
        const skillPath = path.join(fixture.agentDir, "skills", "diagnose", "SKILL.md");
        const userId = manager.appendMessage({
          role: "user",
          content: `<skill name="diagnose" location="${skillPath}">
References are relative to ${path.dirname(skillPath)}.

Diagnose the failure before proposing a fix.
</skill>

Find the root cause`,
          timestamp: 1,
        });
        const assistantId = manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "The root cause is isolated." }],
          ...assistantMessageMeta("stop"),
          timestamp: 2,
        });
        const nativePath = manager.getSessionFile();
        if (!nativePath) return yield* Effect.die("Persisted session has no file path");
        const pi = piFor(fixture);

        const session = yield* pi.resumeSession(fixture.cwd, nativePath);

        assert.deepEqual(
          session.state.messages.map((item) => ({ ...item, timestamp: "timestamp" })),
          [
            {
              type: "skill",
              id: `${userId}-skill`,
              name: "diagnose",
              content: `References are relative to ${path.dirname(skillPath)}.

Diagnose the failure before proposing a fix.`,
              timestamp: "timestamp",
            },
            {
              type: "user",
              id: userId,
              text: "Find the root cause",
              complete: true,
              timestamp: "timestamp",
            },
            {
              type: "assistant",
              id: assistantId,
              text: "The root cause is isolated.",
              complete: true,
              timestamp: "timestamp",
            },
          ],
        );
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
          ...assistantMessageMeta("toolUse"),
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
          ...assistantMessageMeta("stop", 20, 10),
          timestamp: 5,
        });
        const nativePath = manager.getSessionFile();
        if (!nativePath) return yield* Effect.die("Persisted session has no file path");

        const pi = piFor(fixture);
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
          ...assistantMessageMeta("toolUse"),
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

        const pi = piFor(fixture);
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
        const pi = piFor(fixture);

        const workspace = yield* pi.inspectWorkspace(fixture.cwd);
        assert.deepEqual(workspace.sessions, []);
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

const piFor = (fixture: { agentDir: string }) =>
  makePiSdkService(
    makePiSdk({ agentDir: fixture.agentDir, sessionDir: path.join(fixture.agentDir, "sessions") }),
  );

function assistantMessageMeta(stopReason: "stop" | "toolUse", input = 10, output = 5) {
  return {
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
  } as const;
}

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

interface SessionFixture extends EffectAdapterSession {
  failPrompt(error: Error): void;
  readonly abortCount: number;
  readonly disposed: boolean;
  readonly listenerCount: number;
  emit(event: AdapterEvent): void;
  readonly lifecycle: {
    subscribe(listener: (event: AdapterEvent) => void): () => void;
    abort(): Promise<void>;
    dispose(): void;
  };
}

function makeSessionFixture(): SessionFixture {
  let promptFailure: Error | undefined;
  let pendingPrompt: (() => void) | undefined;
  let abortCount = 0;
  let disposed = false;

  const listeners = new Set<(event: AdapterEvent) => void>();
  const lifecycle = {
    subscribe: (listener: (event: AdapterEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort: async () => {
      abortCount += 1;
      pendingPrompt?.();
      pendingPrompt = undefined;
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
  const events = Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        lifecycle.subscribe((event) => {
          Queue.offerUnsafe(queue, event);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
  return {
    state: {
      nativeId: "fixture-session",
      nativePath: undefined,
      messages: [
        {
          type: "user",
          id: "fixture-message",
          text: "fixture prompt",
          complete: true,
          timestamp: new Date(1).toISOString(),
        },
      ],
      toolOutputs: new Map(),
      model: undefined,
      thinkingLevel: "minimal",
      sessionName: undefined,
      contextUsage: undefined,
      isIdle: true,
    },
    events,
    lifecycle,
    failPrompt: (error) => {
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
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    prompt: () => {
      if (promptFailure)
        return Effect.fail({
          _tag: "AdapterSessionError" as const,
          operation: "session.prompt",
          message: promptFailure.message,
          cause: promptFailure,
        });
      return Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            pendingPrompt = resolve;
          }),
      ).pipe(Effect.onInterrupt(() => Effect.promise(() => lifecycle.abort())));
    },
  } as SessionFixture;
}
