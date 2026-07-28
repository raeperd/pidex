import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
import WebSocket, { type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

const execFileAsync = promisify(execFile);

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
    await mkdir(path.join(workspacePath, ".pi"), { recursive: true });
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
    process.env.WORKSPACE_ROOTS = tempRoot;

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
    const secondPath = path.join(tempRoot, "second-workspace");
    await mkdir(secondPath);
    const second = await api.workspaces.open({ path: secondPath, remember: true });
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

    expect(created).toMatchObject({ name: "workspace", path: expect.any(String) });
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
  });

  it("rejects removing a local workspace as a managed worktree", async () => {
    await expect(api.workspaces.removeWorktree({ workspaceId })).rejects.toMatchObject({
      code: "workspace_not_managed_worktree",
      status: 400,
    });
  });

  it("rejects worktree creation outside a Git repository", async () => {
    await expect(
      api.workspaces.createWorktree({ workspaceId: nonGitWorkspaceId }),
    ).rejects.toMatchObject({ code: "project_not_git", status: 400 });
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

    await expect(api.chats.resume({ taskId: "missing_task_12345" })).rejects.toMatchObject({
      code: "internal_error",
      status: 500,
    });
  });

  it("chats.get", async () => {
    const result = await currentChat();

    expect(result).toMatchObject({ chatId, workspaceId, runStatus: "idle" });
  });

  it("chats.sendMessage", async () => {
    const chat = await currentChat();

    await expect(
      api.chats.sendMessage({
        ...actionFor(chat, 1),
        text: "This must not reach a model",
        delivery: "normal",
      }),
    ).rejects.toMatchObject({ code: "stale_revision", status: 409 });
  });

  it("chats.abort", async () => {
    const chat = await currentChat();

    await expect(
      api.chats.abort({ ...actionFor(chat), runId: "missing_run_12345" }),
    ).rejects.toMatchObject({ code: "run_mismatch", status: 409 });
  });

  it("chats.acknowledgeInterrupted", async () => {
    const chat = await currentChat();

    await expect(api.chats.acknowledgeInterrupted(actionFor(chat))).rejects.toMatchObject({
      code: "run_mismatch",
      status: 409,
    });
  });

  it("chats.toolOutput", async () => {
    await expect(
      api.chats.toolOutput({
        chatId,
        resourceId: "missing_resource_12345",
        offset: 0,
        limit: 1024,
      }),
    ).rejects.toMatchObject({ code: "internal_error", status: 500 });
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
      Object.defineProperty(app.manager.chat(chatId).session, "contextUsage", {
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

    await expect(
      api.chats.compact({ ...actionFor(chat, 1), instructions: "Do not run" }),
    ).rejects.toMatchObject({ code: "stale_revision", status: 409 });
  });

  it("chats.answerDialog", async () => {
    const chat = await currentChat();

    await expect(
      api.chats.answerDialog({
        ...actionFor(chat),
        requestId: "missing_dialog_12345",
        value: null,
      }),
    ).rejects.toMatchObject({ code: "dialog_mismatch", status: 409 });
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

    await expect(api.workspaces.removeWorktree({ workspaceId: worktree.id })).rejects.toMatchObject(
      {
        code: "worktree_has_tasks",
        status: 409,
      },
    );
  });

  async function currentChat() {
    return api.chats.get({ chatId });
  }
});

function createClient(url: string, csrfToken?: string): PidexApiContractClient {
  const link = new RPCLink({
    url,
    ...(csrfToken ? { headers: { "x-pidex-csrf": csrfToken } } : {}),
  });
  return createORPCClient(link);
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
