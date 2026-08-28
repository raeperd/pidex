import { describe, expect, it } from "vitest";
import {
  actionOutcomeSchema,
  configRequestSchema,
  contextUsageSchema,
  healthSchema,
  messageRequestSchema,
  pidexApiContract,
  PROTOCOL_VERSION,
  renameRequestSchema,
  safeParse,
  serverEventSchema,
  sessionSummarySchema,
} from "../src/index.js";

const actionRequest = {
  chatId: "chat_123",
  clientId: "client_123",
  actionId: "action_123",
  expectedRevision: 0,
};

describe("Pidex API schemas", () => {
  it("removes unknown object entries", () => {
    const result = safeParse(healthSchema, {
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
    expect(
      safeParse(messageRequestSchema, { ...actionRequest, text: "   ", delivery: "normal" }),
    ).toMatchObject({ success: false });
    expect(safeParse(configRequestSchema, actionRequest)).toMatchObject({ success: false });

    const renamed = safeParse(renameRequestSchema, { ...actionRequest, name: "  Pidex  " });
    expect(renamed.success).toBe(true);
    if (renamed.success) expect(renamed.output.name).toBe("Pidex");
  });

  it("preserves finite number and safe integer validation", () => {
    expect(
      safeParse(actionOutcomeSchema, {
        accepted: true,
        actionId: "action_123",
        runId: "run_1234",
        status: "accepted",
        revision: Number.MAX_SAFE_INTEGER + 1,
        replayed: false,
      }),
    ).toMatchObject({ success: false });
    expect(
      safeParse(contextUsageSchema, {
        tokens: null,
        contextWindow: 1,
        percent: Number.POSITIVE_INFINITY,
        totalProcessedTokens: 0,
        compactsAutomatically: true,
      }),
    ).toMatchObject({ success: false });
  });

  it("validates tagged server events", () => {
    expect(
      safeParse(serverEventSchema, {
        type: "text_delta",
        eventId: 1,
        chatId: "chat_123",
        itemId: "item",
        delta: "hello",
        channel: "text",
      }),
    ).toMatchObject({ success: true });
    expect(
      safeParse(serverEventSchema, {
        type: "message",
        eventId: 2,
        chatId: "chat_123",
        item: {
          type: "skill",
          id: "skill_123",
          name: "diagnose",
          content: "Diagnose the failure before proposing a fix.",
          timestamp: "2026-08-05T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("parses a session summary status as an optional coarse tri-state", () => {
    const summary = {
      id: "session_123",
      firstMessage: "Fix the flaky test",
      createdAt: "2026-08-05T00:00:00.000Z",
      modifiedAt: "2026-08-05T00:00:00.000Z",
      messageCount: 1,
    };
    for (const status of ["running", "error", "idle"] as const)
      expect(safeParse(sessionSummarySchema, { ...summary, status })).toMatchObject({
        success: true,
        output: { status },
      });
    expect(safeParse(sessionSummarySchema, { ...summary, status: "stopping" })).toMatchObject({
      success: false,
    });
    const missingStatus = safeParse(sessionSummarySchema, summary);
    expect(missingStatus.success).toBe(true);
    if (missingStatus.success) expect(missingStatus.output.status).toBeUndefined();
  });
});
