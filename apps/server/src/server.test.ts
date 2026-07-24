import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ActionOutcome, ChatSnapshot, ToolItem, ToolOutputChunk } from "@pidex/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

describe("HTTP control surface", () => {
  let app: Awaited<ReturnType<typeof createPidexServer>>;
  let origin: string;
  let csrf: string;
  const clientId = "testclient1234";

  beforeEach(async () => {
    process.env.PIDEX_ADAPTER = "fake";
    process.env.PIDEX_FAKE_SEED_SESSIONS = "0";
    process.env.PIDEX_PROJECT_ROOTS = process.cwd();
    process.env.WORKSPACE_ROOTS = process.cwd();
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-state-"));
    app = await createPidexServer();
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    origin = `http://127.0.0.1:${address.port}`;
    csrf = ((await (await fetch(`${origin}/api/bootstrap`)).json()) as { csrfToken: string })
      .csrfToken;
  });

  afterEach(async () => {
    await app.close();
  });

  const mutate = (route: string, body: unknown) =>
    fetch(`${origin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf },
      body: JSON.stringify(body),
    });

  it("discovers name-first project candidates inside allowed roots", async () => {
    const bootstrap = (await (await fetch(`${origin}/api/bootstrap`)).json()) as {
      projectCandidates: Array<{ name: string; path: string }>;
    };
    expect(bootstrap.projectCandidates).toContainEqual({
      name: "apps",
      path: path.join(process.cwd(), "apps"),
    });
    expect(bootstrap.projectCandidates.some((candidate) => candidate.name === "node_modules")).toBe(
      false,
    );
  });

  async function createChat() {
    const opened = await mutate("/api/workspaces/open", { path: process.cwd() });
    expect(opened.status).toBe(200);
    const workspace = (await opened.json()) as { id: string };
    const created = await mutate("/api/chats", { workspaceId: workspace.id });
    expect(created.status).toBe(201);
    return (await created.json()) as ChatSnapshot;
  }

  async function waitForIdle(chatId: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = (await (
        await fetch(`${origin}/api/chats/${chatId}`)
      ).json()) as ChatSnapshot;
      if (snapshot.runStatus === "idle") return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Fake run did not settle");
  }

  it("enforces Host, CSRF, request limits, and completes the fake flow", async () => {
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const target = new URL(origin);
      const request = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: "/api/health",
          headers: { Host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(badHostStatus).toBe(403);
    const noCsrf = await fetch(`${origin}/api/workspaces/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: process.cwd() }),
    });
    expect(noCsrf.status).toBe(403);
    const huge = await mutate("/api/workspaces/open", { path: "x".repeat(70_000) });
    expect(huge.status).toBe(413);
    const chat = await createChat();
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionsecurity01",
      expectedRevision: chat.revision,
      text: "hello",
      delivery: "normal",
    });
    expect(sent.status).toBe(202);
    await waitForIdle(chat.chatId);
  });

  it("accepts a prompt once, replays its outcome, rejects conflicts, and stops only the exact run", async () => {
    const chat = await createChat();
    const body = {
      clientId,
      actionId: "actionreplay001",
      expectedRevision: 0,
      text: "stop this",
      delivery: "normal",
    };
    const first = await mutate(`/api/chats/${chat.chatId}/messages`, body);
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as ActionOutcome;
    expect(accepted).toMatchObject({ replayed: false, revision: 1, status: "accepted" });

    const replay = await mutate(`/api/chats/${chat.chatId}/messages`, body);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      actionId: body.actionId,
      runId: accepted.runId,
      replayed: true,
    });
    const live = (await (await fetch(`${origin}/api/chats/${chat.chatId}`)).json()) as ChatSnapshot;
    expect(
      live.items.filter((item) => item.type === "user" && item.text === "stop this"),
    ).toHaveLength(1);

    const conflict = await mutate(`/api/chats/${chat.chatId}/messages`, {
      ...body,
      text: "different work",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "action_conflict" } });
    const stale = await mutate(`/api/chats/${chat.chatId}/messages`, {
      ...body,
      actionId: "actionstale0001",
      text: "new work",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_revision" } });

    const wrongStop = await mutate(`/api/chats/${chat.chatId}/abort`, {
      clientId,
      actionId: "actionstopwrong",
      expectedRevision: 1,
      runId: "wrongrun1234",
    });
    expect(wrongStop.status).toBe(409);
    expect(await wrongStop.json()).toMatchObject({ error: { code: "run_mismatch" } });
    const stopped = await mutate(`/api/chats/${chat.chatId}/abort`, {
      clientId,
      actionId: "actionstopright",
      expectedRevision: 1,
      runId: accepted.runId,
    });
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({
      runId: accepted.runId,
      revision: 2,
      status: "completed",
    });
    const settled = await waitForIdle(chat.chatId);
    expect(settled.run).toMatchObject({
      runId: accepted.runId,
      status: "cancelled",
      requiresAcknowledgement: false,
    });
  });

  it("keeps large tool output out of events and serves it in bounded chunks", async () => {
    const chat = await createChat();
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionlargetool",
      expectedRevision: 0,
      text: "LARGE_TOOL",
      delivery: "normal",
    });
    expect(sent.status).toBe(202);
    const settled = await waitForIdle(chat.chatId);
    const tool = settled.items.find((item): item is ToolItem => item.type === "tool");
    expect(tool).toMatchObject({ truncated: true });
    expect(tool?.preview.length).toBeLessThanOrEqual(16_384);
    expect(tool?.resourceId).toBeTruthy();

    let offset = 0;
    let assembled = "";
    let complete = false;
    while (!complete) {
      const response = await fetch(
        `${origin}/api/chats/${chat.chatId}/tools/${tool!.resourceId}?offset=${offset}&limit=4096`,
      );
      expect(response.status).toBe(200);
      const chunk = (await response.json()) as ToolOutputChunk;
      expect(chunk.text.length).toBeLessThanOrEqual(4096);
      assembled += chunk.text;
      offset = chunk.nextOffset;
      complete = chunk.complete;
    }
    expect(assembled).toContain("end of complete output");
    expect(assembled.length).toBe(tool?.outputSize);
  });

  it("bounds authoritative transcripts and pages older items", async () => {
    const chat = await createChat();
    const record = app.manager.chat(chat.chatId);
    for (let index = 0; index < 240; index++)
      record.items.push({
        type: "notice",
        id: `history-${index}`,
        level: "info",
        text: `Historical event ${index}`,
      });
    const bounded = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(bounded.items.length).toBeLessThanOrEqual(200);
    expect(bounded.transcriptStart).toBeGreaterThan(0);
    expect(bounded.transcriptTotal).toBe(240);
    const response = await fetch(
      `${origin}/api/chats/${chat.chatId}/transcript?before=${bounded.transcriptStart}&limit=50`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: unknown[]; start: number; total: number };
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(page.start).toBeLessThan(bounded.transcriptStart);
    expect(page.total).toBe(240);
    expect(
      (await fetch(`${origin}/api/chats/${chat.chatId}/transcript?before=20&limit=101`)).status,
    ).toBe(400);
  });
});
