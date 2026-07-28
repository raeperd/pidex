import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { basename } from "node:path";

test("selects a project and restores it after reload", async ({ page }, testInfo) => {
  const projectName = testInfo.project.name === "mobile" ? "packages" : "apps";

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await expect(projectDialog).toBeVisible();
  await projectDialog.getByRole("textbox", { name: "Filter available projects" }).fill(projectName);
  await projectDialog
    .getByRole("button", { name: new RegExp(`^(Add|Open) ${projectName}$`) })
    .click();

  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pidex:last-project")))
    .toContain(`/${projectName}`);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await openTasks(page);
  await expect(page.getByRole("button", { name: `Collapse ${projectName}` })).toBeVisible();
});

test("manually reorders projects and preserves their order after reload", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "HTML drag and drop is a desktop interaction");
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const csrfToken = bootstrap.result.csrfToken;
  const apps = await rpcRequest<{ id: string; path: string }>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps` },
    csrfToken,
  );
  const packages = await rpcRequest<{ id: string; path: string }>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/packages` },
    csrfToken,
  );
  const remembered = await rpcRequest<{ recentWorkspaces: Array<{ id: string }> }>(
    request,
    "system/bootstrap",
    {},
  );
  const otherIds = remembered.result.recentWorkspaces
    .map(({ id }) => id)
    .filter((id) => id !== apps.result.id && id !== packages.result.id);
  await rpcRequest(
    request,
    "workspaces/reorder",
    { workspaceIds: [apps.result.id, packages.result.id, ...otherIds] },
    csrfToken,
  );

  await page.goto("/");
  await openTasks(page);
  const projects = page.getByRole("navigation", { name: "Projects" });
  const projectOrder = () =>
    projects
      .getByRole("group")
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
  await expect.poll(projectOrder).toEqual(["apps project", "packages project"]);
  await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);

  const packagesRow = page.getByRole("button", { name: /^(Collapse|Expand) packages$/ });
  await packagesRow.focus();
  await packagesRow.press("ArrowUp");
  await expect(packagesRow).toBeFocused();
  await expect.poll(projectOrder).toEqual(["packages project", "apps project"]);
  await expect(page.getByLabel("Add project", { exact: true })).toBeEnabled();
  await packagesRow.press("ArrowDown");
  await expect.poll(projectOrder).toEqual(["apps project", "packages project"]);
  await expect(page.getByLabel("Add project", { exact: true })).toBeEnabled();

  const appsGroup = projects.getByRole("group", { name: "apps project" });
  await packagesRow.evaluate((source) => {
    const target = document.querySelector<HTMLElement>('[aria-label="apps project"]');
    if (!target) throw new Error("Expected apps project target");
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    const targetBounds = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY: targetBounds.top + 1,
        dataTransfer,
      }),
    );
  });
  await expect(appsGroup.locator('[data-project-drop-edge="before"]')).toBeVisible();
  await appsGroup.evaluate((target) => {
    const targetBounds = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY: targetBounds.bottom - 1,
        dataTransfer: new DataTransfer(),
      }),
    );
  });
  await expect(appsGroup.locator('[data-project-drop-edge="after"]')).toBeVisible();
  await packagesRow.dispatchEvent("dragend");

  await packagesRow.dragTo(page.getByRole("button", { name: /^(Collapse|Expand) apps$/ }), {
    targetPosition: { x: 10, y: 1 },
  });

  await expect.poll(projectOrder).toEqual(["packages project", "apps project"]);
  await page.reload();
  await openTasks(page);
  await expect.poll(projectOrder).toEqual(["packages project", "apps project"]);
});

test("moves against the next visible project while filtering", async ({ page, request }) => {
  const bootstrap = await rpcRequest<Record<string, unknown>>(request, "system/bootstrap", {});
  const projects = [
    { id: "workspace_a", path: "/tmp/visible-a" },
    { id: "workspace_b", path: "/tmp/hidden-b" },
    { id: "workspace_c", path: "/tmp/visible-c" },
  ];
  let reorderedIds: string[] = [];
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: projects,
          projectCandidates: [],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/reorder", async (route) => {
    reorderedIds = (route.request().postDataJSON() as { json: { workspaceIds: string[] } }).json
      .workspaceIds;
    const recentWorkspaces = reorderedIds.map((id) => {
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error(`Unexpected workspace ID ${id}`);
      return project;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { recentWorkspaces } },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: "Search projects and tasks" }).click();
  await page.getByRole("textbox", { name: "Search projects and tasks" }).fill("visible");
  await page.getByRole("button", { name: "Expand visible-a" }).press("ArrowDown");

  await expect.poll(() => reorderedIds).toEqual(["workspace_b", "workspace_c", "workspace_a"]);
  const visibleOrder = () =>
    page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("group")
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
  await expect.poll(visibleOrder).toEqual(["visible-c project", "visible-a project"]);
});

