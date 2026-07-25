import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test("selects a project and restores it after reload", async ({ page }, testInfo) => {
  const projectName = testInfo.project.name === "mobile" ? "packages" : "apps";

  await page.goto("/");
  await openSessions(page);
  await page.getByLabel("Add project", { exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("textbox", { name: "Filter available projects" }).fill(projectName);
  await projectDialog
    .getByRole("button", { name: new RegExp(`^(Add|Open) ${projectName}$`) })
    .click();

  await expect(
    page.getByRole("heading", { name: `What should we build in ${projectName}?` }),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pidex:last-project")))
    .toContain(`/${projectName}`);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: `What should we build in ${projectName}?` }),
  ).toBeVisible();
  await openSessions(page);
  await expect(page.getByRole("button", { name: `Collapse ${projectName}` })).toBeVisible();
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
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await projectDialog.getByRole("button", { name: /^(Add|Open) apps$/ }).click();
  await expect(page.getByRole("heading", { name: "What should we build in apps?" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("");

  await page.getByLabel("Prompt").fill("Reset this global draft");
  await openSessions(page);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByLabel("Prompt")).toBeEmpty();
  await expect(page.getByLabel("Prompt")).toBeFocused();

  await page.getByLabel("Prompt").fill("Reset this project draft");
  await openSessions(page);
  await page.getByRole("button", { name: "New thread in apps" }).click();
  await expect(page.getByLabel("Prompt")).toBeEmpty();
  await expect(page.getByLabel("Prompt")).toBeFocused();

  await page.getByLabel("Thinking level").selectOption("high");
  await page.getByLabel("Tool access").selectOption("full");
  const prompt = "Verify first prompt configuration";
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByLabel("Prompt")).toHaveValue(prompt);
  await expect(page.getByRole("alert")).toBeVisible();
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
  return { response, result: ((await response.json()) as { json: T }).json };
}

async function openSessions(page: Page) {
  const button = page.getByRole("button", { name: "Open sessions" });
  if (await button.isVisible()) await button.click();
}
