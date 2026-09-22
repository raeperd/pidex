import { expect } from "@playwright/test";
import { test } from "./support/lifecycle.js";

test("#183 keeps circular actions visible with a long editable draft during a run", async ({
  lifecycle,
}, info) => {
  const { page } = await lifecycle.launch();
  const composer = page.getByRole("form", { name: "Message composer" });
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await prompt.fill("Explain this project");
  await expect(send.locator("svg")).toBeVisible();
  await expect(send).toHaveCSS("border-radius", "50%");
  await send.click();
  await expect(prompt).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop.locator("svg rect")).toBeVisible();
  await expect(stop).toHaveCSS("background-color", "rgb(230, 56, 68)");
  await expect(send).toBeHidden();
  const next = "Follow-up context\n".repeat(100);
  await prompt.fill(next);
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(stop).toBeInViewport({ ratio: 1 });
  expect(await prompt.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await prompt.press("Enter");
  expect(lifecycle.requests).toHaveLength(1);
  const retained = await prompt.inputValue();
  await page.screenshot({ path: info.outputPath("composer-running-narrow.png") });
  await stop.click();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(prompt).toHaveValue(retained);
  await expect(send).toBeEnabled();
  await expect(send).toBeInViewport({ ratio: 1 });
  await prompt.focus();
  await expect(composer).toHaveCSS("outline-color", "rgb(0, 215, 255)");
  await page.screenshot({ path: info.outputPath("composer-idle-narrow.png") });
});