test("refreshes stale project membership after a reorder conflict", async ({ page, request }) => {
  const bootstrap = await rpcRequest<Record<string, unknown>>(request, "system/bootstrap", {});
  const initial = [
    { id: "workspace_a", path: "/tmp/project-a" },
    { id: "workspace_b", path: "/tmp/project-b" },
  ];
  const canonical = [
    { id: "workspace_b", path: "/tmp/project-b" },
    { id: "workspace_c", path: "/tmp/project-c" },
  ];
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: bootstrapCalls++ === 0 ? initial : canonical,
          projectCandidates: [],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/reorder", (route) => route.abort("failed"));

  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: "Expand project-a" }).press("ArrowDown");

  const projectOrder = () =>
    page
      .getByRole("navigation", { name: "Projects" })
      .getByRole("group")
      .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
  await expect.poll(projectOrder).toEqual(["project-b project", "project-c project"]);
  expect(bootstrapCalls).toBe(2);
});

test("blocks project additions while saving the manual order", async ({ page, request }) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const apps = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps` },
    bootstrap.result.csrfToken,
  );
  const packages = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/packages` },
    bootstrap.result.csrfToken,
  );
  const remembered = await rpcRequest<{ recentWorkspaces: Array<{ id: string }> }>(
    request,
    "system/bootstrap",
    {},
  );
  const otherIds = remembered.result.recentWorkspaces
    .map(({ id }) => id)
    .filter((id) => id !== apps.result.id && id !== packages.result.id);
  await rpcRequest(
    request,
    "workspaces/reorder",
    { workspaceIds: [apps.result.id, packages.result.id, ...otherIds] },
    bootstrap.result.csrfToken,
  );
  let releaseReorder: (() => void) | undefined;
  const reorderHeld = new Promise<void>((resolve) => {
    releaseReorder = resolve;
  });
  let reorderStarted = false;
  await page.route("**/api/rpc/workspaces/reorder", async (route) => {
    reorderStarted = true;
    await reorderHeld;
    await route.continue();
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: /^(Collapse|Expand) packages$/ }).press("ArrowUp");
  await expect.poll(() => reorderStarted).toBe(true);
  try {
    await expect(page.getByLabel("Add project", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New task in apps" })).toBeDisabled();
  } finally {
    releaseReorder?.();
  }
});

test("reconciles the manual order when adding project 101", async ({ page, request }) => {
  const bootstrap = await rpcRequest<{
    csrfToken: string;
    recentWorkspaces: Array<{ id: string; path: string }>;
    projectCandidates: Array<{ name: string; path: string }>;
  }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `workspace_${String(index).padStart(3, "0")}`,
    path: `${process.cwd()}/apps/project-${String(index).padStart(3, "0")}`,
  }));
  const added = { id: "workspace_new", path: `${process.cwd()}/packages` };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    const recentWorkspaces = bootstrapCalls++ < 2 ? existing : [...existing.slice(1), added];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces,
          projectCandidates: [{ name: "new-project", path: added.path }],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = (route.request().postDataJSON() as { json: { path: string } }).json;
    const remembered = input.path === added.path ? added : existing[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...workspaceTemplate.result,
          ...remembered,
          name: remembered.path.split("/").at(-1),
        },
      },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  await page.getByRole("button", { name: "Add new-project", exact: true }).click();

  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByRole("group")).toHaveCount(100);
  await expect(projects.getByRole("group", { name: "project-000 project" })).toHaveCount(0);
  await expect(projects.getByRole("group", { name: "packages project" })).toBeVisible();
  expect(bootstrapCalls).toBe(3);
});

