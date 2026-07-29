import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { basename } from "node:path";

test("integrates the application headers with macOS window chrome", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "pidexDesktop", {
      value: {
        usesIntegratedTitleBar: true,
        pickProject: () => Promise.resolve(null),
      },
    });
  });

  await page.goto("/");

  const sidebarTitleBar = page.locator("aside > div").first();
  const mainTitleBar = page.locator("main > header");
  await expect(sidebarTitleBar).toHaveCSS("-webkit-app-region", "drag");
  await expect(sidebarTitleBar).toHaveCSS("height", "52px");
  await expect(sidebarTitleBar).toHaveCSS("padding-left", "80px");
  await expect(mainTitleBar).toHaveCSS("height", "52px");

  const appMark = sidebarTitleBar.locator('img[src="/pidex-icon.png"]');
  const appTitle = sidebarTitleBar.getByText("Pidex", { exact: true });
  const collapseSidebar = page.getByRole("button", { name: "Collapse sidebar" });
  await expect(appMark).toBeVisible();
  const appMarkBox = await appMark.boundingBox();
  const appTitleBox = await appTitle.boundingBox();
  if (!appMarkBox || !appTitleBox) throw new Error("The desktop app identity is not visible");
  if (testInfo.project.name !== "mobile") {
    const collapseSidebarBox = await collapseSidebar.boundingBox();
    if (!collapseSidebarBox) throw new Error("The desktop sidebar control is not visible");
    expect(collapseSidebarBox.x + collapseSidebarBox.width).toBeLessThanOrEqual(appMarkBox.x);
  }
  expect(
    Math.abs(appMarkBox.y + appMarkBox.height / 2 - (appTitleBox.y + appTitleBox.height / 2)),
  ).toBeLessThanOrEqual(1);
  expect(appTitleBox.x).toBeGreaterThanOrEqual(appMarkBox.x + appMarkBox.width + 6);

  await expect(mainTitleBar).toHaveCSS("-webkit-app-region", "drag");
  await expect(page.getByRole("button", { name: "Search projects and tasks" })).toHaveCSS(
    "-webkit-app-region",
    "no-drag",
  );

  if (testInfo.project.name !== "mobile") {
    await collapseSidebar.click();
    const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
    await expect(mainTitleBar).toHaveCSS("padding-left", "80px");
    await expect(expandSidebar).toHaveCSS("-webkit-app-region", "no-drag");
    const expandSidebarBox = await expandSidebar.boundingBox();
    const mainTitleBox = await mainTitleBar.locator("strong").boundingBox();
    if (!expandSidebarBox || !mainTitleBox) throw new Error("The desktop title bar is not visible");
    expect(
      Math.abs(
        expandSidebarBox.y +
          expandSidebarBox.height / 2 -
          (mainTitleBox.y + mainTitleBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    await expandSidebar.click();
  }

  await page.setViewportSize({ width: 800, height: 820 });
  await expect(page.getByRole("button", { name: "Open tasks" })).toBeVisible();
  await expect(mainTitleBar).toHaveCSS("padding-left", "80px");
});

test("collapses and restores the desktop sidebar with keyboard focus", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The mobile sidebar remains a drawer");
  await page.goto("/");

  const sidebar = page.getByRole("complementary", { name: "Tasks" });
  const collapseSidebar = page.getByRole("button", { name: "Collapse sidebar" });
  await expect(sidebar).toBeVisible();
  await collapseSidebar.focus();
  await collapseSidebar.press("Enter");

  await expect(sidebar).toBeHidden();
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expandSidebar).toBeFocused();
  await expandSidebar.press("Enter");
  await expect(sidebar).toBeVisible();
  await expect(collapseSidebar).toBeFocused();
});

