import { expect, test } from "@playwright/test";
import { basename } from "node:path";
import {
  emitServerEvent,
  installFakeWebSocket,
  openTasks,
  rememberWorkspace,
  rpcRequest,
  waitForFakeWebSocket,
} from "./support";

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

test("creates, navigates, and durably submits the first starter prompt", async ({
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
  const starterRequests: string[] = [];
  const mutations: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  const workspaceOpenRequests: Array<{ path: string; remember?: boolean }> = [];
  const { promise: creationPending, resolve: releaseCreation } = Promise.withResolvers<void>();
  let initialTaskSnapshot: Record<string, unknown> | undefined;
  let taskSnapshot: Record<string, unknown> | undefined;
  let connectedDuringConfiguration: boolean | undefined;
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
      [
        "/api/rpc/workspaces/open",
        "/api/rpc/chats/create",
        "/api/rpc/chats/configure",
        "/api/rpc/chats/sendMessage",
      ].includes(path)
    )
      starterRequests.push(path);
  });
  await installFakeWebSocket(page);
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
          models:
            workspace.path === `${process.cwd()}/apps`
              ? [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }]
              : [],
          resourceDiagnostics: [{ level: "warning", message: "E2E resource warning" }],
        },
      },
    });
  });
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    taskSnapshot = { ...payload.json, model: "e2e/model", thinkingLevel: "medium" };
    initialTaskSnapshot = { ...taskSnapshot };
    await creationPending;
    await route.fulfill({ response, json: { ...payload, json: taskSnapshot } });
  });
  await page.route("**/api/rpc/chats/configure", async (route) => {
    if (!taskSnapshot) throw new Error("Expected the starter to create a task first");
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    mutations.push({ procedure: "configure", input });
    taskSnapshot = {
      ...taskSnapshot,
      thinkingLevel: input.thinkingLevel,
      revision: Number(input.expectedRevision) + 1,
    };
    connectedDuringConfiguration = await page.evaluate(() =>
      Boolean((globalThis as typeof globalThis & { pidexTestSocket?: WebSocket }).pidexTestSocket),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: taskSnapshot },
    });
  });
  await page.route("**/api/rpc/chats/sendMessage", async (route) => {
    if (!taskSnapshot) throw new Error("Expected the starter to create a task first");
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    mutations.push({ procedure: "send", input });
    const revision = Number(input.expectedRevision) + 1;
    taskSnapshot = { ...taskSnapshot, revision };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          accepted: true,
          actionId: input.actionId,
          runId: "run_starter_e2e",
          status: "accepted",
          revision,
          replayed: false,
        },
      },
    });
  });
  await rememberWorkspace(request, process.cwd());
  await page.goto("/");

  await expect(
    page.getByRole("heading").filter({ hasText: "What should we work on in " }),
  ).toBeVisible();
  await expect(page.getByText("No active task", { exact: true })).toBeVisible();
  const initialPrompt = page.getByLabel("Prompt");
  await expect(initialPrompt).toBeVisible();
  await expect(page.getByLabel("Model")).toBeDisabled();
  await expect(page.getByLabel("Thinking level")).toHaveValue("medium");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await initialPrompt.fill("This must not create an empty task");
  await initialPrompt.press("Enter");
  await page.waitForTimeout(250);
  expect(createRequests).toHaveLength(0);
  await expect(page).toHaveURL("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 900)
    await expect(page.getByRole("button", { name: "Open tasks" })).toBeVisible();

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
  await expect(
    page.getByRole("heading", { name: "What should we work on in apps?" }),
  ).toBeVisible();
  const prompt = page.getByLabel("Prompt");
  const thinking = page.getByLabel("Thinking level");
  await expect(prompt).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("e2e/model");
  expect(createRequests).toHaveLength(0);

  await expect(page.locator("main > header")).toBeVisible();
  const topControl =
    testInfo.project.name === "mobile"
      ? page.getByRole("button", { name: "Open tasks" })
      : page.locator("main > .window-drag-region");
  const resourceWarning = page.getByRole("status").filter({ hasText: "E2E resource warning" });
  await expect(topControl).toBeVisible();
  await expect(resourceWarning).toBeVisible();
  const topControlBox = await topControl.boundingBox();
  const resourceWarningBox = await resourceWarning.boundingBox();
  if (!topControlBox || !resourceWarningBox) throw new Error("Expected visible starter chrome");
  expect(resourceWarningBox.y).toBeGreaterThanOrEqual(topControlBox.y + topControlBox.height);
  if (testInfo.project.name !== "mobile") {
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(page.locator("main > header")).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  }

  starterRequests.length = 0;
  await thinking.selectOption("high");
  await prompt.fill("Start from the existing durable path");
  const send = page.getByRole("button", { name: "Send" });
  await expect(prompt).toHaveValue("Start from the existing durable path");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(prompt).toBeDisabled();
  await expect(page.getByLabel("Model")).toBeDisabled();
  await expect(thinking).toBeDisabled();
  releaseCreation();

  await expect(page.getByRole("heading", { name: "What should we work on in apps?" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Prompt")).toBeVisible();
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]).toEqual(expect.objectContaining({ workspaceId: expect.any(String) }));
  await expect
    .poll(() => starterRequests)
    .toEqual([
      "/api/rpc/workspaces/open",
      "/api/rpc/chats/create",
      "/api/rpc/chats/configure",
      "/api/rpc/chats/sendMessage",
    ]);
  expect(mutations).toEqual([
    expect.objectContaining({
      procedure: "configure",
      input: expect.objectContaining({ thinkingLevel: "high" }),
    }),
    expect.objectContaining({
      procedure: "send",
      input: expect.objectContaining({
        text: "Start from the existing durable path",
        delivery: "normal",
        actionId: expect.any(String),
      }),
    }),
  ]);
  expect(connectedDuringConfiguration).toBe(false);
  if (!initialTaskSnapshot) throw new Error("Expected the starter task's initial snapshot");
  await waitForFakeWebSocket(page);
  await emitServerEvent(page, {
    type: "snapshot",
    eventId: 1,
    chatId: String(initialTaskSnapshot.chatId),
    snapshot: initialTaskSnapshot,
  });
  await expect(page.getByLabel("Thinking level")).toHaveValue("high");
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);

  const taskUrl = page.url();
  const otherWorkspacePath = `${process.cwd()}/packages`;
  await rememberWorkspace(request, otherWorkspacePath);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What should we work on in apps?" }),
  ).toBeVisible();
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

