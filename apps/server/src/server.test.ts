import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { serverEventSchema } from "@pidex/api";
import type {
  ActionOutcome,
  ChatSnapshot,
  ServerEvent,
  ToolItem,
  ToolOutputChunk,
} from "@pidex/api";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

function nextServerEvent(
  socket: WebSocket,
  predicate: (event: ServerEvent) => boolean,
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = serverEventSchema.safeParse(value);
      if (!parsed.success || !predicate(parsed.data)) return;
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(parsed.data);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

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

  const openSocket = async () => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/api/ws", { origin });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  };

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

  it("rejects ordinary files as project directories", async () => {
    const response = await mutate("/api/workspaces/open", {
      path: path.join(process.cwd(), "package.json"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_not_directory" },
    });
  });

  it("opens an unremembered project without adding it to recent projects", async () => {
    const response = await mutate("/api/workspaces/open", {
      path: path.join(process.cwd(), "apps"),
      remember: false,
    });
    expect(response.status).toBe(200);

    const bootstrap = (await (await fetch(`${origin}/api/bootstrap`)).json()) as {
      recentWorkspaces: Array<{ path: string }>;
    };
    expect(bootstrap.recentWorkspaces).toEqual([]);
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

  it("keeps a new chat associated with its sidebar session after refresh", async () => {
    const chat = await createChat();

    const sessions = (await (
      await fetch(`${origin}/api/workspaces/${chat.workspaceId}/sessions`)
    ).json()) as { sessions: Array<{ id: string }> };

    expect(sessions.sessions).toContainEqual(expect.objectContaining({ id: chat.sessionId }));
  });

  it("keeps native session identifiers out of browser responses", async () => {
    const chat = await createChat();

    const sessions = (await (
      await fetch(`${origin}/api/workspaces/${chat.workspaceId}/sessions`)
    ).json()) as { sessions: Array<Record<string, unknown>> };
    const created = sessions.sessions.find((session) => session.id === chat.sessionId);

    expect(created).toBeDefined();
    expect(created).not.toHaveProperty("nativeId");
    expect(created).not.toHaveProperty("nativePath");
  });

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

  it("rejects a loopback Origin from a different port", async () => {
    const response = await fetch(`${origin}/api/workspaces/open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:1",
        "X-Pidex-CSRF": csrf,
      },
      body: JSON.stringify({ path: process.cwd() }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "bad_origin" } });
  });

  it("rejects malformed WebSocket messages without taking the host down", async () => {
    const socket = await openSocket();

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.send("{");

    await expect(closed).resolves.toEqual({ code: 1008, reason: "Invalid protocol message" });
    await expect(fetch(`${origin}/api/health`)).resolves.toMatchObject({ status: 200 });
  });

  it("requires a WebSocket hello before acknowledgements or heartbeats", async () => {
    const socket = await openSocket();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    socket.send(JSON.stringify({ type: "pong" }));

    await expect(closed).resolves.toEqual({ code: 1008, reason: "Hello required" });
  });

  it("restores a pending extension dialog in a reconnect snapshot", async () => {
    const chat = await createChat();
    const first = await openSocket();
    const initialSnapshot = nextServerEvent(first, (event) => event.type === "snapshot");
    first.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    await initialSnapshot;

    const pendingDialog = nextServerEvent(
      first,
      (event) => event.type === "extension_dialog" && Boolean(event.dialog),
    );
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actiondialog01",
      expectedRevision: chat.revision,
      text: "DIALOG",
      delivery: "normal",
    });
    expect(sent.status).toBe(202);
    const dialogEvent = await pendingDialog;
    expect(dialogEvent).toMatchObject({ type: "extension_dialog" });
    if (dialogEvent.type !== "extension_dialog" || !dialogEvent.dialog)
      throw new Error("Expected a pending extension dialog");

    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;

    const second = await openSocket();
    const replacement = nextServerEvent(second, (event) => event.type === "snapshot");
    second.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    const snapshotEvent = await replacement;
    if (snapshotEvent.type !== "snapshot") throw new Error("Expected a replacement snapshot");
    expect(snapshotEvent.snapshot.extensionDialog).toEqual(dialogEvent.dialog);

    const answered = await mutate(`/api/chats/${chat.chatId}/dialog`, {
      clientId,
      actionId: "answerdialog01",
      expectedRevision: snapshotEvent.snapshot.revision,
      requestId: dialogEvent.dialog.id,
      value: true,
    });
    expect(answered.status).toBe(200);
    await waitForIdle(chat.chatId);
    second.close();
  });

  it("replays a known WebSocket cursor and resnapshots an impossible cursor", async () => {
    const chat = await createChat();
    const first = await openSocket();
    const initialPromise = nextServerEvent(first, (event) => event.type === "snapshot");
    first.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    const initial = await initialPromise;
    if (initial.type !== "snapshot") throw new Error("Expected an initial snapshot");
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;

    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionreplaycursor",
      expectedRevision: chat.revision,
      text: "MARKDOWN:cursor replay",
      delivery: "normal",
    });
    expect(sent.status).toBe(202);
    await waitForIdle(chat.chatId);

    const replaySocket = await openSocket();
    const replayPromise = nextServerEvent(replaySocket, () => true);
    replaySocket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        chatId: chat.chatId,
        lastEventId: initial.eventId,
      }),
    );
    const replayed = await replayPromise;
    expect(replayed.eventId).toBe(initial.eventId + 1);
    expect(replayed.type).not.toBe("snapshot");
    replaySocket.close();

    const replacementSocket = await openSocket();
    const replacementPromise = nextServerEvent(
      replacementSocket,
      (event) => event.type === "snapshot",
    );
    replacementSocket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 2,
        chatId: chat.chatId,
        lastEventId: 999_999,
      }),
    );
    const replacement = await replacementPromise;
    expect(replacement.type).toBe("snapshot");
    replacementSocket.close();
  });

  it("accepts an extension response only for the pending dialog ID", async () => {
    const chat = await createChat();
    const socket = await openSocket();
    const initialSnapshot = nextServerEvent(socket, (event) => event.type === "snapshot");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    await initialSnapshot;

    const pendingDialog = nextServerEvent(
      socket,
      (event) => event.type === "extension_dialog" && Boolean(event.dialog),
    );
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actiondialog02",
      expectedRevision: chat.revision,
      text: "DIALOG",
      delivery: "normal",
    });
    const accepted = (await sent.json()) as ActionOutcome;
    const dialogEvent = await pendingDialog;
    if (dialogEvent.type !== "extension_dialog" || !dialogEvent.dialog)
      throw new Error("Expected a pending extension dialog");

    const wrong = await mutate(`/api/chats/${chat.chatId}/dialog`, {
      clientId,
      actionId: "answerdialog02wrong",
      expectedRevision: accepted.revision,
      requestId: "wrongdialogid",
      value: true,
    });
    expect(wrong.status).toBe(409);
    await expect(wrong.json()).resolves.toMatchObject({ error: { code: "dialog_mismatch" } });

    const answered = await mutate(`/api/chats/${chat.chatId}/dialog`, {
      clientId,
      actionId: "answerdialog02right",
      expectedRevision: accepted.revision,
      requestId: dialogEvent.dialog.id,
      value: true,
    });
    expect(answered.status).toBe(200);
    await waitForIdle(chat.chatId);
    socket.close();
  });

  it("validates an extension response against the pending dialog kind", async () => {
    const chat = await createChat();
    const socket = await openSocket();
    const initialSnapshot = nextServerEvent(socket, (event) => event.type === "snapshot");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    await initialSnapshot;

    const pendingDialog = nextServerEvent(
      socket,
      (event) => event.type === "extension_dialog" && Boolean(event.dialog),
    );
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actiondialog03",
      expectedRevision: chat.revision,
      text: "DIALOG",
      delivery: "normal",
    });
    const accepted = (await sent.json()) as ActionOutcome;
    const dialogEvent = await pendingDialog;
    if (dialogEvent.type !== "extension_dialog" || !dialogEvent.dialog)
      throw new Error("Expected a pending extension dialog");

    const wrongType = await mutate(`/api/chats/${chat.chatId}/dialog`, {
      clientId,
      actionId: "answerdialog03wrong",
      expectedRevision: accepted.revision,
      requestId: dialogEvent.dialog.id,
      value: "true",
    });
    expect(wrongType.status).toBe(400);
    await expect(wrongType.json()).resolves.toMatchObject({
      error: { code: "dialog_value_invalid" },
    });

    const answered = await mutate(`/api/chats/${chat.chatId}/dialog`, {
      clientId,
      actionId: "answerdialog03right",
      expectedRevision: accepted.revision,
      requestId: dialogEvent.dialog.id,
      value: true,
    });
    expect(answered.status).toBe(200);
    await waitForIdle(chat.chatId);
    socket.close();
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

  it("rejects a whitespace-only prompt without consuming a revision", async () => {
    const chat = await createChat();
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionblankprompt",
      expectedRevision: chat.revision,
      text: " \n\t ",
      delivery: "normal",
    });

    expect(sent.status).toBe(400);
    await expect(sent.json()).resolves.toMatchObject({ error: { code: "validation" } });
    const unchanged = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(unchanged).toMatchObject({ revision: chat.revision, items: [] });
  });

  it("redacts provider secrets from browser-visible runtime errors", async () => {
    const chat = await createChat();
    const socket = await openSocket();
    const initialSnapshot = nextServerEvent(socket, (event) => event.type === "snapshot");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, chatId: chat.chatId }));
    await initialSnapshot;

    const errorNotice = nextServerEvent(
      socket,
      (event) => event.type === "notice" && event.item.level === "error",
    );
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionsecreterror",
      expectedRevision: chat.revision,
      text: "SECRET_ERROR",
      delivery: "normal",
    });
    expect(sent.status).toBe(202);
    const notice = await errorNotice;
    if (notice.type !== "notice") throw new Error("Expected an error notice");
    expect(notice.item.text).toContain("[redacted]");
    expect(notice.item.text).not.toContain("pidex-canary-secret-token");
    socket.close();
  });

  it("requires acknowledgement instead of rerunning an accepted prompt after host restart", async () => {
    const chat = await createChat();
    const renamedResponse = await mutate(`/api/chats/${chat.chatId}/rename`, {
      clientId,
      actionId: "actionrestartname",
      expectedRevision: chat.revision,
      name: "Restart recovery sentinel",
    });
    const renamed = (await renamedResponse.json()) as ChatSnapshot;
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionrestart01",
      expectedRevision: renamed.revision,
      text: "stop this",
      delivery: "normal",
    });
    const accepted = (await sent.json()) as ActionOutcome;
    expect(accepted.status).toBe("accepted");

    await app.close();
    app = await createPidexServer();
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No address after restart");
    origin = `http://127.0.0.1:${address.port}`;
    csrf = ((await (await fetch(`${origin}/api/bootstrap`)).json()) as { csrfToken: string })
      .csrfToken;

    const opened = await mutate("/api/workspaces/open", { path: process.cwd() });
    const workspace = (await opened.json()) as { id: string };
    const sessions = (await (
      await fetch(`${origin}/api/workspaces/${workspace.id}/sessions`)
    ).json()) as { sessions: Array<{ id: string; name?: string }> };
    const restartedSession = sessions.sessions.find(
      (session) => session.name === "Restart recovery sentinel",
    );
    expect(restartedSession).toBeDefined();
    const resumed = await mutate("/api/chats/resume", {
      workspaceId: workspace.id,
      sessionId: restartedSession!.id,
    });
    const interrupted = (await resumed.json()) as ChatSnapshot;
    expect(interrupted).toMatchObject({
      revision: accepted.revision,
      runStatus: "idle",
      run: {
        runId: accepted.runId,
        status: "interrupted",
        requiresAcknowledgement: true,
      },
    });

    const blocked = await mutate(`/api/chats/${interrupted.chatId}/messages`, {
      clientId,
      actionId: "actionrestartblocked",
      expectedRevision: interrupted.revision,
      text: "do not rerun blindly",
      delivery: "normal",
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: "interrupted_run" } });

    const acknowledged = await mutate(`/api/chats/${interrupted.chatId}/interrupted/acknowledge`, {
      clientId,
      actionId: "actionrestartack",
      expectedRevision: interrupted.revision,
    });
    expect(acknowledged.status).toBe(200);
    await expect(acknowledged.json()).resolves.toMatchObject({
      revision: accepted.revision + 1,
    });
  });

  it("rejects configuration while a run is active without consuming a revision", async () => {
    const chat = await createChat();
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionbusyconfig",
      expectedRevision: chat.revision,
      text: "stop this",
      delivery: "normal",
    });
    const accepted = (await sent.json()) as ActionOutcome;

    const configured = await fetch(`${origin}/api/chats/${chat.chatId}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf },
      body: JSON.stringify({
        clientId,
        actionId: "configwhilebusy",
        expectedRevision: accepted.revision,
        thinkingLevel: "high",
      }),
    });
    expect(configured.status).toBe(409);
    await expect(configured.json()).resolves.toMatchObject({ error: { code: "session_busy" } });

    const unchanged = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(unchanged).toMatchObject({ revision: accepted.revision, thinkingLevel: "medium" });

    const stopped = await mutate(`/api/chats/${chat.chatId}/abort`, {
      clientId,
      actionId: "stopbusyconfig",
      expectedRevision: accepted.revision,
      runId: accepted.runId,
    });
    expect(stopped.status).toBe(202);
    await waitForIdle(chat.chatId);
  });

  it("rejects an empty configuration without consuming a revision", async () => {
    const chat = await createChat();
    const configured = await fetch(`${origin}/api/chats/${chat.chatId}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf },
      body: JSON.stringify({
        clientId,
        actionId: "emptyconfiguration",
        expectedRevision: chat.revision,
      }),
    });

    expect(configured.status).toBe(400);
    await expect(configured.json()).resolves.toMatchObject({ error: { code: "validation" } });
    const unchanged = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(unchanged.revision).toBe(chat.revision);
  });

  it("rejects an unavailable model without consuming a revision", async () => {
    const chat = await createChat();
    const configured = await fetch(`${origin}/api/chats/${chat.chatId}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf },
      body: JSON.stringify({
        clientId,
        actionId: "missingmodelconfig",
        expectedRevision: chat.revision,
        model: "missing/model",
      }),
    });

    expect(configured.status).toBe(400);
    await expect(configured.json()).resolves.toMatchObject({
      error: { code: "model_unavailable" },
    });
    const unchanged = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(unchanged).toMatchObject({ revision: chat.revision, model: "fake/deterministic" });
  });

  it("rejects compaction while a run is active without consuming a revision", async () => {
    const chat = await createChat();
    const sent = await mutate(`/api/chats/${chat.chatId}/messages`, {
      clientId,
      actionId: "actionbusycompact",
      expectedRevision: chat.revision,
      text: "stop this",
      delivery: "normal",
    });
    const accepted = (await sent.json()) as ActionOutcome;

    const compacted = await mutate(`/api/chats/${chat.chatId}/compact`, {
      clientId,
      actionId: "compactwhilebusy",
      expectedRevision: accepted.revision,
    });
    expect(compacted.status).toBe(409);
    await expect(compacted.json()).resolves.toMatchObject({ error: { code: "session_busy" } });

    const unchanged = (await (
      await fetch(`${origin}/api/chats/${chat.chatId}`)
    ).json()) as ChatSnapshot;
    expect(unchanged).toMatchObject({ revision: accepted.revision, runStatus: "running" });

    const stopped = await mutate(`/api/chats/${chat.chatId}/abort`, {
      clientId,
      actionId: "stopbusycompact",
      expectedRevision: accepted.revision,
      runId: accepted.runId,
    });
    expect(stopped.status).toBe(202);
    await waitForIdle(chat.chatId);
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