test("reconciles concurrent project additions after opening a new project", async ({
  page,
  request,
}) => {
  const bootstrap = await rpcRequest<{
    csrfToken: string;
    recentWorkspaces: Array<{ id: string; path: string }>;
    projectCandidates: Array<{ name: string; path: string }>;
  }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const initial = { id: "workspace_initial", path: "/tmp/project-initial" };
  const concurrent = { id: "workspace_concurrent", path: "/tmp/project-concurrent" };
  const added = { id: "workspace_added", path: "/tmp/project-added" };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: bootstrapCalls++ < 2 ? [initial] : [concurrent, added],
          projectCandidates: [{ name: "project-added", path: added.path }],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = (route.request().postDataJSON() as { json: { path: string } }).json;
    const project = input.path === added.path ? added : initial;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...workspaceTemplate.result,
          ...project,
          name: project.path.split("/").at(-1),
        },
      },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  await page.getByRole("button", { name: "Add project-added", exact: true }).click();

  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByRole("group", { name: "project-initial project" })).toHaveCount(0);
  await expect(projects.getByRole("group", { name: "project-concurrent project" })).toBeVisible();
  await expect(projects.getByRole("group", { name: "project-added project" })).toBeVisible();
  expect(bootstrapCalls).toBe(3);
});

test("refreshes membership when reopening a remotely evicted project", async ({
  page,
  request,
}) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const stale = { id: "workspace_stale", path: "/tmp/project-stale" };
  const kept = { id: "workspace_kept", path: "/tmp/project-kept" };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: bootstrapCalls++ === 0 ? [stale] : [kept, stale],
          projectCandidates: [],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...workspaceTemplate.result,
          ...stale,
          name: "project-stale",
        },
      },
    });
  });

  await page.goto("/");
  await openTasks(page);

  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByRole("group", { name: "project-kept project" })).toBeVisible();
  await expect(projects.getByRole("group", { name: "project-stale project" })).toBeVisible();
  expect(bootstrapCalls).toBe(2);
});

test("keeps a successful project open within the history limit when refresh fails", async ({
  page,
  request,
}) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const added = { id: "workspace_added", name: "project-added", path: "/tmp/project-added" };
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `workspace_${String(index).padStart(3, "0")}`,
    path: `/tmp/project-${String(index).padStart(3, "0")}`,
  }));
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    if (bootstrapCalls++ > 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: existing,
          projectCandidates: [{ name: added.name, path: added.path }],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = (route.request().postDataJSON() as { json: { path: string } }).json;
    const project = input.path === added.path ? added : existing[0];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { ...workspaceTemplate.result, ...project } },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await projectDialog.getByRole("button", { name: "Add project-added", exact: true }).click();

  await expect(projectDialog).not.toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Project history could not be refreshed");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pidex:last-project")))
    .toBe(added.path);
  await openTasks(page);
  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByRole("group")).toHaveCount(100);
  await expect(projects.getByRole("group", { name: "project-000 project" })).toBeVisible();
  await expect(projects.getByRole("group", { name: "project-added project" })).toHaveCount(0);
  expect(bootstrapCalls).toBe(3);
});

