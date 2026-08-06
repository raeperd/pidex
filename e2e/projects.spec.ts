import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createTask,
  fulfillJson,
  installFakeWebSocket,
  openTasks,
  rememberWorkspace,
  routeInput,
  rpcRequest,
  workspaceName,
} from "./support";

test("keeps the starter home visible before a project is selected", async ({ page, request }) => {
  const bootstrap = await rpcRequest<Record<string, unknown>>(request, "system/bootstrap", {});
  await page.route("**/api/rpc/system/bootstrap", (route) =>
    fulfillJson(route, { ...bootstrap.result, recentWorkspaces: [] }),
  );

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Choose a project to start" })).toBeVisible();
  await expect(page.getByTestId("starter-composer")).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeDisabled();
  await expect(page.getByLabel("Model")).toBeDisabled();
  await expect(page.getByLabel("Thinking level")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.getByRole("button", { name: "Choose a project to start" }).click();
  await expect(page.getByRole("dialog", { name: "Add a project" })).toBeVisible();
});

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

  await expect(
    page.getByRole("heading", { name: `What should we work on in ${projectName}?` }),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.getByLabel("Model")).toBeVisible();
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pidex:last-project")))
    .toContain(`/${projectName}`);

  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("status", { name: "Loading project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bring Pi with you." })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: `What should we work on in ${projectName}?` }),
  ).toBeVisible();
  await openTasks(page);
  await expect(page.getByRole("button", { name: `Collapse ${projectName}` })).toBeVisible();
});

test("groups worktree tasks under their source project", async ({ page, request }) => {
  const bootstrap = await rpcRequest<Record<string, unknown>>(request, "system/bootstrap", {});
  const csrfToken = String(bootstrap.result.csrfToken);
  const source = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: process.cwd(), remember: false },
    csrfToken,
  );
  const sourceWorkspaceId = String(source.result.id);
  const sourcePath = String(source.result.path);
  const worktreeWorkspaceId = "grouped_worktree_e2e";
  const worktreePath = `${process.cwd()}/.pidex-grouped-worktree`;
  const sourceProject = {
    id: sourceWorkspaceId,
    path: sourcePath,
    worktree: false,
    worktreeSupport: "supported",
  };
  const worktreeProject = {
    id: worktreeWorkspaceId,
    path: worktreePath,
    sourceWorkspaceId,
    worktree: true,
    worktreeSupport: "supported",
  };
  let recentWorkspaces: Record<string, unknown>[] = [sourceProject, worktreeProject];
  const openedPaths: string[] = [];
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap.result,
      recentWorkspaces,
      projectCandidates: [],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = routeInput<{ path: string }>(route);
    openedPaths.push(input.path);
    const worktree = input.path === worktreePath;
    await fulfillJson(route, {
      ...source.result,
      id: worktree ? worktreeWorkspaceId : sourceWorkspaceId,
      path: worktree ? worktreePath : sourcePath,
      sessions: worktree
        ? [
            {
              id: "worktree_task_e2e",
              name: "Worktree task",
              firstMessage: "Worktree task",
              createdAt: "2026-07-28T00:00:00.000Z",
              modifiedAt: "2026-07-29T00:00:00.000Z",
              messageCount: 1,
            },
          ]
        : Array.from({ length: 6 }, (_, index) => ({
            id: `local_task_e2e_${index}`,
            name: index === 0 ? "Local task" : `Older local task ${index}`,
            firstMessage: index === 0 ? "Local task" : `Older local task ${index}`,
            createdAt: "2026-07-27T00:00:00.000Z",
            modifiedAt: `2026-07-28T${String(6 - index).padStart(2, "0")}:00:00.000Z`,
            messageCount: 1,
          })),
    });
  });

  await page.goto("/");
  await openTasks(page);

  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByRole("group")).toHaveCount(1);
  const localTask = projects.getByRole("button", { name: /Local task/ });
  const worktreeTask = projects.getByRole("button", { name: /Worktree task/ });
  await expect(localTask).toBeVisible();
  await expect(worktreeTask).toBeVisible();
  await expect(localTask.locator("[data-worktree-indicator]")).toHaveCount(0);
  await expect(worktreeTask.locator("[data-worktree-indicator]")).toBeVisible();

  openedPaths.length = 0;
  await page.evaluate(({ path }) => localStorage.setItem("pidex:last-project", path), {
    path: worktreePath,
  });
  await page.reload();
  await expect.poll(() => openedPaths).toEqual(expect.arrayContaining([worktreePath, sourcePath]));

  recentWorkspaces = [worktreeProject];
  await page.reload();
  await openTasks(page);
  await expect(projects.getByRole("group")).toHaveCount(1);
  await expect(projects.getByText("Worktree task", { exact: true })).toBeVisible();
});

