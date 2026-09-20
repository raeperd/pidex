import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: { role: "assistant", content: prose }, finish_reason: null }] })}\n\n`,
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

test("#183 opening a long tool result preserves its beginning and keeps Stop reachable", async ({
  lifecycle,
}, info) => {
  const result = "A long source line with details ".repeat(6) + "\n";
  await writeFile(join(lifecycle.project, "long.txt"), result.repeat(80));
  const { page } = await lifecycle.launch();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Read long.txt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const response = lifecycle.requests[0];
  response.write(
    `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-long", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "long.txt" }) } }] }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  const tool = page.locator("details");
  await expect(tool.locator("summary")).toHaveText("read · Completed");
  await tool.locator("summary").focus();
  await tool.locator("summary").press("Enter");
  await expect(tool.getByLabel("Result", { exact: true })).toContainText(result.trim());
  // Wait for the disclosure layout and ResizeObserver's resulting scroll to settle.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(tool.getByRole("heading", { name: "Input", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  const transcript = page.getByRole("region", { name: "Messages" });
  expect(await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("tool-expanded-narrow.png") });
});