test("scales mobile task and composer targets without changing desktop density", async ({
  page,
  request,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspacePath = process.cwd();
  const workspaceName = basename(workspacePath);
  const longTaskName =
    "Investigate an intentionally long task title that must truncate without overflowing";
  const longModelName = "An intentionally long model label for responsive overflow verification";
  let createdSnapshot: { chatId?: string; revision?: number } | undefined;

  const bootstrap = await rpcRequest<{ csrfToken: string; [key: string]: unknown }>(
    request,
    "system/bootstrap",
    {},
  );
  const opened = await rpcRequest<{
    id: string;
    models: Array<{ id: string; [key: string]: unknown }>;
    path: string;
    [key: string]: unknown;
  }>(
    request,
    "workspaces/open",
    { path: workspacePath, remember: false },
    bootstrap.result.csrfToken,
  );
  const workspaceFixture = {
    ...opened.result,
    models: opened.result.models.map((model) => ({ ...model, name: longModelName })),
    sessions: [
      {
        id: "task_mobile_readability",
        name: longTaskName,
        firstMessage: "Verify responsive sizing",
        createdAt: "2026-07-27T00:00:00.000Z",
        modifiedAt: "2026-07-27T00:00:00.000Z",
        messageCount: 2,
      },
    ],
  };

  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await installFakeWebSocket(page);
  await page.addInitScript(({ path }) => localStorage.setItem("pidex:last-project", path), {
    path: workspacePath,
  });
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...bootstrap.result,
          recentWorkspaces: [{ id: opened.result.id, path: workspacePath }],
          projectCandidates: [],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/open", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: workspaceFixture },
    }),
  );
  await page.route("**/api/rpc/chats/create", async (route) => {
    createdSnapshot = {
      chatId: "chat_mobile_readability",
      revision: 0,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...createdSnapshot,
          workspaceId: opened.result.id,
          taskId: "new_task_mobile_readability",
          runStatus: "idle",
          model: opened.result.models[0]?.id,
          thinkingLevel: "high",
          items: [],
          transcriptStart: 0,
          transcriptTotal: 0,
          steeringQueue: [],
          followUpQueue: [],
          stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0 },
        },
      },
    });
  });

  await page.goto("/");
  await openTasks(page);

  const projects = page.getByRole("navigation", { name: "Projects" });
  const projectToggle = page.getByRole("button", { name: `Collapse ${workspaceName}` });
  const taskRow = projects.locator(`button[title="${longTaskName}"]`);
  const addProject = page.locator('button[aria-label="Add project"]');
  const search = page.getByRole("button", { name: "Search projects and tasks" });
  const newTask = page.getByRole("button", { name: `New task in ${workspaceName}` });

  await expect(projectToggle).toHaveCSS("height", mobile ? "40px" : "32px");
  await expect(taskRow).toHaveCSS("height", mobile ? "40px" : "32px");
  await expect(taskRow.locator("time")).toHaveCSS("font-size", mobile ? "10.5px" : "9.5px");
  await expect(addProject).toHaveCSS("width", mobile ? "36px" : "26px");
  await expect(search).toHaveCSS("width", mobile ? "40px" : "34px");
  await expect(newTask).toHaveCSS("width", mobile ? "36px" : "28px");
  if (mobile)
    await expect(page.getByRole("button", { name: "Open tasks" })).toHaveCSS("width", "40px");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(mobile ? 390 : 1440);

  await newTask.click();
  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  await prompt.fill("Keep compact controls readable on narrow screens");

  const model = page.getByLabel("Model");
  const send = page.getByRole("button", { name: "Send" });
  await expect(model).toHaveCSS("font-size", "11px");
  await expect(page.getByTestId("composer-stats")).toHaveCSS(
    "font-size",
    mobile ? "10.5px" : "9.5px",
  );
  await expect(send).toHaveCSS("width", mobile ? "40px" : "34px");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(mobile ? 390 : 1440);

  await expect.poll(() => createdSnapshot?.chatId).toEqual(expect.any(String));
  await emitServerEvent(page, {
    type: "run_status",
    eventId: 1,
    chatId: createdSnapshot?.chatId,
    status: "running",
    revision: (createdSnapshot?.revision ?? 0) + 1,
    run: {
      runId: "run_mobile_readability",
      actionId: "action_mobile_readability",
      status: "running",
      requiresAcknowledgement: false,
    },
  });

  await expect(page.getByRole("button", { name: "Stop" })).toHaveCSS(
    "width",
    mobile ? "38px" : "34px",
  );
  await expect(page.getByRole("button", { name: "Queue" })).toHaveCSS(
    "height",
    mobile ? "38px" : "34px",
  );
  await expect(page.getByLabel("Delivery mode")).toHaveCSS("font-size", mobile ? "11px" : "10.5px");
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

