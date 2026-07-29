import { expect, test } from "@playwright/test";
import { openTasks, rpcRequest } from "./support";

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
  const projectOrder = async () =>
    (
      await projects
        .getByRole("group")
        .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")))
    ).filter((label) => label === "apps project" || label === "packages project");
  await expect.poll(projectOrder).toEqual(["apps project", "packages project"]);
  await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);

  const packagesRow = page.getByRole("button", { name: /^(Collapse|Expand) packages$/ });
  await packagesRow.focus();
  await packagesRow.press("ArrowUp");
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
