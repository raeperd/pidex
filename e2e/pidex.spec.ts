import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

test("serves the Pi host and branded assets", async ({ request }) => {
  const health = await rpcRequest(request, "system/health", {});
  expect(health.response.status()).toBe(200);
  expect(health.result).toEqual({
    ok: true,
    protocolVersion: 4,
  });

  const png = await request.get("/pidex-icon.png");
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");

  const icon = await request.get("/favicon.ico");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/x-icon");
});

test("serves the contract through oRPC's native transport", async ({ request }) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const { csrfToken } = bootstrap.result;

  const invalid = await rpcRequest(request, "chats/create", {}, csrfToken);
  expect(invalid.response.status()).toBe(400);
  expect(invalid.result).toEqual(
    expect.objectContaining({ code: "BAD_REQUEST", message: "Input validation failed" }),
  );

  const malformed = await request.post("/api/rpc/chats/create", {
    headers: { "X-Pidex-CSRF": csrfToken, "Content-Type": "application/json" },
    data: Buffer.from("{"),
  });
  expect(malformed.status()).toBe(400);
  await expect(rpcResult(malformed)).resolves.toEqual(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );

  const missingCsrf = await rpcRequest(request, "chats/create", {
    workspaceId: "workspace_12345",
  });
  expect(missingCsrf.response.status()).toBe(403);
  expect(missingCsrf.result).toEqual(
    expect.objectContaining({ code: "csrf", message: "Invalid CSRF token" }),
  );

  const oversized = await rpcRequest(
    request,
    "chats/create",
    { workspaceId: "x".repeat(70 * 1024) },
    csrfToken,
  );
  expect(oversized.response.status()).toBe(413);
  expect(oversized.result).toEqual(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));

  const opened = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: process.cwd() },
    csrfToken,
  );
  expect(opened.response.ok()).toBe(true);

  const created = await rpcRequest<{ chatId: string; revision: number }>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    csrfToken,
  );
  expect(created.response.status()).toBe(200);

  const transcript = await rpcRequest(
    request,
    "chats/transcript",
    { chatId: created.result.chatId, before: 0, limit: 50 },
    csrfToken,
  );
  expect(transcript.response.status()).toBe(200);
  expect(transcript.result).toEqual(
    expect.objectContaining({ items: expect.any(Array), start: 0, total: 0 }),
  );

  const cleared = await rpcRequest(
    request,
    "chats/clearQueue",
    {
      chatId: created.result.chatId,
      clientId: "e2e_client_12345",
      actionId: crypto.randomUUID().replaceAll("-", ""),
      expectedRevision: created.result.revision,
    },
    csrfToken,
  );
  expect(cleared.response.status()).toBe(200);

  const disposed = await rpcRequest(
    request,
    "chats/dispose",
    { chatId: created.result.chatId },
    csrfToken,
  );
  expect(disposed.response.status()).toBe(200);
  expect(disposed.result).toEqual({ ok: true });
});

