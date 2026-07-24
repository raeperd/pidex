import { expect, test } from "@playwright/test";

async function openAndCreate(page: import("@playwright/test").Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) await page.getByLabel("Open sessions").click();
  await expect(page.getByLabel("Project directory")).toHaveCount(0);
  await page.getByLabel("Add project").click();
  const picker = page.getByRole("dialog", { name: "Add a project" });
  await expect(picker).toBeVisible();
  await expect(picker).not.toContainText(process.cwd());
  await picker.getByLabel(/^(Add|Open) apps$/).click();
  await expect(page.locator(".project-group").filter({ hasText: "apps" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a new chat" })).toBeVisible();
  await page.getByRole("button", { name: "Start a new chat" }).click();
  await expect(page.getByLabel("Prompt")).toBeVisible();
}
test("new, stream, tool, stop, reconnect, and resume", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openAndCreate(page, testInfo.project.name === "mobile");
  await page.getByLabel("Prompt").fill("show me the project");
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.getByText("streaming", { exact: true })).toBeVisible();
  await expect(page.getByText("read", { exact: true })).toBeVisible();
  await expect(page.getByText("Ready for the next instruction.", { exact: false })).toBeVisible();
  await page.getByLabel("Copy response").last().click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  const assistantsBeforeLargeTool = await page.locator("article.message.assistant").count();
  await page.getByLabel("Prompt").fill("LARGE_TOOL");
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.locator("article.message.assistant")).toHaveCount(
    assistantsBeforeLargeTool + 1,
  );
  await expect(page.getByLabel("Model")).toBeDisabled();
  await expect(page.locator("article.message.assistant").last()).toContainText(
    "Ready for the next instruction.",
  );
  await expect(page.getByLabel("Model")).toBeEnabled();
  const largeTool = page.locator("details.tool").last();
  await largeTool.locator("summary").click();
  const loadOutput = largeTool.getByRole("button", { name: /Load complete output/ });
  await expect(loadOutput).toBeVisible();
  await loadOutput.click();
  await largeTool.getByRole("button", { name: /Load more/ }).click();
  await expect(largeTool).toContainText("end of complete output");
  const before = await page.locator("article.message.assistant").count();
  await context.setOffline(true);
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(page.getByText("Host unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.locator("article.message.assistant")).toHaveCount(before);
  await page.getByLabel("Prompt").fill("stop this");
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByLabel("Prompt").fill("change direction");
  await page.getByLabel("Delivery mode").selectOption("steer");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByText(/1 steer/)).toBeVisible();
  await page.getByLabel("Prompt").fill("do this afterward");
  await page.getByLabel("Delivery mode").selectOption("follow-up");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByText(/1 follow-up/)).toBeVisible();
  await page.getByRole("button", { name: "Clear queues" }).click();
  await expect(page.getByText(/0 steer · 0 follow-up/)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped.", { exact: false })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.getByLabel("Open sessions").click();
  const nestedThread = page.locator(".project-group .project-threads .thread-row").first();
  await expect(nestedThread).toBeVisible();
  await nestedThread.click();
  await expect(
    page.locator(".message.user .bubble").filter({ hasText: "show me the project" }),
  ).toBeVisible();
  await page
    .getByLabel("Prompt")
    .fill(
      'MARKDOWN:<img src="https://evil.example/x" onerror="alert(1)"> [bad](javascript:alert(1))',
    );
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.locator("article.message.assistant").last()).toContainText(
    "Ready for the next instruction.",
  );
  await expect(page.locator("article.message.assistant img")).toHaveCount(0);
  await expect(page.locator('article.message.assistant a[href^="javascript:"]')).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    }),
  );
  await page.getByLabel("Copy response").last().click();
  await expect(page.getByText("Copy failed", { exact: true })).toBeVisible();
  await page.getByLabel("Prompt").fill("DIALOG");
  await page.getByRole("button", { name: /^Send/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel("Confirm").check();
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Extension confirmed.")).toBeVisible();
  if (testInfo.project.name === "chromium") {
    const projectName = "apps";
    await expect(
      page
        .locator(".project-group")
        .filter({ hasText: projectName })
        .getByRole("button", { name: /Show more/ }),
    ).toBeVisible();
    await page
      .locator(".project-group")
      .filter({ hasText: projectName })
      .getByRole("button", { name: /Show more/ })
      .click();
    await expect(
      page.locator(".project-group").filter({ hasText: projectName }).locator(".thread-row"),
    ).toHaveCount(13);
    await page.getByLabel("Add project").click();
    const picker = page.getByRole("dialog", { name: "Add a project" });
    await picker.getByRole("button", { name: "Add all" }).click();
    await expect(picker).toBeHidden();
    await expect.poll(() => page.locator(".project-group").count()).toBeGreaterThanOrEqual(4);
    await page.getByRole("button", { name: `Collapse ${projectName}` }).click();
    await expect(page.getByRole("button", { name: `Expand ${projectName}` })).toBeVisible();
    await page.getByRole("button", { name: `Expand ${projectName}` }).click();
    await expect(page.getByRole("button", { name: `Collapse ${projectName}` })).toBeVisible();
    const prompt = page.getByLabel("Prompt");
    const collapsedHeight = await prompt.evaluate((element) => element.clientHeight);
    await prompt.fill("one\ntwo\nthree\nfour\nfive");
    await expect
      .poll(() => prompt.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(collapsedHeight);
    await page.keyboard.press("ControlOrMeta+K");
    const search = page.getByLabel("Search projects and threads");
    await expect(search).toBeFocused();
    await search.fill("missing session");
    await expect(page.getByText("No matching projects or tasks.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(prompt).toBeFocused();
  }
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByLabel("Open sessions").click();
    await expect(page.getByRole("complementary")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Prompt")).toBeVisible();
  }
});
