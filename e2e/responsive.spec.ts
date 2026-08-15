import { expect, test } from "@playwright/test";
import {
  emitServerEvent,
  fulfillJson,
  installFakeWebSocket,
  makeChatSnapshot,
  openTasks,
  rpcRequest,
  workspaceName,
} from "./support";

test("scales mobile task and composer targets while preserving responsive density", async ({
  page,
  request,
}, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  const workspacePath = process.cwd();
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
    await fulfillJson(route, {
      ...bootstrap.result,
      recentWorkspaces: [{ id: opened.result.id, path: workspacePath }],
      projectCandidates: [],
    });
  });
  await page.route("**/api/rpc/workspaces/open", (route) => fulfillJson(route, workspaceFixture));
  await page.route("**/api/rpc/chats/create", async (route) => {
    createdSnapshot = {
      chatId: "chat_mobile_readability",
      revision: 0,
    };
    await fulfillJson(
      route,
      makeChatSnapshot({
        ...createdSnapshot,
        workspaceId: opened.result.id,
        taskId: "new_task_mobile_readability",
        model: opened.result.models[0]?.id,
      }),
    );
  });

  await page.goto("/");
  const starterModel = page.getByTestId("starter-composer").getByLabel("Model");
  await expect(starterModel).toHaveCSS("font-size", "12px");
  await expect(starterModel).toHaveCSS("white-space", "nowrap");
  await expect(starterModel.locator("..")).toHaveCSS("overflow", "hidden");
  if (mobile) await expect(starterModel).toHaveCSS("width", "144px");
  await openTasks(page);

  const projects = page.getByRole("navigation", { name: "Projects" });
  const projectToggle = page.getByRole("button", { name: `Collapse ${workspaceName}` });
  const taskRow = projects.locator(`button[title="${longTaskName}"]`);
  const addProject = page.locator('button[aria-label="Add project"]');
  const search = page.getByRole("button", { name: "Search projects and tasks" });
  const newTask = page.getByRole("button", { name: `New task in ${workspaceName}` });

  await expect(projectToggle).toHaveCSS("height", mobile ? "40px" : "36px");
  await expect(taskRow).toHaveCSS("height", mobile ? "40px" : "36px");
  await expect(taskRow.locator("time")).toHaveCSS("font-size", "11px");
  await expect
    .poll(() =>
      taskRow.evaluate((row) => {
        const group = row.closest('[role="group"]');
        if (!group) return null;
        const groupBounds = group.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        return {
          left: Math.round(rowBounds.left - groupBounds.left),
          right: Math.round(groupBounds.right - rowBounds.right),
        };
      }),
    )
    .toEqual({ left: 0, right: 0 });
  await expect(addProject).toHaveCSS("width", mobile ? "36px" : "32px");
  await expect(search).toHaveCSS("width", mobile ? "40px" : "34px");
  await expect(newTask).toHaveCSS("width", mobile ? "36px" : "32px");
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
  await expect(model).toHaveCSS("font-size", "12px");
  await expect(model).toHaveCSS("white-space", "nowrap");
  await expect(model.locator("..")).toHaveCSS("overflow", "hidden");
  if (mobile) await expect(model).toHaveCSS("width", "144px");
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
  await expect(page.getByRole("button", { name: "Queue" })).toHaveCount(0);
  await expect(page.getByLabel("Delivery mode")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
});