test("defers worktree creation until the first prompt is sent", async ({ page, request }) => {
  const workspaceName = basename(process.cwd());
  let sourceWorkspace: Record<string, unknown> | undefined;
  let localSnapshot: Record<string, unknown> | undefined;
  let worktreeSnapshot: Record<string, unknown> | undefined;
  let chatCreations = 0;
  let localChatCreations = 0;
  let worktreeChatCreations = 0;
  let worktreeCreations = 0;
  let worktreeBootstrapPending = false;
  let releaseWorktreeBootstrap: (() => void) | undefined;
  const disposedChats: string[] = [];
  const removedWorktrees: string[] = [];
  const sentPrompts: Record<string, unknown>[] = [];
  await installFakeWebSocket(page);
  await page.route("**/api/rpc/system/bootstrap", async (route) => {
    const response = await route.fetch();
    if (worktreeChatCreations === 3 && !worktreeBootstrapPending) {
      worktreeBootstrapPending = true;
      await new Promise<void>((resolve) => {
        releaseWorktreeBootstrap = resolve;
      });
    }
    await route.fulfill({ response });
  });
  await page.route("**/api/rpc/workspaces/open", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    sourceWorkspace = {
      ...payload.json,
      models: [{ id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true }],
    };
    await route.fulfill({ response, json: { ...payload, json: sourceWorkspace } });
  });
  await page.route("**/api/rpc/workspaces/createWorktree", async (route) => {
    worktreeCreations += 1;
    if (!sourceWorkspace) throw new Error("Expected the source workspace to be open");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...sourceWorkspace,
          id: "worktree_workspace_e2e",
          path: `${process.cwd()}/.pidex-test-worktree`,
          sessions: [],
        },
      },
    });
  });
  await page.route("**/api/rpc/workspaces/removeWorktree", async (route) => {
    const input = (route.request().postDataJSON() as { json: { workspaceId: string } }).json;
    removedWorktrees.push(input.workspaceId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { ok: true } },
    });
  });
  await page.route("**/api/rpc/chats/dispose", async (route) => {
    const input = (route.request().postDataJSON() as { json: { chatId: string } }).json;
    disposedChats.push(input.chatId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: { ok: true } },
    });
  });
  await page.route("**/api/rpc/chats/create", async (route) => {
    chatCreations += 1;
    const input = (route.request().postDataJSON() as { json: { workspaceId: string } }).json;
    if (input.workspaceId !== "worktree_workspace_e2e") {
      localChatCreations += 1;
      if (!sourceWorkspace) throw new Error("Expected the source workspace to be open");
      const suffix = localChatCreations === 1 ? "" : `_${localChatCreations}`;
      localSnapshot = {
        chatId: `local_chat_e2e${suffix}`,
        workspaceId: String(sourceWorkspace.id),
        taskId: `local_task_e2e${suffix}`,
        revision: 0,
        runStatus: "idle",
        model: "e2e/model",
        thinkingLevel: "high",
        items: [],
        transcriptStart: 0,
        transcriptTotal: 0,
        steeringQueue: [],
        followUpQueue: [],
        stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0, subscription: false },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { json: localSnapshot },
      });
      return;
    }
    worktreeChatCreations += 1;
    if (worktreeChatCreations === 1) {
      await route.abort("failed");
      return;
    }
    if (!localSnapshot) throw new Error("Expected the local task to exist");
    const suffix = worktreeChatCreations === 2 ? "" : `_${worktreeChatCreations}`;
    worktreeSnapshot = {
      ...localSnapshot,
      chatId: `worktree_chat_e2e${suffix}`,
      taskId: `worktree_task_e2e${suffix}`,
      workspaceId: "worktree_workspace_e2e",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: worktreeSnapshot },
    });
  });
  await page.route("**/api/rpc/chats/configure", async (route) => {
    if (!worktreeSnapshot) throw new Error("Expected a worktree task before configuration");
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    worktreeSnapshot = {
      ...worktreeSnapshot,
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.thinkingLevel === "string" ? { thinkingLevel: input.thinkingLevel } : {}),
      revision: Number(input.expectedRevision) + 1,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { json: worktreeSnapshot },
    });
  });
  await page.route("**/api/rpc/chats/sendMessage", async (route) => {
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    sentPrompts.push(input);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          accepted: true,
          actionId: input.actionId,
          runId: "worktree_run_e2e",
          status: "accepted",
          revision: Number(input.expectedRevision) + 1,
          replayed: false,
        },
      },
    });
  });

  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  await page.getByRole("button", { name: `New task in ${workspaceName}` }).click();

  const composer = page.getByTestId("chat-composer");
  const startSelector = composer.getByRole("button", { name: "Start in Work locally" });
  await expect(startSelector).toBeVisible();
  await startSelector.click();
  const startMenu = page.getByRole("menu", { name: "Start in" });
  await expect(startMenu).toBeVisible();
  await startMenu.getByRole("menuitemradio", { name: "New worktree" }).click();
  await expect(composer.getByRole("button", { name: "Start in New worktree" })).toBeVisible();
  expect(worktreeCreations).toBe(0);
  expect(chatCreations).toBe(1);

  await page.getByLabel("Prompt").fill("Implement the selected task");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => worktreeCreations).toBe(1);
  await expect.poll(() => chatCreations).toBe(2);
  await expect.poll(() => removedWorktrees).toEqual(["worktree_workspace_e2e"]);
  await expect.poll(() => sentPrompts).toHaveLength(0);

  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => worktreeCreations).toBe(2);
  await expect.poll(() => chatCreations).toBe(3);
  await expect.poll(() => sentPrompts).toHaveLength(1);
  expect(sentPrompts[0]).toEqual(
    expect.objectContaining({
      chatId: "worktree_chat_e2e",
      text: "Implement the selected task",
    }),
  );
  await expect(page).toHaveURL(/\/tasks\/worktree_task_e2e$/);
  await expect.poll(() => disposedChats).toContain("local_chat_e2e");
  await page.goBack();
  await expect(page).toHaveURL("/");

  await openTasks(page);
  await page.getByRole("button", { name: `New task in ${workspaceName}` }).click();
  await expect(page).toHaveURL(/\/tasks\/local_task_e2e_2$/);
  const cancelledComposer = page.getByTestId("chat-composer");
  await cancelledComposer.getByRole("button", { name: "Start in Work locally" }).click();
  await page
    .getByRole("menu", { name: "Start in" })
    .getByRole("menuitemradio", { name: "New worktree" })
    .click();
  await page.getByLabel("Prompt").fill("Cancel this worktree prompt");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => worktreeBootstrapPending).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL("/");
  releaseWorktreeBootstrap?.();

  await expect
    .poll(() => removedWorktrees)
    .toEqual(["worktree_workspace_e2e", "worktree_workspace_e2e"]);
  await expect.poll(() => sentPrompts).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: `What should we work on in ${workspaceName}?` }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pidex:last-project")))
    .toBe(String(sourceWorkspace?.path));
});
