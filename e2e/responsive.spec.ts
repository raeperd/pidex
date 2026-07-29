import { expect, test } from "@playwright/test";
import { basename } from "node:path";
import { emitServerEvent, installFakeWebSocket, openTasks, rpcRequest } from "./support";

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
          stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0, subscription: false },
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
  await expect(page.getByTestId("composer-stats")).toHaveCount(0);
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
