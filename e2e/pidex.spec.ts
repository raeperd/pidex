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
    protocolVersion: 3,
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

test("keeps search and new-chat setup in the pre-chat experience", async ({ page, request }) => {
  const startRequests: Array<{ kind: "create" | "configure" | "prompt"; body: unknown }> = [];
  let createdSnapshot: Record<string, unknown> | undefined;
  page.on("request", (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    const body = (browserRequest.postDataJSON() as { json?: unknown } | null)?.json;
    if (path === "/api/rpc/chats/create") startRequests.push({ kind: "create", body });
    else if (path === "/api/rpc/chats/configure") startRequests.push({ kind: "configure", body });
    else if (path === "/api/rpc/chats/sendMessage") startRequests.push({ kind: "prompt", body });
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
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    createdSnapshot = payload.json;
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/rpc/chats/configure", async (route) => {
    if (!createdSnapshot) throw new Error("Expected chat creation before configuration");
    const configuration = (route.request().postDataJSON() as { json: Record<string, unknown> })
      .json;
    createdSnapshot = {
      ...createdSnapshot,
      ...configuration,
      revision: Number(createdSnapshot.revision) + 1,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: createdSnapshot },
    });
  });
  await page.route("**/api/rpc/chats/sendMessage", (route) => route.abort("blockedbyclient"));

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "What should we build in pidex?" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  await expect(page.getByLabel("Tool access")).toBeVisible();

  await openSessions(page);
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search projects and threads" }).click();
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toBeFocused();
  await page.getByRole("button", { name: "Close search" }).click();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search projects and threads" })).toHaveCount(0);

  await page.getByLabel("Prompt").fill("This draft belongs to pidex");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByRole("button", { name: /^(Add|Open) apps$/ }).click();
  await expect(page.getByRole("heading", { name: "What should we build in apps?" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");

  await openSessions(page);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForTimeout(250);
  await expect(page.getByRole("heading", { name: "What should we build in apps?" })).toBeVisible();

  await openSessions(page);
  await page.getByRole("button", { name: "New thread in apps" }).click();
  await page.waitForTimeout(250);
  await expect(page.getByRole("heading", { name: "What should we build in apps?" })).toBeVisible();

  await page.getByLabel("Thinking level").selectOption("high");
  await page.getByLabel("Tool access").selectOption("full");
  await page.getByLabel("Prompt").fill("Verify first prompt configuration");
  await Promise.all([
    page.waitForRequest((browserRequest) =>
      browserRequest.url().endsWith("/api/rpc/chats/sendMessage"),
    ),
    page.getByRole("button", { name: "Send" }).click(),
  ]);

  expect(startRequests.map(({ kind }) => kind)).toEqual(["create", "configure", "prompt"]);
  expect(startRequests[1]?.body).toEqual(
    expect.objectContaining({ model: "e2e/model", thinkingLevel: "high", toolMode: "full" }),
  );
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