test("keeps search and thread creation in the no-active-thread experience", async ({
  page,
  request,
}) => {
  const createRequests: unknown[] = [];
  page.on("request", (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    const body = (browserRequest.postDataJSON() as { json?: unknown } | null)?.json;
    if (browserRequest.method() === "POST" && path === "/api/rpc/chats/create")
      createRequests.push(body);
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    const workspace = payload.json as Record<string, unknown> & {
      models: unknown[];
    };
    await route.fulfill({
      response,
      json: {
        ...payload,
        json: {
          ...workspace,
          models: [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }],
        },
      },
    });
  });
  await rememberWorkspace(request, process.cwd());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Pick a thread to continue" })).toBeVisible();
  await expect(page.getByText("No active thread", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await expect(page.getByLabel("Thinking level")).toHaveCount(0);

  await openSessions(page);
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search projects and threads" }).click();
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toBeFocused();
  await page.getByRole("button", { name: "Close search" }).click();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("button", { name: /^(Add|Open) apps$/ }).click();
  await expect(page.getByRole("heading", { name: "Pick a thread to continue" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);

  await openSessions(page);
  await Promise.all([
    page.waitForRequest(
      (browserRequest) =>
        browserRequest.method() === "POST" &&
        new URL(browserRequest.url()).pathname === "/api/rpc/chats/create",
    ),
    page.getByRole("button", { name: "New thread in apps" }).click(),
  ]);

  await expect(page.getByRole("heading", { name: "Pick a thread to continue" })).toHaveCount(0);
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]).toEqual(expect.objectContaining({ workspaceId: expect.any(String) }));
});

test("stages configuration for the next normal turn while a run is active", async ({
  page,
  request,
}) => {
  await installFakeWebSocket(page);
  const mutations: Array<{ procedure: "configure" | "send"; input: Record<string, unknown> }> = [];
  let snapshot: Record<string, unknown> | undefined;

  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    const workspace = payload.json as Record<string, unknown> & { models: unknown[] };
    await route.fulfill({
      response,
      json: {
        ...payload,
        json: {
          ...workspace,
          models: [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }],
        },
      },
    });
  });
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    snapshot = payload.json;
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/rpc/chats/configure", async (route) => {
    if (!snapshot) throw new Error("Expected a chat before configuration");
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    mutations.push({ procedure: "configure", input });
    snapshot = {
      ...snapshot,
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.thinkingLevel === "string" ? { thinkingLevel: input.thinkingLevel } : {}),
      revision: Number(input.expectedRevision) + 1,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: snapshot },
    });
  });
  await page.route("**/api/rpc/chats/sendMessage", async (route) => {
    if (!snapshot) throw new Error("Expected a chat before sending");
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    mutations.push({ procedure: "send", input });
    const revision = Number(input.expectedRevision) + 1;
    snapshot = { ...snapshot, revision };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          accepted: true,
          actionId: input.actionId,
          runId: "run_e2e_12345",
          status: "accepted",
          revision,
          replayed: false,
        },
      },
    });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openSessions(page);
  await page
    .getByRole("button", { name: /^New thread in / })
    .first()
    .click();

  const prompt = page.getByLabel("Prompt");
  const thinking = page.getByLabel("Thinking level");
  await expect(prompt).toBeVisible();

  const nextThinking = (await thinking.inputValue()) === "high" ? "low" : "high";
  await thinking.selectOption(nextThinking);
  await expect(page.getByText("Next turn", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);

  await prompt.fill("Start the first turn");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => mutations.map(({ procedure }) => procedure))
    .toEqual(["configure", "send"]);
  expect(mutations[0]?.input).toEqual(expect.objectContaining({ thinkingLevel: nextThinking }));
  expect(mutations[1]?.input).toEqual(expect.objectContaining({ delivery: "normal" }));
  await expect(page.getByText("Next turn", { exact: true })).toHaveCount(0);

  mutations.length = 0;
  const chatId = String(snapshot?.chatId);
  await emitServerEvent(page, {
    type: "run_status",
    eventId: 1,
    chatId,
    status: "running",
    revision: 40,
    run: {
      runId: "run_e2e_12345",
      actionId: "action_e2e_12345",
      status: "running",
      requiresAcknowledgement: false,
    },
  });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(thinking).toBeEnabled();

  const stagedThinking = nextThinking === "high" ? "medium" : "high";
  await thinking.selectOption(stagedThinking);
  await expect(page.getByText("Next turn", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);

  await page.getByLabel("Delivery mode").selectOption("steer");
  await prompt.fill("Guide the current turn");
  await page.getByRole("button", { name: "Queue" }).click();
  await expect.poll(() => mutations).toHaveLength(1);
  expect(mutations[0]).toEqual(
    expect.objectContaining({
      procedure: "send",
      input: expect.objectContaining({ delivery: "steer" }),
    }),
  );
  await expect(page.getByText("Next turn", { exact: true })).toBeVisible();

  mutations.length = 0;
  await emitServerEvent(page, {
    type: "run_status",
    eventId: 2,
    chatId,
    status: "idle",
    revision: 50,
  });
  await prompt.fill("Start the next turn");
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => mutations.map(({ procedure }) => procedure))
    .toEqual(["configure", "send"]);
  expect(mutations[0]?.input).toEqual(expect.objectContaining({ thinkingLevel: stagedThinking }));
  expect(mutations[1]?.input).toEqual(expect.objectContaining({ delivery: "normal" }));
});

async function rememberWorkspace(request: APIRequestContext, workspacePath: string) {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  expect(bootstrap.response.ok()).toBe(true);
  const opened = await rpcRequest(
    request,
    "workspaces/open",
    { path: workspacePath },
    bootstrap.result.csrfToken,
  );
  expect(opened.response.ok()).toBe(true);
}

async function rpcRequest<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
  csrfToken?: string,
) {
  const response = await request.post(`/api/rpc/${procedure}`, {
    headers: csrfToken ? { "X-Pidex-CSRF": csrfToken } : undefined,
    data: { json: input },
  });
  return { response, result: (await rpcResult(response)) as T };
}

async function rpcResult(response: APIResponse) {
  const payload = (await response.json()) as { json: unknown };
  return payload.json;
}

async function openSessions(page: Page) {
  const button = page.getByRole("button", { name: "Open sessions" });
  if (await button.isVisible()) await button.click();
}

async function installFakeWebSocket(page: Page) {
  await page.addInitScript(() => {
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;

      constructor() {
        super();
        const scope = globalThis as typeof globalThis & { pidexTestSocket?: FakeWebSocket };
        scope.pidexTestSocket = this;
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }

      send() {}

      close() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });
  });
}

async function emitServerEvent(page: Page, event: unknown) {
  await page.evaluate((serverEvent) => {
    const scope = globalThis as typeof globalThis & { pidexTestSocket?: EventTarget };
    scope.pidexTestSocket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(serverEvent) }),
    );
  }, event);
}
