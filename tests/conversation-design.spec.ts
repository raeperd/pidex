import { expect } from "@playwright/test";
import { test } from "./support/lifecycle.js";

test("#183 keeps long Markdown readable and the composer reachable while preserving reading position", async ({
  lifecycle,
}, info) => {
  const { page } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Explain the project layout");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const prose = "## Project layout\n\n" + "A paragraph describing the project.\n\n".repeat(40);
  const response = lifecycle.requests[0];
  response.write(
    `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta: { role: "assistant", content: prose }, finish_reason: null }] })}\n\n`,
  );
  const heading = page.getByRole("heading", { name: "Project layout" });
  await expect(heading).toHaveCSS("color", "rgb(240, 198, 116)");
  const transcript = page.getByRole("region", { name: "Messages" });
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(heading).toBeInViewport();
  lifecycle.complete(
    "\n## Finished\n\n```text\n" +
      "long-token".repeat(100) +
      "\n```\n\n| File | Purpose |\n| --- | --- |\n| " +
      "long-path".repeat(30) +
      " | Source |\n",
  );
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(heading).toBeInViewport();
  await expect(prompt).toBeInViewport();
  await page.screenshot({ path: info.outputPath("conversation-desktop.png") });
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await expect(prompt).toBeInViewport();
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole("table")).toBeInViewport();
  expect(await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("conversation-narrow.png") });
});
