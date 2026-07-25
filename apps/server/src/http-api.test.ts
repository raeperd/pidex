import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  pidexApiContract,
  PROTOCOL_VERSION,
  type ChatSnapshot,
  type PidexApiContractClient,
} from "@pidex/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

const coveredEndpoints = [
  "system.health",
  "system.bootstrap",
  "workspaces.open",
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
  let chatId: string;
  const originalEnvironment = preserveEnvironment([
    "PIDEX_PROJECT_ROOTS",
    "PIDEX_STATE_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "WORKSPACE_ROOTS",
  ]);

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pidex-http-api-"));
    workspacePath = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspacePath, ".pi"), { recursive: true });
    await writeFile(path.join(workspacePath, ".pi", "SYSTEM.md"), "Test system prompt.\n");
    workspacePath = await realpath(workspacePath);

    process.env.PIDEX_PROJECT_ROOTS = tempRoot;
    process.env.PIDEX_STATE_DIR = path.join(tempRoot, "state");
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, "sessions");
    process.env.WORKSPACE_ROOTS = tempRoot;

    app = await createPidexServer();
    await listen(app);
    const address = app.server.address() as AddressInfo;
    const rpcUrl = `http://127.0.0.1:${address.port}/api/rpc`;

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

  it("workspaces.open", async () => {
    const result = await api.workspaces.open({ path: workspacePath, remember: true });

    expect(result).toMatchObject({
      path: workspacePath,
      name: "workspace",
      protectedResourcesSkipped: true,
    });
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
      revision: 0,
      runStatus: "idle",
    });
  });

  it("chats.resume", async () => {
    await expect(
      api.chats.resume({ workspaceId, sessionId: "missing_session_12345" }),
    ).rejects.toMatchObject({ code: "internal_error", status: 500 });
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
      toolMode: "full",
    });

    expect(result).toMatchObject({
      revision: chat.revision + 1,
      thinkingLevel: "off",
      toolMode: "full",
    });
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
