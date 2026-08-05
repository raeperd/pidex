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
      type: "user",
      id: "user_terminal_e2e",
      text: "Inspect this repository",
      complete: true,
      timestamp: "2026-07-27T00:00:00.000Z",
    },
  });
  await emitServerEvent(page, {
    type: "message",
    eventId: 2,
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

  await expect(page.getByRole("button", { name: "Start in Work locally" })).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Rendered result" })).toBeVisible();
  const transcriptBody = page.getByRole("log").locator(":scope > div");
  const userPrompt = page.getByRole("log").getByText("Inspect this repository", { exact: true });
  const assistantBody = page.locator(".markdown").filter({ hasText: "Rendered result" });
  await expect(transcriptBody).toHaveCSS("max-width", "576px");
  await expect(transcriptBody).toHaveCSS("font-family", /DM Sans/);
  await expect(userPrompt).toHaveCSS("border-radius", "24px");
  await expect(userPrompt).toHaveCSS("font-family", /DM Sans/);
  await expect
    .poll(() =>
      userPrompt.evaluate((element) => {
        const bubble = element.getBoundingClientRect();
        const row = element.parentElement?.getBoundingClientRect();
        return row
          ? bubble.width < row.width && Math.abs(row.right - bubble.right - 8) <= 1
          : false;
      }),
    )
    .toBe(true);
  await expect(assistantBody).toHaveCSS("font-family", /DM Sans/);
  await expect(assistantBody).toHaveCSS("font-size", "14px");
  const assistantHeading = page.getByRole("heading", { name: "Rendered result" });
  await expect(assistantHeading).toHaveCSS("font-size", "21.7px");
  expect(await assistantHeading.evaluate((element) => getComputedStyle(element).color)).not.toBe(
    "rgb(183, 121, 31)",
  );
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
    eventId: 3,
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

test("renders grouped tool activity with semantic rows and expandable output", async ({
  page,
  request,
}) => {
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
  const runningTool = page.getByLabel("$ ls -la");
  const toolContainer = runningTool.locator("..");
  await expect(runningTool).toBeVisible();
  await expect(toolContainer).toHaveCSS("border-radius", "8px");
  await expect(toolContainer).toHaveCSS("font-size", "12px");
  await expect(toolContainer).toHaveCSS("margin-left", "0px");
  await expect(toolContainer).toHaveCSS("margin-right", "0px");
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

  const toolBlock = page.getByRole("button", { name: "$ ls -la" });
  await expect(page.getByText(/^Took \d+\.\d+s$/)).toBeVisible();
  await expect(toolBlock).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".tool-call__output")).toContainText("one");
  await expect(page.locator(".tool-call__output")).toContainText("seven");
  await expect(page.locator(".tool-call__output")).not.toContainText('"type": "text"');

  await toolBlock.click();
  await expect(toolBlock).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".tool-call__output")).toContainText("seven");
  await expect(page.locator(".tool-call__output")).not.toContainText("one");

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
  const restored = page.getByLabel("$ pnpm build").locator("..");

  await emitServerEvent(page, {
    type: "tool",
    eventId: 5,
    chatId,
    item: {
      ...toolItem,
      id: "tool_read_e2e",
      name: "read",
      argumentSummary: JSON.stringify({ path: "README.md", offset: 1, limit: 800 }),
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

  const history = page.getByText("4 previous tool calls");
  await expect(history).toBeVisible();
  await expect(page.getByText("Read 1 file, ran 3 commands, and searched once")).toBeVisible();
  await expect(restored).toBeHidden();
  await history.click();
  await expect(toolBlock).toBeVisible();
  await expect(page.getByLabel("$ sleep 10")).toBeVisible();
  await expect(restored).toBeVisible();
  await expect(restored.locator(".tool-call__timing")).toHaveCount(0);
  const readBlock = page.getByRole("button", {
    name: "Read README.md:1-800",
  });
  const readContainer = readBlock.locator("..");
  await expect(readBlock).toBeVisible();
  await expect(readContainer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(readContainer.locator(".tool-call__range")).toHaveText(":1-800");
  await expect(readContainer.locator(".tool-call__range")).toHaveCSS("color", "rgb(220, 220, 31)");
  await expect(readBlock).toHaveAttribute("aria-expanded", "false");
  await expect(readContainer.locator(".tool-call__output")).toHaveCount(0);
  await readBlock.click();
  await expect(readContainer.locator(".tool-call__output")).toHaveText("project readme");
  await expect(page.getByRole("button", { name: "Search TODO · src" })).toBeVisible();
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
  const thinking = page.locator(".thinking-markdown");
  await expect(thinking).toContainText("weighing options");
  await expect(thinking.locator("details")).toHaveCount(0);

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

  await expect(thinking).toContainText("weighing options");
  await expect(page.getByText("Thought", { exact: true })).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);

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
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
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

test("isolates pending task operations while navigating between tasks", async ({
  page,
  request,
}) => {
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
  const { promise: configurationPending, resolve: releaseConfiguration } =
    Promise.withResolvers<void>();
  const { promise: compactionPending, resolve: releaseCompaction } = Promise.withResolvers<void>();
  let configurationRequested = false;
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
  await page.route("**/api/rpc/chats/configure", async (route) => {
    configurationRequested = true;
    const input = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    await configurationPending;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        json: {
          ...first.result,
          thinkingLevel: input.thinkingLevel,
          revision: Number(input.expectedRevision) + 1,
        },
      },
    });
  });

  await page.goto(`/tasks/${String(first.result.taskId)}`);
  const prompt = page.getByLabel("Prompt");
  await expect(prompt).toBeVisible();
  const thinking = page.getByLabel("Thinking level");
  const nextThinking = (await thinking.inputValue()) === "high" ? "low" : "high";
  const configurationResponse = page.waitForResponse("**/api/rpc/chats/configure");
  await thinking.selectOption(nextThinking);
  await expect.poll(() => configurationRequested).toBe(true);
  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await expect(thinking).toBeEnabled();
  await page.getByTitle("First task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(first.result.taskId)}`);
  await expect(thinking).toBeDisabled();
  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await expect(thinking).toBeEnabled();
  releaseConfiguration();
  await configurationResponse;
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
  await page.getByTitle("First task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(first.result.taskId)}`);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByTitle("Second task").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page).toHaveURL(`/tasks/${String(second.result.taskId)}`);
  await expect(prompt).toHaveValue("Message for the second task");
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

  await contextMeter.focus();
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

test("persists idle configuration immediately without overwriting the draft", async ({
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
  await waitForFakeWebSocket(page);

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
  await expect(contextDetails).not.toContainText("Session cost");
  await expect(contextDetails).toContainText("Pi automatically compacts its context when needed.");
  await expect(contextDetails.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");

  const nextThinking = (await thinking.inputValue()) === "high" ? "low" : "high";
  await thinking.selectOption(nextThinking);
  await expect.poll(() => mutations.map(({ procedure }) => procedure)).toEqual(["configure"]);
  await expect(page.getByText("Next turn", { exact: true })).toHaveCount(0);
  await expect(thinking).toBeDisabled();
  await prompt.fill("Draft while configuration is pending");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  if (testInfo.project.name !== "mobile") await prompt.press("Enter");
  expect(mutations.map(({ procedure }) => procedure)).toEqual(["configure"]);
  releaseConfiguration();
  await expect(thinking).toBeEnabled();
  await expect(thinking).toHaveValue(nextThinking);
  await expect(prompt).toHaveValue("Draft while configuration is pending");

  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => mutations.map(({ procedure }) => procedure))
    .toEqual(["configure", "send"]);
  expect(mutations[0]?.input).toEqual(expect.objectContaining({ thinkingLevel: nextThinking }));
  expect(mutations[1]?.input).toEqual(expect.objectContaining({ delivery: "normal" }));

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
  await expect(thinking).toBeDisabled();
  await expect(contextMeter).toHaveRole("button");
  await expect(page.getByRole("dialog", { name: "Compact this task?" })).toHaveCount(0);

  await expect(page.getByLabel("Delivery mode")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Queue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await prompt.fill("Start the next turn");
  if (testInfo.project.name !== "mobile") await prompt.press("Enter");
  await expect(prompt).toHaveValue("Start the next turn");
  expect(mutations).toHaveLength(0);
  await expect(page.getByText("Next turn", { exact: true })).toHaveCount(0);

  await emitServerEvent(page, {
    type: "run_status",
    eventId: 3,
    chatId,
    status: "idle",
    revision: 50,
  });
  await expect(thinking).toBeEnabled();
  await expect(prompt).toHaveValue("Start the next turn");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  const updatedThinking = nextThinking === "high" ? "medium" : "high";
  await thinking.selectOption(updatedThinking);
  await expect.poll(() => mutations.map(({ procedure }) => procedure)).toEqual(["configure"]);
  expect(mutations[0]?.input).toEqual(expect.objectContaining({ thinkingLevel: updatedThinking }));

  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => mutations.map(({ procedure }) => procedure))
    .toEqual(["configure", "send"]);
  expect(mutations[1]?.input).toEqual(expect.objectContaining({ delivery: "normal" }));
});