test("renders assistant markdown as safe interactive components", async ({
  context,
  page,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
  await waitForFakeWebSocket(page);

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

  await expect(page.locator('time[datetime="2026-07-27T00:00:00.000Z"]')).toBeVisible();
  await page.getByRole("button", { name: "Copy response" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("# Rendered result");

  await emitServerEvent(page, {
    type: "message",
    eventId: 2,
    chatId,
    item: {
      type: "assistant",
      id: "assistant_invalid_timestamp_e2e",
      text: "Response with a malformed timestamp",
      complete: true,
      timestamp: "not-a-date",
    },
  });

  await expect(
    page.getByText("Response with a malformed timestamp", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('time[datetime="not-a-date"]')).toHaveCount(0);
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
  await waitForFakeWebSocket(page);

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
      state: "error",
      preview: JSON.stringify({
        content: [
          {
            type: "text",
            text: ["one", "two", "three", "four", "five", "six", "seven"].join("\n"),
          },
        ],
      }),
    },
  });

  const hint = page.getByText("earlier lines, click to expand");
  await expect(hint).toContainText("2 earlier lines");
  await expect(page.getByText(/^Took \d+\.\d+s$/)).toBeVisible();
  await expect(page.locator(".tool-call__output")).not.toContainText("one");
  await expect(page.locator(".tool-call__output")).toContainText("seven");
  await expect(page.locator(".tool-call__output")).not.toContainText('"type": "text"');

  await expect(toolBlock).toHaveAttribute("aria-expanded", "false");
  await toolBlock.click();
  await expect(page.locator(".tool-call__output")).toContainText("one");
  await expect(hint).toHaveCount(0);

  await emitServerEvent(page, {
    type: "tool",
    eventId: 3,
    chatId,
    item: {
      ...toolItem,
      id: "tool_running_e2e",
      argumentSummary: JSON.stringify({ command: "sleep 10" }),
      state: "running",
    },
  });

  // A tool whose run was never observed reports no duration rather than a fabricated 0.0s.
  await emitServerEvent(page, {
    type: "tool",
    eventId: 4,
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

  await emitServerEvent(page, {
    type: "tool",
    eventId: 5,
    chatId,
    item: {
      ...toolItem,
      id: "tool_read_e2e",
      name: "read",
      argumentSummary: JSON.stringify({ path: "README.md" }),
      state: "success",
      preview: JSON.stringify({ content: [{ type: "text", text: "project readme" }] }),
    },
  });

  await emitServerEvent(page, {
    type: "tool",
    eventId: 6,
    chatId,
    item: {
      ...toolItem,
      id: "tool_grep_e2e",
      name: "grep",
      argumentSummary: JSON.stringify({ pattern: "TODO", path: "src" }),
      state: "success",
      preview: "no matches",
    },
  });

  const earlierTools = page.getByRole("button", { name: "Show 1 previous tool call" });
  await expect(earlierTools).toBeVisible();
  await expect(toolBlock).toBeVisible();
  await expect(page.getByRole("button", { name: "$ sleep 10" })).toBeVisible();
  await expect(restored).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Read README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Searched TODO · src" })).toBeVisible();
  await earlierTools.click();
  await expect(page.getByRole("button", { name: "Hide 1 previous tool call" })).toBeVisible();
  await expect(restored).toBeVisible();
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
  await waitForFakeWebSocket(page);

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

  await emitServerEvent(page, {
    type: "message",
    eventId: eventId++,
    chatId,
    item: {
      type: "assistant",
      id: "assistant_stream_e2e",
      text: "# Streamed heading\n\nBody text.",
      thinking: "weighing options",
      complete: true,
      timestamp: "2026-07-27T00:00:00.000Z",
    },
  });

  await expect(page.getByText("Thought", { exact: true })).toBeVisible();
  await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
});

test("preserves edits made while slash compaction is pending", async ({
  page,
  request,
}, testInfo) => {
  const workspaceName = basename(process.cwd());
  await installFakeWebSocket(page);
  const { promise: compactionPending, resolve: releaseCompaction } = Promise.withResolvers<void>();
  let compactInput: Record<string, unknown> | undefined;
  let compactRequests = 0;
  let queuedRequests = 0;
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
          commands: Array.from({ length: 24 }, (_, index) => ({
            name: `command-${String(index + 1).padStart(2, "0")}`,
            description: `Workspace command ${index + 1}`,
          })),
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
    compactRequests++;
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
  await page.route("**/api/rpc/chats/sendMessage", async (route) => {
    queuedRequests++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { accepted: false, reason: "Compaction is active" } },
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
  await prompt.fill("/com");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await prompt.press("Shift+Enter");
  await expect(prompt).toHaveValue("/com\n");
  await prompt.fill("/com");
  await prompt.press("Shift+Tab");
  await expect(prompt).toHaveValue("/com");
  await prompt.focus();
  await prompt.fill("/");
  for (let index = 0; index < 18; index++) await prompt.press("ArrowDown");
  const selectedCommand = page
    .getByRole("listbox", { name: "Commands" })
    .getByRole("option", { selected: true });
  await expect(selectedCommand).toBeVisible();
  expect(
    await selectedCommand.evaluate((option) => {
      const list = option.closest('[role="listbox"]');
      if (!list) return false;
      const optionBounds = option.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      return optionBounds.top >= listBounds.top && optionBounds.bottom <= listBounds.bottom;
    }),
  ).toBe(true);
  await prompt.fill("/compact Preserve decisions\nand constraints");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => compactInput?.instructions).toBe("Preserve decisions\nand constraints");
  await emitServerEvent(page, {
    type: "run_status",
    eventId: 1,
    chatId: String(snapshot?.chatId),
    status: "compacting",
    revision: Number(snapshot?.revision),
  });
  await expect(page.getByRole("button", { name: "Queue" })).toBeDisabled();
  if (testInfo.project.name !== "mobile") {
    await prompt.press("Enter");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  expect(compactRequests).toBe(1);
  expect(queuedRequests).toBe(0);

  await prompt.fill("Draft typed while compaction is pending");
  releaseCompaction();
  await expect(page.getByLabel("Context window 10% used")).toBeVisible();
  await expect(prompt).toHaveValue("Draft typed while compaction is pending");

  await prompt.fill(
    "/compact Preserve decisions\nand constraints\nacross multiple sections\nincluding architecture\ntesting strategy\nknown risks\nfollow-up work\nand final outcomes",
  );
  const expandedHeight = await prompt.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => compactRequests).toBe(2);
  await expect(prompt).toHaveValue("");
  await expect
    .poll(() => prompt.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(expandedHeight);

  if (testInfo.project.name !== "mobile") {
    await emitServerEvent(page, {
      type: "run_status",
      eventId: 2,
      chatId: String(snapshot?.chatId),
      status: "idle",
      revision: Number(snapshot?.revision),
      run: {
        runId: "run_requires_acknowledgement",
        actionId: "action_requires_acknowledgement",
        status: "accepted",
        requiresAcknowledgement: true,
      },
    });
    await prompt.fill("/compact");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await prompt.press("Enter");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(compactRequests).toBe(2);
  }
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
  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await page.getByTitle("First task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(first.result.taskId)}`);
  await prompt.fill("/compact");
  const compactResponse = page.waitForResponse("**/api/rpc/chats/compact");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => compactRequested).toBe(true);

  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await prompt.fill("Message for the second task");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByLabel("Context window 20% used")).toBeVisible();
  releaseCompaction();
  await compactResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  await expect(page.getByLabel("Context window 20% used")).toBeVisible();
  await expect(page.getByLabel("Context window 10% used")).toHaveCount(0);
});

test("opens and dismisses context usage details with pointer and keyboard", async ({
  page,
  request,
}, testInfo) => {
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await installFakeWebSocket(page);
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const opened = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: process.cwd() },
    bootstrap.result.csrfToken,
  );
  const created = await rpcRequest<Record<string, unknown>>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    bootstrap.result.csrfToken,
  );
  let snapshot = created.result;
  const taskId = String(snapshot.taskId);

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
  await page.route("**/api/rpc/chats/resume", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    snapshot = {
      ...payload.json,
      model: "e2e/model",
      thinkingLevel: "high",
      contextUsage: {
        tokens: 246_000,
        contextWindow: 258_000,
        percent: 95.34883720930233,
        totalProcessedTokens: 2_500_000,
        compactsAutomatically: true,
      },
    };
    await route.fulfill({ response, json: { ...payload, json: snapshot } });
  });

  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByLabel("Prompt")).toBeVisible();

  await emitServerEvent(page, {
    type: "run_status",
    eventId: 1,
    chatId: String(snapshot?.chatId),
    status: "running",
    revision: 1,
    run: {
      runId: "run_context_usage_e2e",
      actionId: "action_context_usage_e2e",
      status: "running",
      requiresAcknowledgement: false,
    },
  });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const contextMeter = page.getByRole("button", { name: "Context window 95% used" });
  const toggleContextMeter = () =>
    testInfo.project.name === "mobile" ? contextMeter.tap() : contextMeter.click();
  const detailsId = await contextMeter.getAttribute("aria-controls");
  expect(detailsId).toBeTruthy();
  const contextDetails = page.locator(`#${detailsId}`);
  await expect(contextMeter).toHaveAttribute("aria-expanded", "false");
  await expect(contextDetails).toHaveAttribute("aria-hidden", "true");
  await expect(contextDetails).toHaveCSS("opacity", "0");
  await expect(page.locator(".context-meter__progress")).toHaveClass(/--danger/);
  await expect(page.locator(".context-meter__bar-fill")).toHaveClass(/--danger/);

  await toggleContextMeter();
  await expect(contextMeter).toHaveAttribute("aria-expanded", "true");
  await expect(contextDetails).toHaveAttribute("aria-hidden", "false");
  await expect(contextDetails).toHaveCSS("opacity", "1");
  await contextDetails.click();
  await expect(contextMeter).toHaveAttribute("aria-expanded", "true");

  await toggleContextMeter();
  await expect(contextMeter).toHaveAttribute("aria-expanded", "false");
  await expect(contextDetails).toHaveCSS("opacity", "0");

  await toggleContextMeter();
  const outsideX = (page.viewportSize()?.width ?? 400) - 20;
  if (testInfo.project.name === "mobile") await page.touchscreen.tap(outsideX, 120);
  else await page.mouse.click(outsideX, 120);
  await expect(contextMeter).toHaveAttribute("aria-expanded", "false");

  await toggleContextMeter();
  await page.keyboard.press("Control+K");
  const searchInput = page.getByRole("textbox", { name: "Search projects and tasks" });
  await expect(searchInput).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contextMeter).toHaveAttribute("aria-expanded", "false");
  await expect(searchInput).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchInput).toHaveCount(0);
  if (testInfo.project.name === "mobile") await page.keyboard.press("Escape");

  await page.getByLabel("Thinking level").focus();
  await page.keyboard.press("Tab");
  await expect(contextMeter).toBeFocused();
  await expect(contextMeter).toHaveAttribute("aria-expanded", "true");

  if (testInfo.project.name === "chromium") {
    await page.mouse.move(0, 0);
    await contextMeter.hover();
    await page.mouse.move(0, 0);
    await expect(contextMeter).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(contextMeter).toHaveAttribute("aria-expanded", "false");

    await contextMeter.hover();
    await contextMeter.focus();
    await page.keyboard.press("Tab");
    await expect(contextMeter).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(0, 0);
    await expect(contextMeter).toHaveAttribute("aria-expanded", "false");
  } else {
    await page.keyboard.press("Tab");
    await expect(contextMeter).toHaveAttribute("aria-expanded", "false");
  }

  await toggleContextMeter();
  const detailsBox = await contextDetails.boundingBox();
  const viewport = page.viewportSize();
  expect(detailsBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(detailsBox!.x).toBeGreaterThanOrEqual(8);
  expect(detailsBox!.x + detailsBox!.width).toBeLessThanOrEqual(viewport!.width - 8);

  await emitServerEvent(page, {
    type: "run_status",
    eventId: 2,
    chatId: String(snapshot?.chatId),
    status: "idle",
    revision: 2,
  });
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const box = await contextDetails.boundingBox();
      const width = page.viewportSize()?.width;
      return Boolean(box && width && box.x >= 8 && box.x + box.width <= width - 8);
    })
    .toBe(true);
});

