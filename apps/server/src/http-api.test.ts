import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  pidexApiContract,
  PROTOCOL_VERSION,
  type ChatSnapshot,
  type PidexApiContractClient,
  type ServerEvent,
} from "@pidex/api";
import { Effect } from "effect";
import WebSocket, { type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

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
] as const;

describe.sequential("HTTP API endpoints", () => {
  let app: Awaited<ReturnType<typeof createPidexServer>>;
  let publicApi: PidexApiContractClient;
  let api: PidexApiContractClient;
  let tempRoot: string;
  let workspacePath: string;
  let nonGitWorkspacePath: string;
  let workspaceId: string;
  let nonGitWorkspaceId: string;
  let chatId: string;
  let httpUrl: string;
  let websocketUrl: string;
  const originalEnvironment = preserveEnvironment([
    "PIDEX_PROJECT_ROOTS",
    "PIDEX_STATE_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "WORKSPACE_ROOTS",
  ]);

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pidex-http-api-"));
    const repositoryPath = path.join(tempRoot, "repository");
    workspacePath = path.join(repositoryPath, "workspace");
    nonGitWorkspacePath = path.join(tempRoot, "non-git-workspace");
    await mkdir(path.join(workspacePath, ".pi"), { recursive: true });
    await mkdir(nonGitWorkspacePath);
    await writeFile(path.join(workspacePath, ".pi", "SYSTEM.md"), "Test system prompt.\n");
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

    process.env.PIDEX_PROJECT_ROOTS = tempRoot;
    process.env.PIDEX_STATE_DIR = path.join(tempRoot, "state");
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, "sessions");
    process.env.WORKSPACE_ROOTS = [workspacePath, nonGitWorkspacePath].join(path.delimiter);

    app = await createPidexServer();
    await listen(app);
    const address = app.server.address() as AddressInfo;
    httpUrl = `http://127.0.0.1:${address.port}`;
    const rpcUrl = `${httpUrl}/api/rpc`;
    websocketUrl = `ws://127.0.0.1:${address.port}/api/ws`;

    publicApi = createClient(rpcUrl);
    const bootstrap = await publicApi.system.bootstrap({});
    api = createClient(rpcUrl, bootstrap.csrfToken);
    workspaceId = (await api.workspaces.open({ path: workspacePath, remember: false })).id;
    chatId = (await api.chats.create({ workspaceId })).chatId;
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      restoreEnvironment(originalEnvironment);
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
    const result = await api.workspaces.sessions({ workspaceId });

    expect(result.sessions).toEqual(expect.any(Array));
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
    const sockets = await Promise.all([
      connectChatSocket(websocketUrl, chatId),
      connectChatSocket(websocketUrl, chatId),
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
      const usageEvents = sockets.map((socket) =>
        waitForSocketEvent(socket, (event) => event.type === "context_usage"),
      );
      const chat = await currentChat();

      await api.chats.configure({ ...actionFor(chat), thinkingLevel: "minimal" });

      const events = await Promise.all(usageEvents);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event).toMatchObject({ type: "context_usage", chatId });
        if (event.type === "context_usage") expect(event.usage).toEqual(contextUsage);
      }
    } finally {
      for (const socket of sockets) socket.close();
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

async function connectChatSocket(url: string, chatId: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("open", () => {
      socket.off("error", onError);
      resolve();
    });
  });
  const snapshot = waitForSocketEvent(socket, (event) => event.type === "snapshot");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, chatId }));
  await snapshot;
  return socket;
}

function waitForSocketEvent(
  socket: WebSocket,
  matches: (event: ServerEvent) => boolean,
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for server event")),
      5_000,
    );
    const onMessage = (data: RawData) => {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        if (matches(event)) finish(undefined, event);
      } catch {}
    };
    const onClose = () => finish(new Error("Socket closed before the expected server event"));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, event?: ServerEvent) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(event!);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function contractEndpoints(value: unknown, prefix: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if ("~orpc" in value) return [prefix.join(".")];
  return Object.entries(value).flatMap(([key, child]) =>
    contractEndpoints(child, [...prefix, key]),
  );
}

async function listen(app: Awaited<ReturnType<typeof createPidexServer>>) {
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
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

function preserveEnvironment<const Key extends string>(keys: readonly Key[]) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    Key,
    string | undefined
  >;
}

function restoreEnvironment(environment: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
