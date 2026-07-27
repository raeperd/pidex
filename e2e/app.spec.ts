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
  await expect(page.getByLabel("Thinking level")).toBeVisible();
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0]).toEqual(expect.objectContaining({ workspaceId: expect.any(String) }));
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);

  const taskUrl = page.url();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick a task to continue" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.getByLabel("Prompt")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.getByLabel("Prompt")).toBeVisible();
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
  await page.getByRole("button", { name: `New task in ${workspaceName}` }).click();
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

test("stages configuration without overwriting the next draft", async ({ page, request }) => {
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
  await page.getByRole("button", { name: "New task in pidex" }).click();

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
  const button = page.getByRole("button", { name: "Open tasks" });
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