test("stages configuration without overwriting the next draft", async ({
  page,
  request,
}, testInfo) => {
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
  const contextUsage = {
    tokens: 87_000,
    contextWindow: 258_000,
    percent: 33.72093023255814,
    totalProcessedTokens: 2_500_000,
    compactsAutomatically: true,
  };
  snapshot = { ...snapshot, contextUsage };
  await emitServerEvent(page, {
    type: "context_usage",
    eventId: 1,
    chatId,
    usage: contextUsage,
  });
  const contextMeter = page.locator(".context-meter__trigger");
  await expect(contextMeter).toBeVisible();
  await expect(contextMeter).toHaveRole("button");
  await expect(contextMeter).toHaveAttribute("aria-label", "Context window 34% used");
  if (testInfo.project.name === "mobile") await contextMeter.focus();
  else await contextMeter.hover();
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
  await expect(contextMeter).toHaveRole("button");
  await expect(page.getByRole("dialog", { name: "Compact this task?" })).toHaveCount(0);

  const stagedThinking = nextThinking === "high" ? "medium" : "high";
  await thinking.selectOption(stagedThinking);
  await expect(page.getByText("Next turn", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);

  await page.getByLabel("Delivery mode").selectOption("steer");
  await prompt.fill("/compact");
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Queue" }).click();
  else await prompt.press("Enter");
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

async function waitForFakeWebSocket(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              pidexTestSocket?: WebSocket;
            }
          ).pidexTestSocket?.readyState,
      ),
    )
    .toBe(1);
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
