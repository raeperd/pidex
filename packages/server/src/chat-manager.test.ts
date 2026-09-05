import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerEvent, TranscriptItem } from "@pidex/api";
import { Effect, Queue, Stream } from "effect";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { makeChatManager } from "./chat-manager.js";
import { Metadata, makeMetadataLayer } from "./metadata.js";
import type { AdapterEvent, EffectAdapterSession } from "./pi-sdk.js";

describe("normalized live transcript", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "pidex-live-transcript-"));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  layer(makeMetadataLayer(stateDir))((it) => {
    it.effect("keeps message deltas, skill items, and replay consistent with snapshots", () =>
      Effect.gen(function* () {
        const fixture = yield* setup();
        const { manager, chat, emit } = fixture;
        const events = yield* manager.events(chat);
        yield* Effect.promise(() => events.next());
        yield* emit({ type: "message_start", message: assistant([]) });
        yield* emit({
          type: "message_update",
          message: assistant([{ type: "text", text: "Hello" }]),
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Hello",
            partial: assistant([]),
          },
        });
        yield* emit({
          type: "message_update",
          message: assistant([]),
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 1,
            delta: "Consider",
            partial: assistant([]),
          },
        });
        const partial = yield* manager.snapshot(chat);
        expect(partial.items).toMatchObject([
          { text: "Hello", thinking: "Consider", complete: false },
        ]);
        yield* emit({
          type: "message_end",
          message: assistant([
            { type: "text", text: "Hello" },
            { type: "thinking", thinking: "Consider" },
          ]),
        });
        const user = {
          role: "user" as const,
          timestamp: 2,
          content:
            '<skill name="review" location="/tmp/SKILL.md">\nRead carefully.\n</skill>\n\nReview this change.',
        };
        yield* emit({ type: "message_start", message: user });
        yield* emit({ type: "message_end", message: user });
        const snapshot = yield* manager.snapshot(chat);
        expect(snapshot.items).toMatchObject([
          { id: "assistant-1", text: "Hello", thinking: "Consider", complete: true },
          { type: "skill", id: "user-2-skill", name: "review", content: "Read carefully." },
          { type: "user", id: "user-2", text: "Review this change.", complete: true },
        ]);
        const live: ServerEvent[] = [];
        for (let index = 0; index < 8; index++) {
          const next = yield* Effect.promise(() => events.next());
          if (!next.done) live.push(next.value);
        }
        expect(live[0]?.event).toMatchObject({
          type: "transcript_item",
          item: { text: "", complete: false },
        });
        expect(live[1]?.event).toEqual({
          type: "text_delta",
          itemId: "assistant-1",
          delta: "Hello",
          channel: "text",
        });
        expect(live[2]?.event).toEqual({
          type: "text_delta",
          itemId: "assistant-1",
          delta: "Consider",
          channel: "thinking",
        });
        const replay = yield* manager.events(chat, live[0]?.eventId);
        for (const event of live.slice(1)) {
          expect((yield* Effect.promise(() => replay.next())).value).toEqual(event);
        }
        yield* Effect.promise(() => replay.return());
        yield* Effect.promise(() => events.return());
      }),
    );

    it.effect("publishes bounded tool items with complete-output paging metadata immediately", () =>
      Effect.gen(function* () {
        const { manager, chat, emit } = yield* setup();
        const events = yield* manager.events(chat);
        yield* Effect.promise(() => events.next());
        const tool = {
          toolCallId: "tool_live_123",
          toolName: "bash",
          args: { command: "large-output" },
        };
        yield* emit({ type: "tool_execution_start", ...tool });
        const output = {
          content: [{ type: "text" as const, text: "a".repeat(30_000) }],
          details: {},
        };
        yield* emit({
          type: "tool_execution_update",
          ...tool,
          partialResult: { content: [{ type: "text", text: "partial".repeat(3000) }], details: {} },
        });
        yield* emit({ type: "tool_execution_end", ...tool, result: output, isError: true });
        const live: TranscriptItem[] = [];
        for (let index = 0; index < 3; index++) {
          const next = yield* Effect.promise(() => events.next());
          if (!next.done && next.value.event.type === "transcript_item")
            live.push(next.value.event.item);
        }
        const item = live[2];
        if (item?.type !== "tool" || !item.resourceId)
          return yield* Effect.die("Missing live tool resource");
        expect(live[1]).toMatchObject({ state: "running", truncated: true });
        expect(live[1]).not.toHaveProperty("resourceId");
        expect(live[1]).not.toHaveProperty("outputSize");
        expect(item).toMatchObject({
          state: "error",
          truncated: true,
          argumentSummary: expect.stringContaining("large-output"),
        });
        expect(item.preview.length).toBeLessThanOrEqual(16_384);
        expect((yield* manager.snapshot(chat)).items).toEqual([item]);
        let completeOutput = "";
        let offset = 0;
        do {
          const chunk = yield* manager.toolOutput(chat, item.resourceId, offset, 16_384);
          completeOutput += chunk.text;
          offset = chunk.nextOffset;
          if (chunk.complete) break;
        } while (offset < (item.outputSize ?? 0));
        expect(completeOutput).toBe(output.content[0]?.text);
        expect(item.preview).not.toContain("content");
        expect(completeOutput.length).toBe(item.outputSize);
        yield* Effect.promise(() => events.return());
      }),
    );

    it.effect(
      "normalizes recovery, queues, configuration and dialogs while retaining snapshot state",
      () =>
        Effect.gen(function* () {
          const { manager, chat, emit, queue, session } = yield* setup();
          const events = yield* manager.events(chat);
          yield* Effect.promise(() => events.next());
          yield* emit({ type: "agent_start" });
          yield* emit({ type: "queue_update", steering: ["Adjust"], followUp: ["Then verify"] });
          yield* emit({ type: "compaction_start", reason: "overflow" });
          expect((yield* manager.snapshot(chat)).runStatus).toBe("compacting");
          yield* emit({
            type: "compaction_end",
            reason: "overflow",
            result: undefined,
            aborted: false,
            willRetry: true,
          });
          expect((yield* manager.snapshot(chat)).runStatus).toBe("running");
          yield* emit({
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 10,
            errorMessage: "Unavailable",
          });
          yield* emit({ type: "auto_retry_end", attempt: 2, success: false, finalError: "Failed" });
          session.state.thinkingLevel = "max";
          yield* emit({ type: "thinking_level_changed", level: "max" });
          session.state.sessionName = "Renamed";
          yield* emit({ type: "session_info_changed", name: "Renamed" });
          const dialog = { id: "dialog_live_123", kind: "confirm" as const, title: "Continue?" };
          yield* Queue.offer(queue, { type: "dialog", dialog });
          yield* Queue.offer(queue, { type: "settled" });
          const live: ServerEvent[] = [];
          while (true) {
            const next = yield* Effect.promise(() => events.next());
            if (next.done) break;
            live.push(next.value);
            if (next.value.event.type === "run_status" && next.value.event.status === "idle") break;
          }
          expect(live.map((event) => event.event)).toEqual(
            expect.arrayContaining([
              { type: "queue", steering: ["Adjust"], followUp: ["Then verify"] },
              { type: "session", model: "test/model", thinkingLevel: "max" },
              { type: "session", name: "Renamed", model: "test/model", thinkingLevel: "max" },
              { type: "extension_dialog", dialog },
            ]),
          );
          const snapshot = yield* manager.snapshot(chat);
          expect(snapshot).toMatchObject({
            runStatus: "idle",
            steeringQueue: ["Adjust"],
            followUpQueue: ["Then verify"],
            extensionDialog: dialog,
            thinkingLevel: "max",
            sessionName: "Renamed",
          });
          expect(snapshot.items).toMatchObject([
            { type: "notice", text: "Context compaction started." },
            { type: "notice", text: "Context compaction completed." },
            { type: "notice", text: "Retrying request (attempt 1/2): Unavailable" },
            { type: "notice", text: "Failed" },
          ]);
          for (const item of snapshot.items)
            expect(
              live.some(
                (event) =>
                  event.event.type === "transcript_item" && event.event.item.id === item.id,
              ),
            ).toBe(true);
          yield* Effect.promise(() => events.return());
        }),
    );
  });
});

