import { expect, test } from "@playwright/test";
import { openTasks, rememberWorkspace, rpcRequest } from "./support";

test("retries a deep-linked task without replacing its route", async ({ page, request }) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const opened = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: process.cwd() },
    bootstrap.result.csrfToken,
  );
  const created = await rpcRequest<{ taskId: string }>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    bootstrap.result.csrfToken,
  );
  const taskPath = `/tasks/${created.result.taskId}`;
  let failBootstrap = true;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    if (failBootstrap) {
      failBootstrap = false;
      await route.abort("failed");
    } else await route.continue();
  });

  await page.goto(taskPath);
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  await page.getByRole("button", { name: "Retry connection" }).click();

  await expect(page).toHaveURL(taskPath);
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.locator("main > header")).toHaveCount(0);
});

test("keeps search and task creation in the no-active-task experience", async ({
  page,
  request,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "pidexDesktop", {
      value: {
        usesIntegratedTitleBar: true,
        pickProject: () => Promise.resolve(null),
      },
    });
  });
  const createRequests: unknown[] = [];
  const taskCreationRequests: string[] = [];
  const workspaceOpenRequests: Array<{ path: string; remember?: boolean }> = [];
  page.on("request", (browserRequest) => {
    const path = new URL(browserRequest.url()).pathname;
    const body = (browserRequest.postDataJSON() as { json?: unknown } | null)?.json;
    if (browserRequest.method() === "POST" && path === "/api/rpc/chats/create")
      createRequests.push(body);
    if (
      browserRequest.method() === "POST" &&
      path === "/api/rpc/workspaces/open" &&
      body &&
      typeof body === "object" &&
      "path" in body
    )
      workspaceOpenRequests.push(body as { path: string; remember?: boolean });
    if (
      browserRequest.method() === "POST" &&
      (path === "/api/rpc/workspaces/open" || path === "/api/rpc/chats/create")
    )
      taskCreationRequests.push(path);
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
          resourceDiagnostics: [{ level: "warning", message: "E2E resource warning" }],
        },
      },
    });
  });
  await rememberWorkspace(request, process.cwd());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await expect(page.getByText("No active task", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await expect(page.getByLabel("Thinking level")).toHaveCount(0);

  await openTasks(page);
  await expect(page.getByRole("textbox", { name: "Search projects and tasks" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search projects and tasks" }).click();
  await expect(page.getByRole("textbox", { name: "Search projects and tasks" })).toBeFocused();
  await page.getByRole("button", { name: "Close search" }).click();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("textbox", { name: "Search projects and tasks" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Search projects and tasks" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await projectDialog.getByRole("button", { name: /^(Add|Open) apps$/ }).click();
  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);

  await openTasks(page);
  taskCreationRequests.length = 0;
  await Promise.all([
    page.waitForRequest(
      (browserRequest) =>
        browserRequest.method() === "POST" &&
        new URL(browserRequest.url()).pathname === "/api/rpc/chats/create",
    ),
    page.getByRole("button", { name: "New task in apps" }).click(),
  ]);

  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toHaveCount(0);
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeFocused();
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  await expect(page.locator("main > header")).toHaveCount(0);
  const topControl =
    testInfo.project.name === "mobile"
      ? page.getByRole("button", { name: "Open tasks" })
      : page.locator("main > .window-drag-region");
  const resourceWarning = page.getByRole("status").filter({ hasText: "E2E resource warning" });
  await expect(topControl).toBeVisible();
  await expect(resourceWarning).toBeVisible();
  const topControlBox = await topControl.boundingBox();
  const resourceWarningBox = await resourceWarning.boundingBox();
  if (!topControlBox || !resourceWarningBox) throw new Error("Expected visible new-task chrome");
  expect(resourceWarningBox.y).toBeGreaterThanOrEqual(topControlBox.y + topControlBox.height);
  if (testInfo.project.name !== "mobile") {
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(page.locator("main > header")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  }
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]).toEqual(expect.objectContaining({ workspaceId: expect.any(String) }));
  expect(taskCreationRequests).toEqual(["/api/rpc/workspaces/open", "/api/rpc/chats/create"]);
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);

  const taskUrl = page.url();
  const otherWorkspacePath = `${process.cwd()}/packages`;
  await rememberWorkspace(request, otherWorkspacePath);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.getByLabel("Prompt")).toBeVisible();

  await page.evaluate(
    (path) => localStorage.setItem("pidex:last-project", path),
    otherWorkspacePath,
  );
  workspaceOpenRequests.length = 0;
  await page.reload();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect.poll(() => workspaceOpenRequests.length).toBeGreaterThan(0);
  expect(workspaceOpenRequests).toContainEqual({ path: `${process.cwd()}/apps`, remember: true });
});