test("keeps Add all within the 100-project sidebar boundary", async ({ page, request }) => {
  const bootstrap = await rpcRequest<{
    csrfToken: string;
    recentWorkspaces: Array<{ id: string; path: string }>;
    projectCandidates: Array<{ name: string; path: string }>;
  }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const projects = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      id: `workspace_${suffix}`,
      name: `project-${suffix}`,
      path: `${process.cwd()}/apps/project-${suffix}`,
    };
  });
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: bootstrapCalls++ === 0 ? [] : projects.slice(1),
          projectCandidates: projects.map(({ name, path }) => ({ name, path })),
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = (route.request().postDataJSON() as { json: { path: string } }).json;
    const project = projects.find(({ path }) => path === input.path);
    if (!project) throw new Error(`Unexpected project path ${input.path}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { ...workspaceTemplate.result, ...project } },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  await page.getByRole("button", { name: "Add all", exact: true }).click();

  const projectsNav = page.getByRole("navigation", { name: "Projects" });
  await expect(projectsNav.getByRole("group")).toHaveCount(100);
  await expect(projectsNav.getByRole("group", { name: "project-000 project" })).toHaveCount(0);
  await expect(projectsNav.getByRole("group", { name: "project-001 project" })).toBeVisible();
  expect(bootstrapCalls).toBe(2);
});

test("releases Add all controls when history reconciliation fails", async ({ page, request }) => {
  const bootstrap = await rpcRequest<{
    csrfToken: string;
    projectCandidates: Array<{ name: string; path: string }>;
  }>(request, "system/bootstrap", {});
  const workspaceTemplate = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  const added = { id: "workspace_added", name: "project-added", path: "/tmp/project-added" };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    if (bootstrapCalls++ > 0) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: [],
          projectCandidates: [{ name: added.name, path: added.path }],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { ...workspaceTemplate.result, ...added } },
    });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByLabel("Add project", { exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "Add a project" });
  await projectDialog.getByRole("button", { name: "Add all", exact: true }).click();

  await expect(projectDialog.getByRole("button", { name: "Done" })).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("Project history could not be refreshed");
  expect(bootstrapCalls).toBe(2);
});

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
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
});

test("keeps search and task creation in the no-active-task experience", async ({
  page,
  request,
}) => {
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

test("renders assistant markdown as safe interactive components", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  let snapshot: Record<string, unknown> | undefined;
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    snapshot = payload.json;
    await route.fulfill({ response, json: payload });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => snapshot?.chatId).toEqual(expect.any(String));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();

  const chatId = String(snapshot?.chatId);
  await emitServerEvent(page, {
    type: "message",
    eventId: 1,
    chatId,
    item: {
      type: "assistant",
      id: "assistant_markdown_e2e",
      text: `# Rendered result

**Safe Markdown**

Entity text: AT&amp;T &copy;

- [x] component renderer

| Name | State |
| --- | --- |
| Markdown | ready |

\`\`\`ts title="src/example.ts"
const answer = 42;
\`\`\`

<script>globalThis.compromised = true</script>

![tracker](https://tracker.example/pixel.png)

[unsafe](javascript:alert(1))`,
      complete: true,
      timestamp: "2026-07-27T00:00:00.000Z",
    },
  });

  await expect(page.getByRole("heading", { name: "Rendered result" })).toBeVisible();
  await expect(page.getByText("Safe Markdown", { exact: true })).toHaveCSS("font-weight", "700");
  await expect(page.getByText("Entity text: AT&T ©", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Completed task" })).toBeChecked();
  await expect(page.getByRole("listitem").filter({ hasText: "component renderer" })).toHaveText(
    "component renderer",
  );
  await expect(page.getByRole("region", { name: "Scrollable table" })).toContainText(
    "Markdownready",
  );
  await expect(page.getByTitle("src/example.ts")).toBeVisible();
  await expect(page.getByText("const answer = 42;", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wrap lines" }).click();
  await expect(page.getByRole("button", { name: "Disable line wrap" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("<script>globalThis.compromised = true</script>")).toBeVisible();
  await expect(page.getByText("[remote image disabled: tracker]", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  expect(await page.evaluate(() => "compromised" in globalThis)).toBe(false);
});

test("renders tool calls as timed terminal blocks", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  let snapshot: Record<string, unknown> | undefined;
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    snapshot = payload.json;
    await route.fulfill({ response, json: payload });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => snapshot?.chatId).toEqual(expect.any(String));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();

  const chatId = String(snapshot?.chatId);
  const toolItem = {
    type: "tool",
    id: "tool_bash_e2e",
    name: "bash",
    argumentSummary: JSON.stringify({ command: "ls -la" }),
    preview: "",
    truncated: false,
  };
  await emitServerEvent(page, {
    type: "tool",
    eventId: 1,
    chatId,
    item: { ...toolItem, state: "running" },
  });
  const toolBlock = page.getByRole("button", { name: "$ ls -la" });
  await expect(toolBlock).toBeVisible();
  await expect(page.getByText(/^Elapsed \d+\.\d+s$/)).toBeVisible();

  await emitServerEvent(page, {
    type: "tool",
    eventId: 2,
    chatId,
    item: {
      ...toolItem,
      state: "success",
      preview: ["one", "two", "three", "four", "five", "six", "seven"].join("\n"),
    },
  });

  const hint = page.getByText("earlier lines, click to expand");
  await expect(hint).toContainText("2 earlier lines");
  await expect(page.getByText(/^Took \d+\.\d+s$/)).toBeVisible();
  await expect(page.locator(".tool-call__output")).not.toContainText("one");
  await expect(page.locator(".tool-call__output")).toContainText("seven");

  await expect(toolBlock).toHaveAttribute("aria-expanded", "false");
  await toolBlock.click();
  await expect(page.locator(".tool-call__output")).toContainText("one");
  await expect(hint).toHaveCount(0);

  // A tool whose run was never observed reports no duration rather than a fabricated 0.0s.
  await emitServerEvent(page, {
    type: "tool",
    eventId: 3,
    chatId,
    item: {
      ...toolItem,
      id: "tool_restored_e2e",
      argumentSummary: JSON.stringify({ command: "pnpm build" }),
      state: "success",
      preview: "done",
    },
  });
  const restored = page.locator(".tool-call").filter({ hasText: "$ pnpm build" });
  await expect(restored).toBeVisible();
  await expect(restored.locator(".tool-call__timing")).toHaveCount(0);
});

test("batches streamed text deltas without reordering channels", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  let snapshot: Record<string, unknown> | undefined;
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    snapshot = payload.json;
    await route.fulfill({ response, json: payload });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => snapshot?.chatId).toEqual(expect.any(String));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();

  const chatId = String(snapshot?.chatId);
  await emitServerEvent(page, {
    type: "message",
    eventId: 1,
    chatId,
    item: {
      type: "assistant",
      id: "assistant_stream_e2e",
      text: "",
      complete: false,
      timestamp: "2026-07-27T00:00:00.000Z",
    },
  });

  const deltas = [
    ["text", "# Streamed"],
    ["thinking", "weighing "],
    ["text", " heading\n\nBody "],
    ["thinking", "options"],
    ["text", "text."],
  ] as const;
  let eventId = 2;
  for (const [channel, delta] of deltas) {
    await emitServerEvent(page, {
      type: "text_delta",
      eventId: eventId++,
      chatId,
      itemId: "assistant_stream_e2e",
      channel,
      delta,
    });
  }

  // Every delta lands in order even though a frame batches several of them together.
  await expect(page.getByRole("heading", { name: "Streamed heading" })).toBeVisible();
  await expect(page.getByText("Body text.", { exact: true })).toBeVisible();
  await page.getByText("Thinking", { exact: true }).click();
  await expect(page.locator("details pre")).toHaveText("weighing options");
});

test("preserves edits made while slash compaction is pending", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  const { promise: compactionPending, resolve: releaseCompaction } = Promise.withResolvers<void>();
  let compactInput: Record<string, unknown> | undefined;
  let snapshot: Record<string, unknown> | undefined;

  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        ...payload,
        json: {
          ...payload.json,
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
  await page.route("**/api/rpc/chats/compact", async (route) => {
    if (!snapshot) throw new Error("Expected a chat before compaction");
    compactInput = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    await compactionPending;
    snapshot = {
      ...snapshot,
      revision: Number(compactInput.expectedRevision) + 1,
      contextUsage: {
        tokens: 10,
        contextWindow: 100,
        percent: 10,
        totalProcessedTokens: 10,
        compactsAutomatically: true,
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: snapshot },
    });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());

  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  await prompt.fill("/compact Preserve decisions\nand constraints");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => compactInput?.instructions).toBe("Preserve decisions\nand constraints");

  await prompt.fill("Draft typed while compaction is pending");
  releaseCompaction();
  await expect(
    page.getByRole("button", { name: "Compact task (context window 10% used)" }),
  ).toBeVisible();
  await expect(prompt).toHaveValue("Draft typed while compaction is pending");
});

test("ignores compact responses after navigating to another task", async ({ page, request }) => {
  await installFakeWebSocket(page);
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const opened = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: process.cwd() },
    bootstrap.result.csrfToken,
  );
  const first = await rpcRequest<Record<string, unknown>>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    bootstrap.result.csrfToken,
  );
  const second = await rpcRequest<Record<string, unknown>>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    bootstrap.result.csrfToken,
  );
  const now = new Date().toISOString();
  const sessions = [
    {
      id: String(first.result.taskId),
      name: "First task",
      firstMessage: "",
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
    },
    {
      id: String(second.result.taskId),
      name: "Second task",
      firstMessage: "",
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
    },
  ];
  const secondUsage = {
    tokens: 20,
    contextWindow: 100,
    percent: 20,
    totalProcessedTokens: 20,
    compactsAutomatically: true,
  };
  const { promise: compactionPending, resolve: releaseCompaction } = Promise.withResolvers<void>();
  let compactRequested = false;

  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    if (payload.json.id !== opened.result.id) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({
      response,
      json: {
        ...payload,
        json: {
          ...payload.json,
          sessions,
          models: [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/sessions", async (route) => {
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    if (input.workspaceId !== opened.result.id) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { sessions } },
    });
  });
  await page.route("**/api/rpc/chats/resume", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    await route.fulfill({
      response,
      json: {
        ...payload,
        json:
          input.taskId === second.result.taskId
            ? { ...payload.json, contextUsage: secondUsage }
            : payload.json,
      },
    });
  });
  await page.route("**/api/rpc/chats/compact", async (route) => {
    compactRequested = true;
    await compactionPending;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...first.result,
          revision: Number(first.result.revision) + 1,
          contextUsage: { ...secondUsage, tokens: 10, percent: 10, totalProcessedTokens: 10 },
        },
      },
    });
  });

  await page.goto(`/tasks/${String(first.result.taskId)}`);
  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  await prompt.fill("/compact");
  const compactResponse = page.waitForResponse("**/api/rpc/chats/compact");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => compactRequested).toBe(true);

  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await expect(
    page.getByRole("button", { name: "Compact task (context window 20% used)" }),
  ).toBeVisible();
  releaseCompaction();
  await compactResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  await expect(
    page.getByRole("button", { name: "Compact task (context window 20% used)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compact task (context window 10% used)" }),
  ).toHaveCount(0);
});