function setup() {
  return Effect.gen(function* () {
    const metadata = yield* Metadata;
    const queue = yield* Queue.unbounded<AdapterEvent>();
    const configuration: {
      thinkingLevel: EffectAdapterSession["state"]["thinkingLevel"];
      sessionName: string | undefined;
    } = { thinkingLevel: "high", sessionName: undefined };
    const session = {
      state: {
        nativeId: crypto.randomUUID(),
        nativePath: undefined,
        messages: [],
        toolOutputs: new Map(),
        model: "test/model",
        ...configuration,
        contextUsage: undefined,
        isIdle: true,
      },
      events: Stream.fromQueue(queue),
      prompt: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      abort: () => Effect.void,
      clearQueue: () => Effect.void,
      configure: () => Effect.void,
      rename: () => Effect.void,
      compact: () => Effect.void,
      respondToDialog: () => Effect.void,
    } satisfies EffectAdapterSession;
    const manager = makeChatManager(
      {
        createSession: () => Effect.succeed(session),
        resumeSession: () => Effect.succeed(session),
        inspectWorkspace: () =>
          Effect.succeed({
            models: [],
            sessions: [],
            trusted: true,
            protectedResourcesSkipped: false,
            resourceDiagnostics: [],
            commands: [],
          }),
        setWorkspaceTrust: () => Effect.void,
        inheritWorkspaceTrust: () => Effect.void,
        clearWorkspaceTrust: () => Effect.void,
      },
      metadata,
    );
    yield* Effect.addFinalizer(() => manager.shutdown());
    const workspacePath = `/tmp/pidex-${session.state.nativeId}`;
    const workspaceId = yield* metadata.rememberWorkspace(workspacePath);
    yield* manager.openWorkspace(workspaceId, workspacePath);
    const chat = yield* manager.create(workspaceId);
    return {
      manager,
      chat,
      queue,
      session,
      emit: (event: AgentSessionEvent) =>
        Queue.offer(queue, { type: "pi", event }).pipe(Effect.andThen(Effect.yieldNow)),
    };
  });
}

function assistant(
  content: Extract<AgentSessionEvent, { type: "message_update" }>["message"]["content"],
): Extract<AgentSessionEvent, { type: "message_update" }>["message"] {
  return {
    role: "assistant",
    content,
    timestamp: 1,
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
