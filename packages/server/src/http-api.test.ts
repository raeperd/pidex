import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NodeHttpServer } from "@effect/platform-node";
import { getEventMeta, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  pidexApiContract,
  PROTOCOL_VERSION,
  type ChatSnapshot,
  type PidexApiContractClient,
  type ServerEvent,
} from "@pidex/api";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pidexApplication } from "./main.js";
import { makeMetadataLayer } from "./metadata.js";

const execFileAsync = promisify(execFile);
let lastRpcResponseStatus: number | undefined;

const coveredEndpoints = [
  "system.health",
  "system.bootstrap",
  "workspaces.open",
  "workspaces.createWorktree",
  "workspaces.removeWorktree",
  "workspaces.reorder",
  "workspaces.sessions",
  "workspaces.trust",
  "chats.create",
  "chats.resume",
  "chats.get",
  "chats.dispose",
  "chats.sendMessage",
  "chats.abort",
  "chats.acknowledgeInterrupted",
  "chats.toolOutput",
  "chats.transcript",
  "chats.clearQueue",
  "chats.configure",
  "chats.rename",
  "chats.compact",
  "chats.answerDialog",
  "live.events",
] as const;

describe.sequential("HTTP API endpoints", () => {
  let app: Effect.Success<typeof pidexApplication>;
  let serverScope: Scope.Closeable | undefined;
  let publicApi: PidexApiContractClient;
  let api: PidexApiContractClient;
  let tempRoot: string;
  let workspacePath: string;
  let nonGitWorkspacePath: string;
  let workspaceId: string;
  let nonGitWorkspaceId: string;
  let chatId: string;
  let httpUrl: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pidex-http-api-"));
    const repositoryPath = path.join(tempRoot, "repository");
    workspacePath = path.join(repositoryPath, "workspace");
    nonGitWorkspacePath = path.join(tempRoot, "non-git-workspace");
    await mkdir(path.join(workspacePath, ".pi"), { recursive: true });
    await mkdir(nonGitWorkspacePath);
    await writeFile(path.join(workspacePath, ".pi", "SYSTEM.md"), "Test system prompt.\n");
    await mkdir(path.join(tempRoot, "agent", "extensions"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "agent", "extensions", "finish.ts"),
      `export default function (pi) {
  pi.registerCommand("finish", {
    handler: async (_args, ctx) => ctx.ui.notify("command finished"),
  });
}
`,
    );
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
    await execFileAsync("git", ["add", "."], { cwd: repositoryPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Pidex Test",
        "-c",
        "user.email=pidex@example.invalid",
        "commit",
        "-m",
        "Initial test project",
      ],
      { cwd: repositoryPath },
    );
    workspacePath = await realpath(workspacePath);

    vi.stubEnv("PIDEX_PROJECT_ROOTS", tempRoot);
    vi.stubEnv("PIDEX_STATE_DIR", path.join(tempRoot, "state"));
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(tempRoot, "agent"));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(tempRoot, "sessions"));
    vi.stubEnv("WORKSPACE_ROOTS", [workspacePath, nonGitWorkspacePath].join(path.delimiter));

    serverScope = await Effect.runPromise(Scope.make());
    const serverContext = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.merge(
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
          makeMetadataLayer(),
        ),
        serverScope,
      ),
    );
    const started = await Effect.runPromise(
      Effect.gen(function* () {
        const application = yield* pidexApplication;
        yield* HttpServer.serveEffect(application.handleRequest);
        const server = yield* HttpServer.HttpServer;
        return { application, httpUrl: HttpServer.formatAddress(server.address) };
      }).pipe(Effect.provide(serverContext), Scope.provide(serverScope)),
    );
    app = started.application;
    httpUrl = started.httpUrl;
    const rpcUrl = `${httpUrl}/api/rpc`;

    publicApi = createClient(rpcUrl);
    const bootstrap = await publicApi.system.bootstrap({});
    api = createClient(rpcUrl, bootstrap.csrfToken);
    workspaceId = (await api.workspaces.open({ path: workspacePath, remember: false })).id;
    chatId = (await api.chats.create({ workspaceId })).chatId;
  }, 30_000);

  afterAll(async () => {
    try {
      if (serverScope) await Effect.runPromise(Scope.close(serverScope, Exit.void));
    } finally {
      vi.unstubAllEnvs();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the endpoint coverage manifest synchronized with the contract", () => {
    expect([...new Set(coveredEndpoints)]).toHaveLength(coveredEndpoints.length);
    expect(contractEndpoints(pidexApiContract).toSorted()).toEqual(coveredEndpoints.toSorted());
  });

  it("system.health", async () => {
    await expect(publicApi.system.health({})).resolves.toEqual({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("system.bootstrap", async () => {
    const result = await publicApi.system.bootstrap({});

    expect(result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      piVersion: "0.80.10",
      warning: expect.any(String),
    });
    expect(result.csrfToken).toHaveLength(43);
  });

  it("streams chat events through the oRPC HTTP event stream", async () => {
    const events = await subscribeChatEvents(api, chatId);

    const result = await events.next();
    expect(result).toMatchObject({
      done: false,
      value: {
        source: "pidex",
        chatId,
        event: { type: "snapshot", snapshot: { chatId } },
      },
    });
    if (result.done) throw new Error("Expected a snapshot event");
    expect(getEventMeta(result.value)).toEqual({
      id: String(result.value.eventId),
      retry: 2_000,
    });

    await events.return?.();
  });

  it("uses the oRPC Last-Event-ID header as the replay cursor", async () => {
    const initial = await subscribeChatEvents(api, chatId);
    const snapshot = await nextMatchingEvent(
      initial,
      (event) => event.source === "pidex" && event.event.type === "snapshot",
    );
    const chat = await currentChat();
    await api.chats.rename({ ...actionFor(chat), name: "Header cursor" });

    const replay = await api.live.events(
      { protocolVersion: PROTOCOL_VERSION, chatId, lastEventId: 0 },
      { lastEventId: String(snapshot.eventId) },
    );
    try {
      await expect(
        nextMatchingEvent(
          replay,
          (event) => event.source === "pidex" && event.event.type === "session",
        ),
      ).resolves.toMatchObject({
        source: "pidex",
        chatId,
        event: { type: "session", name: "Header cursor" },
      });
    } finally {
      await initial.return?.();
      await replay.return?.();
    }
  });

  it("serves typed chat events as SSE over the Node HTTP boundary", async () => {
    const response = await fetch(`${httpUrl}/api/rpc/live/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pidex-csrf": (await publicApi.system.bootstrap({})).csrfToken,
      },
      body: JSON.stringify({
        json: { protocolVersion: PROTOCOL_VERSION, chatId },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");
    let body = "";
    const decoder = new TextDecoder();
    try {
      while (!body.includes('"type":"snapshot"')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE stream ended before the snapshot");
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    expect(body).toContain("event: message");
  });

  it("rejects an unauthenticated HTTP event stream", async () => {
    const { response, result } = await rawRpcRequest(httpUrl, "live/events", {
      protocolVersion: PROTOCOL_VERSION,
      chatId,
    });

    expect(response.status).toBe(403);
    expect(result).toEqual(
      expect.objectContaining({ code: "csrf", message: "Invalid CSRF token" }),
    );
  });

  it("replays chat events from the requested event ID", async () => {
    const initial = await subscribeChatEvents(api, chatId);
    const snapshot = await nextMatchingEvent(
      initial,
      (event) => event.source === "pidex" && event.event.type === "snapshot",
    );
    const chat = await currentChat();

    await api.chats.rename({ ...actionFor(chat), name: "Replay source" });

    const replay = await subscribeChatEvents(api, chatId, snapshot.eventId);
    try {
      await expect(
        nextMatchingEvent(
          replay,
          (event) => event.source === "pidex" && event.event.type === "session",
        ),
      ).resolves.toMatchObject({
        source: "pidex",
        chatId,
        event: { type: "session", name: "Replay source" },
      });
    } finally {
      await initial.return?.();
      await replay.return?.();
    }
  });

  it("falls back to a snapshot when the requested cursor is outside the replay window", async () => {
    const created = await api.chats.create({ workspaceId });
    let current = created;
    try {
      for (let index = 0; index < 501; index++) {
        current = await api.chats.rename({
          ...actionFor(current),
          name: `Replay window ${index}`,
        });
      }

      const events = await subscribeChatEvents(api, created.chatId, 0);
      try {
        await expect(events.next()).resolves.toMatchObject({
          done: false,
          value: {
            source: "pidex",
            chatId: created.chatId,
            event: { type: "snapshot", snapshot: { chatId: created.chatId } },
          },
        });
      } finally {
        await events.return?.();
      }
    } finally {
      await api.chats.dispose({ chatId: created.chatId });
    }
  });

  it("forwards native Pi session events without translating their payload", async () => {
    const events = await connectChatEvents(api, chatId);
    try {
      const chat = await currentChat();
      const nativeEvent = nextMatchingEvent(
        events,
        (event) => event.source === "pi" && event.event.type === "session_info_changed",
      );

      await api.chats.rename({ ...actionFor(chat), name: "Native event" });

      await expect(nativeEvent).resolves.toMatchObject({
        source: "pi",
        chatId,
        event: { type: "session_info_changed", name: "Native event" },
      });
    } finally {
      await events.return?.();
    }
  });

  it("preserves typed errors at the Node HTTP boundary", async () => {
    const unknownApiRoute = await fetch(`${httpUrl}/api/missing`);
    expect(unknownApiRoute.status).toBe(404);
    await expect(unknownApiRoute.json()).resolves.toMatchObject({
      error: { code: "not_found", message: "API route not found" },
    });

    const forbiddenHost = await requestJson(`${httpUrl}/api/missing`, {
      host: "example.com",
    });
    expect(forbiddenHost.status).toBe(403);
    expect(forbiddenHost.body).toMatchObject({
      error: { code: "bad_host", message: "Host is not allowed" },
    });
  });

  it("rejects invalid oRPC transport requests", async () => {
    const bootstrap = await publicApi.system.bootstrap({});
    const invalid = await rawRpcRequest(httpUrl, "chats/create", {}, bootstrap.csrfToken);
    expect(invalid.response.status).toBe(400);
    expect(invalid.result).toEqual(
      expect.objectContaining({ code: "BAD_REQUEST", message: "Input validation failed" }),
    );

    const malformed = await fetch(`${httpUrl}/api/rpc/chats/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pidex-csrf": bootstrap.csrfToken,
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    await expect(rawRpcResult(malformed)).resolves.toEqual(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );

    const missingCsrf = await rawRpcRequest(httpUrl, "chats/create", {
      workspaceId: "workspace_12345",
    });
    expect(missingCsrf.response.status).toBe(403);
    expect(missingCsrf.result).toEqual(
      expect.objectContaining({ code: "csrf", message: "Invalid CSRF token" }),
    );

    const oversized = await rawRpcRequest(
      httpUrl,
      "chats/create",
      { workspaceId: "x".repeat(70 * 1024) },
      bootstrap.csrfToken,
    );
    expect(oversized.response.status).toBe(413);
    expect(oversized.result).toEqual(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  });

  it("workspaces.open", async () => {
    const result = await api.workspaces.open({ path: workspacePath, remember: true });

    expect(result).toMatchObject({
      path: workspacePath,
      name: "workspace",
      protectedResourcesSkipped: true,
    });
  });

  it("workspaces.reorder", async () => {
    const first = await api.workspaces.open({ path: workspacePath, remember: true });
    const second = await api.workspaces.open({ path: nonGitWorkspacePath, remember: true });
    nonGitWorkspaceId = second.id;

    await api.workspaces.reorder({ workspaceIds: [second.id, first.id] });
    await api.workspaces.open({ path: first.path, remember: true });

    await expect(publicApi.system.bootstrap({})).resolves.toMatchObject({
      recentWorkspaces: [
        { id: second.id, path: second.path },
        { id: first.id, path: first.path },
      ],
    });
  });

  it("workspaces.createWorktree", async () => {
    await api.workspaces.trust({ workspaceId, trusted: true });
    const created = await api.workspaces.createWorktree({ workspaceId });
    const { stdout: worktreeRootOutput } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: created.path, encoding: "utf8" },
    );
    const worktreeRoot = worktreeRootOutput.trim();
    const { stdout: branchOutput } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: created.path,
      encoding: "utf8",
    });
    const branch = branchOutput.trim();

    expect(created).toMatchObject({
      name: "workspace",
      path: expect.any(String),
      trusted: true,
      protectedResourcesSkipped: false,
    });
    expect(created.path).toContain(`${path.sep}state${path.sep}worktrees${path.sep}`);
    expect(branch).toMatch(/^pidex\/[0-9a-f]{8}$/);
    await expect(publicApi.system.bootstrap({})).resolves.toMatchObject({
      recentWorkspaces: expect.arrayContaining([
        {
          id: created.id,
          path: created.path,
          sourceWorkspaceId: workspaceId,
          worktree: true,
        },
      ]),
    });
    await api.chats.create({ workspaceId: created.id });

    const dirtyFile = path.join(created.path, "unsaved-worktree-change.txt");
    await writeFile(dirtyFile, "Do not delete this change.\n");
    await expectRpcError(
      api.workspaces.removeWorktree({ workspaceId: created.id }),
      "worktree_remove_failed",
      400,
    );
    await expect(access(dirtyFile)).resolves.toBeUndefined();
    await rm(dirtyFile);

    await expect(api.workspaces.removeWorktree({ workspaceId: created.id })).resolves.toEqual({
      ok: true,
    });
    await expect(access(worktreeRoot)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
        cwd: workspacePath,
      }),
    ).rejects.toThrow();
    await expect(publicApi.system.bootstrap({})).resolves.not.toMatchObject({
      recentWorkspaces: expect.arrayContaining([{ id: created.id }]),
    });
    const trust = JSON.parse(
      await readFile(path.join(tempRoot, "agent", "trust.json"), "utf8"),
    ) as Record<string, boolean>;
    expect(trust[created.path]).toBeUndefined();
  });

  it("rejects removing a local workspace as a managed worktree", async () => {
    await expectRpcError(
      api.workspaces.removeWorktree({ workspaceId }),
      "workspace_not_managed_worktree",
      400,
    );
  });

  it("rejects worktree creation outside a Git repository", async () => {
    await expectRpcError(
      api.workspaces.createWorktree({ workspaceId: nonGitWorkspaceId }),
      "project_not_git",
      400,
    );
  });

  it("rolls back a worktree when the project is absent from HEAD", async () => {
    const uncommittedProjectPath = path.join(workspacePath, "uncommitted-project");
    await mkdir(uncommittedProjectPath);
    const uncommittedWorkspace = await api.workspaces.open({
      path: uncommittedProjectPath,
      remember: false,
    });
    const { stdout: branchesBefore } = await execFileAsync("git", ["branch", "--list", "pidex/*"], {
      cwd: workspacePath,
      encoding: "utf8",
    });

    await expectRpcError(
      api.workspaces.createWorktree({ workspaceId: uncommittedWorkspace.id }),
      "project_missing_from_worktree",
      400,
    );

    const { stdout: branchesAfter } = await execFileAsync("git", ["branch", "--list", "pidex/*"], {
      cwd: workspacePath,
      encoding: "utf8",
    });
    const { stdout: worktrees } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: workspacePath,
      encoding: "utf8",
    });
    expect(branchesAfter).toBe(branchesBefore);
    expect(worktrees).not.toContain(`${path.sep}state${path.sep}worktrees${path.sep}`);
  });

  it("rejects unrecorded directories under the managed worktree root", async () => {
    const unrecordedPath = path.join(tempRoot, "state", "worktrees", "unrecorded");
    await mkdir(unrecordedPath, { recursive: true });

    await expectRpcError(
      api.workspaces.open({ path: unrecordedPath, remember: true }),
      "workspace_forbidden",
      403,
    );
  });

  it("workspaces.sessions", async () => {
    // Pi only writes a session file to disk once it holds an assistant reply (never for a
    // chat that was created but never answered), and this suite runs without a live model.
    // Seed one directly through the real SessionManager persistence API — no mock of our
    // own code, just a session with a genuine reply already on disk — so the listing has
    // something to resolve a status for.
    const seeded = SessionManager.create(workspacePath, path.join(tempRoot, "sessions"));
    seeded.appendMessage({ role: "user", content: "Ping", timestamp: Date.now() });
    seeded.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Pong" }],
      api: "messages",
      provider: "test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await api.workspaces.sessions({ workspaceId });

    expect(result.sessions).toEqual(expect.any(Array));
    const session = result.sessions.find((entry) => entry.firstMessage === "Ping");
    expect(session?.status).toBe("idle");
  });

  it("workspaces.sessions includes a live chat Pi hasn't persisted to disk yet", async () => {
    // A chat with no assistant reply yet has no session file on disk (see the seeding note
    // above), so it is absent from `pi.inspectWorkspace().sessions`. The server must still
    // surface it from the live ChatRecord, or a brand-new task has no sidebar row for its
    // entire first run.
    const created = await api.chats.create({ workspaceId });

    const result = await api.workspaces.sessions({ workspaceId });

    const session = result.sessions.find((entry) => entry.id === created.taskId);
    expect(session).toMatchObject({ status: "idle", messageCount: 0 });
    await api.chats.dispose({ chatId: created.chatId });
  });

  it("workspaces.trust", async () => {
    const untrusted = await api.workspaces.trust({ workspaceId, trusted: false });
    expect(untrusted.trusted).toBe(false);
    expect(untrusted.protectedResourcesSkipped).toBe(true);

    const trusted = await api.workspaces.trust({ workspaceId, trusted: true });
    expect(trusted.trusted).toBe(true);
    expect(trusted.protectedResourcesSkipped).toBe(false);
  });

  it("chats.create", async () => {
    const result = await api.chats.create({ workspaceId });

    expect(result).toMatchObject({
      workspaceId,
      taskId: expect.any(String),
      revision: 0,
      runStatus: "idle",
      stats: {
        messages: 0,
        toolCalls: 0,
        tokens: 0,
        cost: 0,
        subscription: false,
      },
    });
  });

  it("chats.resume", async () => {
    const created = await api.chats.create({ workspaceId });
    const resumed = await api.chats.resume({ taskId: created.taskId });
    expect(resumed).toMatchObject({
      chatId: created.chatId,
      taskId: created.taskId,
      workspaceId,
    });
    await api.chats.dispose({ chatId: created.chatId });

    await expectRpcError(api.chats.resume({ taskId: "missing_task_12345" }), "internal_error", 500);
  });

  it("chats.get", async () => {
    const result = await currentChat();

    expect(result).toMatchObject({ chatId, workspaceId, runStatus: "idle" });
  });

  it("chats.sendMessage", async () => {
    const chat = await currentChat();

    await expectRpcError(
      api.chats.sendMessage({
        ...actionFor(chat, 1),
        text: "This must not reach a model",
        delivery: "normal",
      }),
      "stale_revision",
      409,
    );
  });

  it("completes an extension command that returns while Pi is idle", async () => {
    const created = await api.chats.create({ workspaceId });

    await api.chats.sendMessage({
      ...actionFor(created),
      text: "/finish",
      delivery: "normal",
    });

    await expect
      .poll(async () => api.chats.get({ chatId: created.chatId }), { timeout: 5_000 })
      .toMatchObject({ runStatus: "idle", run: { status: "completed" } });
    await expect(
      api.chats.transcript({ chatId: created.chatId, before: 1, limit: 50 }),
    ).resolves.toMatchObject({
      items: [{ type: "notice", level: "info", text: "command finished" }],
      total: 1,
    });
  });

  it("chats.abort", async () => {
    const chat = await currentChat();

    await expectRpcError(
      api.chats.abort({ ...actionFor(chat), runId: "missing_run_12345" }),
      "run_mismatch",
      409,
    );
  });

  it("chats.acknowledgeInterrupted", async () => {
    const chat = await currentChat();

    await expectRpcError(api.chats.acknowledgeInterrupted(actionFor(chat)), "run_mismatch", 409);
  });

  it("chats.toolOutput", async () => {
    await expectRpcError(
      api.chats.toolOutput({
        chatId,
        resourceId: "missing_resource_12345",
        offset: 0,
        limit: 1024,
      }),
      "internal_error",
      500,
    );
  });

  it("chats.transcript", async () => {
    await expect(api.chats.transcript({ chatId, before: 0, limit: 50 })).resolves.toEqual({
      items: [],
      start: 0,
      total: 0,
    });
  });

  it("chats.clearQueue", async () => {
    const chat = await currentChat();
    const result = await api.chats.clearQueue(actionFor(chat));

    expect(result.revision).toBe(chat.revision + 1);
    expect(result.steeringQueue).toEqual([]);
    expect(result.followUpQueue).toEqual([]);
  });

  it("chats.configure", async () => {
    const chat = await currentChat();
    const result = await api.chats.configure({
      ...actionFor(chat),
      thinkingLevel: "off",
    });

    expect(result).toMatchObject({
      revision: chat.revision + 1,
      thinkingLevel: "off",
    });
  });

  it("broadcasts refreshed context usage after configuration", async () => {
    const streams = await Promise.all([
      connectChatEvents(api, chatId),
      connectChatEvents(api, chatId),
    ]);
    try {
      const contextUsage = {
        tokens: 32_000,
        contextWindow: 128_000,
        percent: 25,
        totalProcessedTokens: 48_000,
        compactsAutomatically: true,
      };
      const chatRecord = await Effect.runPromise(app.manager.chat(chatId));
      Object.defineProperty(chatRecord.session.state, "contextUsage", {
        configurable: true,
        value: contextUsage,
      });
      const usageEvents = streams.map((stream) =>
        nextMatchingEvent(
          stream,
          (event) => event.source === "pidex" && event.event.type === "context_usage",
        ),
      );
      const chat = await currentChat();

      await api.chats.configure({ ...actionFor(chat), thinkingLevel: "minimal" });

      const events = await Promise.all(usageEvents);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event).toMatchObject({ source: "pidex", chatId });
        if (event.source === "pidex" && event.event.type === "context_usage")
          expect(event.event.usage).toEqual(contextUsage);
      }
    } finally {
      await Promise.all(streams.map((stream) => stream.return?.()));
    }
  });

  it("chats.rename", async () => {
    const chat = await currentChat();
    const result = await api.chats.rename({ ...actionFor(chat), name: "Renamed through HTTP" });

    expect(result.revision).toBe(chat.revision + 1);
    expect(result.sessionName).toBe("Renamed through HTTP");
  });

  it("chats.compact", async () => {
    const chat = await currentChat();

    await expectRpcError(
      api.chats.compact({ ...actionFor(chat, 1), instructions: "Do not run" }),
      "stale_revision",
      409,
    );
  });

  it("chats.answerDialog", async () => {
    const chat = await currentChat();

    await expectRpcError(
      api.chats.answerDialog({
        ...actionFor(chat),
        requestId: "missing_dialog_12345",
        value: null,
      }),
      "dialog_mismatch",
      409,
    );
  });

  it("chats.dispose", async () => {
    await expect(api.chats.dispose({ chatId })).resolves.toEqual({ ok: true });
  });

  it("rejects removing a managed worktree after its task starts", async () => {
    const worktree = await api.workspaces.createWorktree({ workspaceId });
    const created = await api.chats.create({ workspaceId: worktree.id });
    await api.chats.sendMessage({
      ...actionFor(created),
      text: "Persist this worktree task",
      delivery: "normal",
    });
    await expect
      .poll(async () => (await api.chats.get({ chatId: created.chatId })).transcriptTotal, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    await api.chats.dispose({ chatId: created.chatId });
    await api.workspaces.open({ path: worktree.path, remember: true });

    await expectRpcError(
      api.workspaces.removeWorktree({ workspaceId: worktree.id }),
      "worktree_has_tasks",
      409,
    );
  });

  async function currentChat() {
    return api.chats.get({ chatId });
  }
});

