import { expect, test, type Page } from "@playwright/test";
import { rpcRequest } from "./support";

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

test("integrates the application headers with macOS window chrome", async ({ page }, testInfo) => {
  await installIntegratedTitleBar(page);

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