test("stages configuration without overwriting the next draft", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  const mutations: Array<{ procedure: "configure" | "send"; input: Record<string, unknown> }> = [];
  const { promise: configurationPending, resolve: releaseConfiguration } =
    Promise.withResolvers<void>();
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
    await configurationPending;
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
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());

  const prompt = page.getByLabel("Prompt");
  const thinking = page.getByLabel("Thinking level");
  await expect(prompt).toBeVisible();

  const chatId = String(snapshot?.chatId);
  await emitServerEvent(page, {
    type: "context_usage",
    eventId: 1,
    chatId,
    usage: {
      tokens: 87_000,
      contextWindow: 258_000,
      percent: 33.72093023255814,
      totalProcessedTokens: 2_500_000,
      compactsAutomatically: true,
    },
  });
  const contextMeter = page.getByRole("button", { name: "Context window 34% used" });
  await expect(contextMeter).toBeVisible();
  await contextMeter.hover();
  const contextDetails = page.getByRole("tooltip");
  await expect(contextDetails).toHaveCSS("opacity", "1");
  await expect(contextDetails).toContainText("Context Window");
  await expect(contextDetails).toContainText("34% · 87k/258k");
  await expect(contextDetails).toContainText("Total processed2.5m");
  await expect(contextDetails).toContainText("Pi automatically compacts its context when needed.");
  await expect(contextDetails.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");

  const nextThinking = (await thinking.inputValue()) === "high" ? "low" : "high";
  await thinking.selectOption(nextThinking);
  await expect(page.getByText("Next turn", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);

  await prompt.fill("Start the first turn");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => mutations.map(({ procedure }) => procedure)).toEqual(["configure"]);
  await prompt.fill("Draft the next turn while configuration is pending");
  releaseConfiguration();
  await expect
    .poll(() => mutations.map(({ procedure }) => procedure))
    .toEqual(["configure", "send"]);
  expect(mutations[0]?.input).toEqual(expect.objectContaining({ thinkingLevel: nextThinking }));
  expect(mutations[1]?.input).toEqual(expect.objectContaining({ delivery: "normal" }));
  await expect(page.getByText("Next turn", { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue("Draft the next turn while configuration is pending");

  mutations.length = 0;
  await emitServerEvent(page, {
    type: "run_status",
    eventId: 2,
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
  await prompt.fill("/compact");
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
    eventId: 3,
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
  return { response, result: ((await response.json()) as { json: T }).json };
}

async function openTasks(page: Page) {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 900) {
    const button = page.getByRole("button", { name: "Open tasks" });
    await expect(button).toBeVisible();
    await button.click();
  }
  await expect(page.getByLabel("Add project", { exact: true })).toBeInViewport();
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