test("keeps a departed task's sidebar status correct when session-list responses complete out of order", async ({
  page,
  request,
}) => {
  // Regression test for a race in AppShell's `refreshSessions()`: navigating away from a
  // running task fires a listing refresh for its workspace, and the bounded polling
  // mitigation can fire more while a task keeps running. These requests can complete in a
  // different order than they were issued. Without a per-workspace sequence guard, whichever
  // response happens to RESOLVE last wins the cache write -- so a slow, early-issued response
  // that still says "running" can silently revert a faster, later-issued response that
  // correctly observed the task had gone idle.
  await installFakeWebSocket(page);
  const { csrfToken, workspace, task: taskA } = await createTask(request, process.cwd());
  const taskB = await rpcRequest<Record<string, unknown> & { taskId: string }>(
    request,
    "chats/create",
    { workspaceId: workspace.id },
    csrfToken,
  );
  const now = new Date().toISOString();
  const sessionsWithTaskAStatus = (status: "running" | "idle") => [
    {
      id: String(taskA.taskId),
      name: "Race task A",
      firstMessage: "Race task A",
      createdAt: now,
      modifiedAt: now,
      messageCount: 1,
      status,
    },
    {
      id: String(taskB.taskId),
      name: "Race task B",
      firstMessage: "Race task B",
      createdAt: now,
      modifiedAt: now,
      messageCount: 1,
      status: "idle",
    },
  ];

  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    if (payload.json.id !== workspace.id) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({
      response,
      json: { ...payload, json: { ...payload.json, sessions: sessionsWithTaskAStatus("idle") } },
    });
  });

  let sessionsCalls = 0;
  await page.route("**/api/rpc/workspaces/sessions", async (route) => {
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    if (input.workspaceId !== workspace.id) {
      await route.continue();
      return;
    }
    sessionsCalls += 1;
    if (sessionsCalls === 1) {
      // Issued first (task A still reads "running" at this point) but slow to resolve --
      // real network responses can complete out of issue order.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fulfillJson(route, { sessions: sessionsWithTaskAStatus("running") });
      return;
    }
    // Every later refresh is issued after task A actually went idle, and resolves promptly --
    // and, without the sequence guard, would land and then be overwritten by call #1 above.
    await fulfillJson(route, { sessions: sessionsWithTaskAStatus("idle") });
  });

  // Navigate via "/" and UI clicks (like every sibling test in this file), not a direct
  // goto("/tasks/...") -- the latter races the app's own onMount project-restore against
  // activateRoute's handling of the direct task route and can land on the wrong project.
  await page.goto("/");
  await openTasks(page);
  const taskARow = page.getByRole("button", { name: /Race task A/ });
  const taskBRow = page.getByRole("button", { name: /Race task B/ });
  // The project may already be auto-restored and expanded (it's the workspace this whole
  // e2e run operates in, so it's very likely the most-recently-remembered one) -- only expand
  // it if it isn't already, since toggling an already-expanded project collapses it instead.
  if (!(await taskBRow.isVisible()))
    await page
      .getByRole("button", { name: `Expand ${workspaceName}` })
      .evaluate((button: HTMLButtonElement) => button.click());
  await expect(taskBRow).toBeVisible();
  await taskARow.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(taskA.taskId)}`);

  // Navigate away from A (issues the slow call #1 for A's workspace), then bounce back and
  // away again fast enough that calls #2 and #3 are both issued -- and resolved -- before
  // call #1's artificial delay elapses.
  await taskBRow.evaluate((button: HTMLButtonElement) => button.click());
  await taskARow.evaluate((button: HTMLButtonElement) => button.click());
  await taskBRow.evaluate((button: HTMLButtonElement) => button.click());

  await expect.poll(() => sessionsCalls).toBeGreaterThanOrEqual(2);
  // Give call #1's 400ms delay time to resolve after the faster calls already landed.
  await page.waitForTimeout(500);
  await expect(taskARow.getByText("Working")).toBeHidden();
  await expect(taskARow.locator("time")).toBeVisible();
});

test("manually reorders projects and preserves their order after reload", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "HTML drag and drop is a desktop interaction");
  await rememberOrderedProjects(request);

  await page.goto("/");
  await openTasks(page);
  const projects = page.getByRole("navigation", { name: "Projects" });
  const projectOrder = async () =>
    (await projectLabels(page)).filter(
      (label) => label === "apps project" || label === "packages project",
    );
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
    { id: "workspace_a", path: "/tmp/visible-a", worktreeSupport: "supported" },
    { id: "workspace_b", path: "/tmp/hidden-b", worktreeSupport: "supported" },
    { id: "workspace_c", path: "/tmp/visible-c", worktreeSupport: "supported" },
  ];
  let reorderedIds: string[] = [];
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap.result,
      recentWorkspaces: projects,
      projectCandidates: [],
    });
  });
  await page.route("**/api/rpc/workspaces/reorder", async (route) => {
    reorderedIds = routeInput<{ workspaceIds: string[] }>(route).workspaceIds;
    const recentWorkspaces = reorderedIds.map((id) => {
      const project = projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error(`Unexpected workspace ID ${id}`);
      return project;
    });
    await fulfillJson(route, { recentWorkspaces });
  });

  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: "Search projects and tasks" }).click();
  await page.getByRole("textbox", { name: "Search projects and tasks" }).fill("visible");
  await page.getByRole("button", { name: "Expand visible-a" }).press("ArrowDown");

  await expect.poll(() => reorderedIds).toEqual(["workspace_b", "workspace_c", "workspace_a"]);
  await expect.poll(() => projectLabels(page)).toEqual(["visible-c project", "visible-a project"]);
});

test("refreshes stale project membership after a reorder conflict", async ({ page, request }) => {
  const bootstrap = await rpcRequest<Record<string, unknown>>(request, "system/bootstrap", {});
  const initial = [
    { id: "workspace_a", path: "/tmp/project-a", worktreeSupport: "supported" },
    { id: "workspace_b", path: "/tmp/project-b", worktreeSupport: "supported" },
  ];
  const canonical = [
    { id: "workspace_b", path: "/tmp/project-b", worktreeSupport: "supported" },
    { id: "workspace_c", path: "/tmp/project-c", worktreeSupport: "supported" },
  ];
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap.result,
      recentWorkspaces: bootstrapCalls++ === 0 ? initial : canonical,
      projectCandidates: [],
    });
  });
  await page.route("**/api/rpc/workspaces/reorder", (route) => route.abort("failed"));

  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: "Expand project-a" }).press("ArrowDown");

  await expect.poll(() => projectLabels(page)).toEqual(["project-b project", "project-c project"]);
  expect(bootstrapCalls).toBe(2);
});

test("blocks project additions while saving the manual order", async ({ page, request }) => {
  await rememberOrderedProjects(request);
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `workspace_${String(index).padStart(3, "0")}`,
    path: `${process.cwd()}/apps/project-${String(index).padStart(3, "0")}`,
    worktreeSupport: "supported",
  }));
  const added = {
    id: "workspace_new",
    path: `${process.cwd()}/packages`,
    worktreeSupport: "supported",
  };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    const recentWorkspaces = bootstrapCalls++ < 2 ? existing : [...existing.slice(1), added];
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces,
      projectCandidates: [{ name: "new-project", path: added.path }],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = routeInput<{ path: string }>(route);
    const remembered = input.path === added.path ? added : existing[0];
    await fulfillJson(route, {
      ...template,
      ...remembered,
      name: remembered.path.split("/").at(-1),
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const initial = {
    id: "workspace_initial",
    path: "/tmp/project-initial",
    worktreeSupport: "supported",
  };
  const concurrent = {
    id: "workspace_concurrent",
    path: "/tmp/project-concurrent",
    worktreeSupport: "supported",
  };
  const added = { id: "workspace_added", path: "/tmp/project-added", worktreeSupport: "supported" };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces: bootstrapCalls++ < 2 ? [initial] : [concurrent, added],
      projectCandidates: [{ name: "project-added", path: added.path }],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = routeInput<{ path: string }>(route);
    const project = input.path === added.path ? added : initial;
    await fulfillJson(route, {
      ...template,
      ...project,
      name: project.path.split("/").at(-1),
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const stale = { id: "workspace_stale", path: "/tmp/project-stale", worktreeSupport: "supported" };
  const kept = { id: "workspace_kept", path: "/tmp/project-kept", worktreeSupport: "supported" };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces: bootstrapCalls++ === 0 ? [stale] : [kept, stale],
      projectCandidates: [],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    await fulfillJson(route, {
      ...template,
      ...stale,
      name: "project-stale",
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const added = {
    id: "workspace_added",
    name: "project-added",
    path: "/tmp/project-added",
    worktreeSupport: "supported",
  };
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `workspace_${String(index).padStart(3, "0")}`,
    path: `/tmp/project-${String(index).padStart(3, "0")}`,
    worktreeSupport: "supported",
  }));
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    if (bootstrapCalls++ > 1) {
      await route.abort("failed");
      return;
    }
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces: existing,
      projectCandidates: [{ name: added.name, path: added.path }],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = routeInput<{ path: string }>(route);
    const project = input.path === added.path ? added : existing[0];
    await fulfillJson(route, { ...template, ...project });
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const projects = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      id: `workspace_${suffix}`,
      name: `project-${suffix}`,
      path: `${process.cwd()}/apps/project-${suffix}`,
      worktreeSupport: "supported",
    };
  });
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces: bootstrapCalls++ === 0 ? [] : projects.slice(1),
      projectCandidates: projects.map(({ name, path }) => ({ name, path })),
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const input = routeInput<{ path: string }>(route);
    const project = projects.find(({ path }) => path === input.path);
    if (!project) throw new Error(`Unexpected project path ${input.path}`);
    await fulfillJson(route, { ...template, ...project });
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
  const { bootstrap, template } = await openWorkspaceTemplate(request);
  const added = {
    id: "workspace_added",
    name: "project-added",
    path: "/tmp/project-added",
    worktreeSupport: "supported",
  };
  let bootstrapCalls = 0;
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    if (bootstrapCalls++ > 0) {
      await route.abort("failed");
      return;
    }
    await fulfillJson(route, {
      ...bootstrap,
      recentWorkspaces: [],
      projectCandidates: [{ name: added.name, path: added.path }],
    });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    await fulfillJson(route, { ...template, ...added });
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

async function openWorkspaceTemplate(request: APIRequestContext) {
  const bootstrap = await rpcRequest<{
    csrfToken: string;
    recentWorkspaces: Array<{ id: string; path: string }>;
    projectCandidates: Array<{ name: string; path: string }>;
  }>(request, "system/bootstrap", {});
  const template = await rpcRequest<Record<string, unknown>>(
    request,
    "workspaces/open",
    { path: `${process.cwd()}/apps`, remember: false },
    bootstrap.result.csrfToken,
  );
  return {
    bootstrap: bootstrap.result,
    csrfToken: bootstrap.result.csrfToken,
    template: template.result,
  };
}

async function rememberOrderedProjects(request: APIRequestContext) {
  const { csrfToken, workspace: apps } = await rememberWorkspace(request, `${process.cwd()}/apps`);
  const { workspace: packages } = await rememberWorkspace(request, `${process.cwd()}/packages`);
  const remembered = await rpcRequest<{ recentWorkspaces: Array<{ id: string }> }>(
    request,
    "system/bootstrap",
    {},
  );
  const otherIds = remembered.result.recentWorkspaces
    .map(({ id }) => id)
    .filter((id) => id !== apps.id && id !== packages.id);
  await rpcRequest(
    request,
    "workspaces/reorder",
    { workspaceIds: [apps.id, packages.id, ...otherIds] },
    csrfToken,
  );
}

function projectLabels(page: Page) {
  return page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("group")
    .evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")));
}
