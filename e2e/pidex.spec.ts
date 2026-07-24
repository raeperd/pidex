import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test("serves the Pi host and branded assets", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toEqual({
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

test("keeps search and new-chat setup in the pre-chat experience", async ({ page, request }) => {
  const startRequests: Array<{ kind: "create" | "configure" | "prompt"; body: unknown }> = [];
  let createdSnapshot: Record<string, unknown> | undefined;
  page.on("request", (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    if (browserRequest.method() === "POST" && path === "/api/chats")
      startRequests.push({ kind: "create", body: browserRequest.postDataJSON() });
    else if (browserRequest.method() === "PATCH" && /^\/api\/chats\/[^/]+\/config$/.test(path))
      startRequests.push({ kind: "configure", body: browserRequest.postDataJSON() });
    else if (browserRequest.method() === "POST" && /^\/api\/chats\/[^/]+\/messages$/.test(path))
      startRequests.push({ kind: "prompt", body: browserRequest.postDataJSON() });
  });
  await page.route("**/api/workspaces/open", async (route) => {
    const response = await route.fetch();
    const workspace = (await response.json()) as Record<string, unknown> & {
      models: unknown[];
    };
    await route.fulfill({
      response,
      json: {
        ...workspace,
        models: [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }],
      },
    });
  });
  await page.route("**/api/chats", async (route) => {
    const response = await route.fetch();
    createdSnapshot = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: createdSnapshot });
  });
  await page.route("**/api/chats/*/config", async (route) => {
    if (!createdSnapshot) throw new Error("Expected chat creation before configuration");
    const configuration = route.request().postDataJSON() as Record<string, unknown>;
    createdSnapshot = {
      ...createdSnapshot,
      ...configuration,
      revision: Number(createdSnapshot.revision) + 1,
    };
    await route.fulfill({ status: 200, contentType: "application/json", json: createdSnapshot });
  });
  await page.route("**/api/chats/*/messages", (route) => route.abort("blockedbyclient"));

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
      /\/api\/chats\/[^/]+\/messages$/.test(browserRequest.url()),
    ),
    page.getByRole("button", { name: "Send" }).click(),
  ]);

  expect(startRequests.map(({ kind }) => kind)).toEqual(["create", "configure", "prompt"]);
  expect(startRequests[1]?.body).toEqual(
    expect.objectContaining({ model: "e2e/model", thinkingLevel: "high", toolMode: "full" }),
  );
});

async function rememberWorkspace(request: APIRequestContext, workspacePath: string) {
  const bootstrap = await request.get("/api/bootstrap");
  expect(bootstrap.ok()).toBe(true);
  const { csrfToken } = (await bootstrap.json()) as { csrfToken: string };
  const opened = await request.post("/api/workspaces/open", {
    headers: { "X-Pidex-CSRF": csrfToken },
    data: { path: workspacePath },
  });
  expect(opened.ok()).toBe(true);
}

async function openSessions(page: Page) {
  const button = page.getByRole("button", { name: "Open sessions" });
  if (await button.isVisible()) await button.click();
}
