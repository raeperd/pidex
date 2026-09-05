import { describe, expect, it } from "vitest";
import { pidexApiContract, PROTOCOL_VERSION, safeParse } from "../src/index.js";

function lastSchema<T>(schemas: readonly T[] | undefined): T {
  const schema = schemas?.at(-1);
  if (!schema) throw new Error("Expected a contract schema");
  return schema;
}

const actionRequest = {
  chatId: "chat_123",
  clientId: "client_123",
  actionId: "action_123",
  expectedRevision: 0,
};

describe("Pidex API schemas", () => {
  it("removes unknown object entries", () => {
    const result = safeParse(lastSchema(pidexApiContract.system.health["~orpc"].outputSchemas), {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      ignored: true,
    });

    expect(result.success).toBe(true);
    if (result.success)
      expect(result.output).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });

  it("applies route input defaults through Standard Schema", async () => {
    const schema = pidexApiContract.chats.toolOutput["~orpc"].inputSchemas?.at(-1);
    expect(schema).toBeDefined();
    if (!schema) return;

    const result = await schema["~standard"].validate({
      chatId: "chat_123",
      resourceId: "resource_123",
    });

    expect(result).toMatchObject({
      value: {
        chatId: "chat_123",
        resourceId: "resource_123",
        offset: 0,
        limit: 16_384,
      },
    });

    const configureSchema = pidexApiContract.chats.configure["~orpc"].inputSchemas?.at(-1);
    expect(configureSchema).toBeDefined();
    if (!configureSchema) return;

    const configured = await configureSchema["~standard"].validate({
      ...actionRequest,
      chatId: "chat_123",
      model: "provider/model",
    });
    expect(configured).toMatchObject({
      value: { ...actionRequest, chatId: "chat_123", model: "provider/model" },
    });
  });

  it("preserves custom validation and trimming behavior", () => {
    const messageSchema = lastSchema(pidexApiContract.chats.sendMessage["~orpc"].inputSchemas);
    const configSchema = lastSchema(pidexApiContract.chats.configure["~orpc"].inputSchemas);
    const renameSchema = lastSchema(pidexApiContract.chats.rename["~orpc"].inputSchemas);
    expect(
      safeParse(messageSchema, { ...actionRequest, text: "   ", delivery: "normal" }),
    ).toMatchObject({ success: false });
    expect(safeParse(configSchema, actionRequest)).toMatchObject({ success: false });

    const renamed = safeParse(renameSchema, { ...actionRequest, name: "  Pidex  " });
    expect(renamed.success).toBe(true);
    if (renamed.success) expect(renamed.output.name).toBe("Pidex");
  });

  it("preserves finite number and safe integer validation", () => {
    const actionSchema = lastSchema(pidexApiContract.chats.sendMessage["~orpc"].outputSchemas);
    const snapshotSchema = lastSchema(pidexApiContract.chats.get["~orpc"].outputSchemas);
    expect(
      safeParse(actionSchema, {
        accepted: true,
        actionId: "action_123",
        runId: "run_1234",
        status: "accepted",
        revision: Number.MAX_SAFE_INTEGER + 1,
        replayed: false,
      }),
    ).toMatchObject({ success: false });
    expect(
      safeParse(snapshotSchema, {
        chatId: "chat_123",
        workspaceId: "workspace_123",
        taskId: "task_123",
        runStatus: "idle",
        thinkingLevel: "high",
        items: [],
        transcriptStart: 0,
        transcriptTotal: 0,
        steeringQueue: [],
        followUpQueue: [],
        contextUsage: {
          tokens: null,
          contextWindow: 1,
          percent: Number.POSITIVE_INFINITY,
          totalProcessedTokens: 0,
          compactsAutomatically: true,
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("preserves raw Pi event payloads in the live contract", async () => {
    const events = (async function* () {
      yield {
        source: "pi",
        eventId: 1,
        chatId: "chat_123",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        },
      };
    })();
    const schema = lastSchema(pidexApiContract.live.events["~orpc"].outputSchemas);
    const result = await schema["~standard"].validate(events);
    expect(result).toHaveProperty("value");
    if (!("value" in result)) return;
    await expect(result.value.next()).resolves.toMatchObject({
      value: {
        source: "pi",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        },
      },
      done: false,
    });
  });

  it("parses a session summary status as an optional coarse tri-state", () => {
    const schema = lastSchema(pidexApiContract.workspaces.sessions["~orpc"].outputSchemas);
    const summary = {
      id: "session_123",
      firstMessage: "Fix the flaky test",
      createdAt: "2026-08-05T00:00:00.000Z",
      modifiedAt: "2026-08-05T00:00:00.000Z",
      messageCount: 1,
    };
    for (const status of ["running", "error", "idle"] as const) {
      const result = safeParse(schema, { sessions: [{ ...summary, status }] });
      expect(result).toMatchObject({
        success: true,
        output: { sessions: [{ status }] },
      });
    }
    expect(safeParse(schema, { sessions: [{ ...summary, status: "stopping" }] })).toMatchObject({
      success: false,
    });
    const missingStatus = safeParse(schema, { sessions: [summary] });
    expect(missingStatus.success).toBe(true);
    if (missingStatus.success) expect(missingStatus.output.status).toBeUndefined();
  });
});
