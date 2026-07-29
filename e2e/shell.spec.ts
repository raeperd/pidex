import { expect, test, type Locator, type Page } from "@playwright/test";
import { rememberWorkspace, rpcRequest } from "./support";

test("serves branded assets", async ({ request }) => {
  const png = await request.get("/pidex-icon.png");
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");
  expect([...(await png.body()).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const icon = await request.get("/favicon.ico");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/x-icon");
  expect([...(await icon.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
});

test("navigates home when the Pidex icon is clicked", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The Pidex icon is part of the desktop title bar");
  await installIntegratedTitleBar(page);
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
  await page.goto(`/tasks/${created.result.taskId}`);

  await page
    .getByRole("link", { name: "Pidex home" })
    .locator('img[src="/pidex-icon.png"]')
    .click();

  await expect(page).toHaveURL("/");
});

test("integrates the starter canvas with macOS window chrome", async ({
  page,
  request,
}, testInfo) => {
  await installIntegratedTitleBar(page);
  await rememberWorkspace(request, process.cwd());

  await page.goto("/");

  const sidebarTitleBar = page.locator("aside > .window-drag-region");
  const mainDragRegion = page.locator("main > .window-drag-region");
  await expect(sidebarTitleBar).toHaveCSS("-webkit-app-region", "drag");
  await expect(sidebarTitleBar).toHaveCSS("height", "52px");
  await expect(sidebarTitleBar).toHaveCSS("padding-left", "80px");
  await expect(page.locator("main > header")).toHaveCount(0);
  await expect(mainDragRegion).toHaveCSS("height", "32px");

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

  await expect(mainDragRegion).toHaveCSS("-webkit-app-region", "drag");
  await expect(page.getByRole("button", { name: "Search projects and tasks" })).toHaveCSS(
    "-webkit-app-region",
    "no-drag",
  );

  if (testInfo.project.name !== "mobile") {
    await collapseSidebar.click();
    const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
    await expect(expandSidebar).toHaveCSS("left", "80px");
    await expandSidebar.click();
  }

  await page.setViewportSize({ width: 800, height: 820 });
  const openTasks = page.getByRole("button", { name: "Open tasks" });
  await expect(openTasks).toBeVisible();
  await expect(openTasks).toHaveCSS("left", "80px");
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

  await expectSidebarCollapsed(sidebar);
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expandSidebar).toBeFocused();
  await expandSidebar.press("Enter");
  await expect(sidebar).toHaveCSS("opacity", "1");
  await expect(collapseSidebar).toBeFocused();
});

test("resizes, restores, and resets after mouse or keyboard collapse", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The mobile sidebar remains a fixed-width drawer");
  await page.goto("/");

  const sidebar = page.getByRole("complementary", { name: "Tasks" });
  const resizeHandle = page.getByRole("slider", { name: "Resize sidebar" });
  await expect(sidebar).toHaveCSS("width", "320px");
  await expect(sidebar.locator("..")).toHaveCSS("transition-property", "grid-template-columns");
  await expect(sidebar.locator("..")).toHaveCSS("transition-duration", "0.2s");
  const handleBounds = await resizeHandle.boundingBox();
  if (!handleBounds) throw new Error("The sidebar resize handle is not visible");

  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2 + 80,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.up();

  await expect(sidebar).toHaveCSS("width", "400px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "400px");

  const restoredHandleBounds = await resizeHandle.boundingBox();
  if (!restoredHandleBounds) throw new Error("The restored resize handle is not visible");
  await page.mouse.move(
    restoredHandleBounds.x + restoredHandleBounds.width / 2,
    restoredHandleBounds.y + restoredHandleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(80, restoredHandleBounds.y + restoredHandleBounds.height / 2);
  await expectSidebarCollapsed(sidebar);
  await page.mouse.up();

  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expandSidebar).toBeFocused();
  await expandSidebar.click();
  await expect(sidebar).toHaveCSS("width", "320px");

  await resizeHandle.press("Home");
  await expect(sidebar).toHaveCSS("width", "120px");
  await resizeHandle.press("ArrowLeft");
  await expectSidebarCollapsed(sidebar);
  await expect(expandSidebar).toBeFocused();
  await expandSidebar.click();
  await expect(sidebar).toHaveCSS("width", "320px");
});

test("resizes the composer after an animated sidebar change", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The mobile sidebar remains a fixed-width drawer");
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
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.goto(`/tasks/${created.result.taskId}`);

  const sidebar = page.getByRole("complementary", { name: "Tasks" });
  const resizeHandle = page.getByRole("slider", { name: "Resize sidebar" });
  const prompt = page.getByLabel("Prompt");
  await resizeHandle.press("Home");
  await expect(sidebar).toHaveCSS("width", "120px");
  await prompt.fill(
    "Describe the implementation details and verification results for this resizable sidebar change, including pointer capture, keyboard controls, persisted widths, collapse thresholds, animation behavior, reduced motion support, focus management, mobile layout behavior, and the regression coverage used to keep every interaction working correctly.",
  );
  const wideHeight = await prompt.evaluate((element: HTMLTextAreaElement) => element.clientHeight);

  await resizeHandle.press("End");
  await expect(sidebar).toHaveCSS("width", "480px");
  await expect
    .poll(() =>
      prompt.evaluate((element: HTMLTextAreaElement) =>
        Math.abs(Number.parseFloat(element.style.height) - Math.min(element.scrollHeight, 210)),
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await prompt.evaluate((element: HTMLTextAreaElement) => element.clientHeight),
  ).toBeGreaterThan(wideHeight);
});

async function expectSidebarCollapsed(sidebar: Locator) {
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveCSS("opacity", "0");
  await expect
    .poll(() =>
      sidebar
        .locator("..")
        .evaluate((shell) => Number.parseFloat(getComputedStyle(shell).gridTemplateColumns)),
    )
    .toBe(0);
}

function installIntegratedTitleBar(page: Page) {
  return page.addInitScript(() => {
    Object.defineProperty(window, "pidexDesktop", {
      value: {
        usesIntegratedTitleBar: true,
        pickProject: () => Promise.resolve(null),
      },
    });
  });
}