function createClient(url: string, csrfToken?: string): PidexApiContractClient {
  const endpoint = new URL(url);
  const link = new RPCLink({
    origin: endpoint.origin,
    url: endpoint.pathname as `/${string}`,
    fetch: async (requestUrl, init) => {
      const response = await fetch(requestUrl, init);
      lastRpcResponseStatus = response.status;
      return response;
    },
    ...(csrfToken ? { headers: { "x-pidex-csrf": csrfToken } } : {}),
  });
  return createORPCClient(link);
}

async function expectRpcError(operation: Promise<unknown>, code: string, status: number) {
  await expect(operation).rejects.toMatchObject({ code });
  expect(lastRpcResponseStatus).toBe(status);
}

function actionFor(chat: ChatSnapshot, revisionOffset = 0) {
  return {
    chatId: chat.chatId,
    clientId: "http_api_test_client",
    actionId: randomUUID().replaceAll("-", ""),
    expectedRevision: chat.revision + revisionOffset,
  };
}

async function connectChatEvents(client: PidexApiContractClient, chatId: string) {
  const events = await subscribeChatEvents(client, chatId);
  await nextMatchingEvent(
    events,
    (event) => event.source === "pidex" && event.event.type === "snapshot",
  );
  return events;
}

function subscribeChatEvents(client: PidexApiContractClient, chatId: string, lastEventId?: number) {
  return client.live.events({
    protocolVersion: PROTOCOL_VERSION,
    chatId,
    ...(lastEventId === undefined ? {} : { lastEventId }),
  });
}

async function nextMatchingEvent(
  events: AsyncIterator<ServerEvent>,
  matches: (event: ServerEvent) => boolean,
): Promise<ServerEvent> {
  while (true) {
    const result = await events.next();
    if (result.done) throw new Error("Event stream ended before the expected event");
    if (matches(result.value)) return result.value;
  }
}

function contractEndpoints(value: unknown, prefix: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if ("~orpc" in value) return [prefix.join(".")];
  return Object.entries(value).flatMap(([key, child]) =>
    contractEndpoints(child, [...prefix, key]),
  );
}

async function requestJson(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
        }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

async function rawRpcRequest(
  origin: string,
  procedure: string,
  input: unknown,
  csrfToken?: string,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (csrfToken) headers.set("x-pidex-csrf", csrfToken);
  const response = await fetch(`${origin}/api/rpc/${procedure}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
  });
  return { response, result: await rawRpcResult(response) };
}

async function rawRpcResult(response: Response) {
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("json" in payload))
    throw new Error("Expected an oRPC JSON envelope");
  return payload.json;
}
