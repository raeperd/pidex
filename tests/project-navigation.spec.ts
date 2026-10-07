import { expect } from "@playwright/test";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "./support/lifecycle.js";

test("#195 navigates between idle projects and sessions from the sidebar", async ({
  lifecycle,
}, info) => {
  const alpha = await realpath(lifecycle.project);
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  await writeFile(join(alpha, "AGENTS.md"), "Instructions for alpha project.");
  await writeFile(join(beta, "AGENTS.md"), "Instructions for beta project.");
  await writeFile(join(alpha, "marker.txt"), "alpha marker contents");
  await writeFile(join(beta, "marker.txt"), "beta marker contents");
  const { app, page } = await lifecycle.launch();
  const projects = page.getByRole("navigation", { name: "Projects" });
  const current = page.getByRole("region", { name: "Current project" });
  const list = page.getByRole("region", { name: "Saved sessions" });
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await prompt.fill("Remember the alpha lantern");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(1);
  lifecycle.complete("Alpha lantern remembered.");
  await expect(page.getByRole("status")).toHaveText("Idle");

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, beta);
  await prompt.fill("Unsent alpha text");
  await projects.getByRole("button", { name: "Add project" }).click();
  await expect(current).toContainText(beta);
  await expect(projects.getByRole("button", { name: /^beta / })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(list).toContainText("No saved sessions in this project.");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue("");
  await prompt.fill("Remember the beta compass and read marker.txt");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Instructions for beta project.");
  expect(lifecycle.requestBodies[1]).not.toContain("alpha");
  // A real tool result proves the run's working directory is the selected project.
  readMarker(lifecycle.requests[1]);
  await expect.poll(() => lifecycle.requestBodies.length).toBe(3);
  expect(lifecycle.requestBodies[2]).toContain("beta marker contents");
  lifecycle.complete("Beta compass remembered.");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Beta compass remembered.",
  );
  await expect(page.getByRole("status")).toHaveText("Idle");

  await projects.getByRole("button", { name: /^project / }).click();
  await expect(current).toContainText(alpha);
  await expect(list.getByRole("radio")).toHaveCount(1);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Alpha lantern remembered.",
  );
  await prompt.fill("What did I ask you to remember?");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(4);
  expect(lifecycle.requestBodies[3]).toContain("Instructions for alpha project.");
  expect(lifecycle.requestBodies[3]).toContain("alpha lantern");
  expect(lifecycle.requestBodies[3]).not.toContain("beta");
  lifecycle.complete("The alpha lantern.");
  await expect(page.getByRole("status")).toHaveText("Idle");

  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await prompt.fill("Read marker.txt in a fresh alpha session");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(5);
  expect(lifecycle.requestBodies[4]).toContain("Instructions for alpha project.");
  expect(lifecycle.requestBodies[4]).not.toContain("alpha lantern");
  readMarker(lifecycle.requests[4]);
  await expect.poll(() => lifecycle.requestBodies.length).toBe(6);
  expect(lifecycle.requestBodies[5]).toContain("alpha marker contents");
  lifecycle.complete("Alpha marker read.");
  await expect(page.getByRole("status")).toHaveText("Idle");

  await projects.getByRole("button", { name: /^beta / }).click();
  await expect(current).toContainText(beta);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Beta compass remembered.",
  );
  expect(lifecycle.requests).toHaveLength(6);
  await page.screenshot({ path: info.outputPath("navigated.png") });
});

test("#195 disables project and session navigation while running or stopping", async ({
  lifecycle,
}) => {
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  const { app, page } = await lifecycle.launch(false);
  await lifecycle.holdStops(app);
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  const projects = page.getByRole("navigation", { name: "Projects" });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, beta);
  await projects.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await prompt.fill("Saved beta session");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await page.getByRole("button", { name: "New session" }).click();
  const list = page.getByRole("region", { name: "Saved sessions" });
  await list.getByRole("radio").check();
  await prompt.fill("Keep running");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  for (const status of ["Running", "Stopping"]) {
    if (status === "Stopping") await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("status")).toHaveText(status);
    await expect(projects.getByRole("button", { name: /^project / })).toBeDisabled();
    await expect(projects.getByRole("button", { name: "Add project" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New session" })).toBeDisabled();
    await expect(list.getByRole("button", { name: "Resume session" })).toBeDisabled();
  }
  await expect.poll(() => lifecycle.cancellations.length).toBe(1);
  lifecycle.cancellations[0]?.end();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(projects.getByRole("button", { name: /^project / })).toBeEnabled();
  await expect(projects.getByRole("button", { name: "Add project" })).toBeEnabled();
});

test("#195 keeps the current session usable when a recent project is missing", async ({
  lifecycle,
}, info) => {
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  const { app, page } = await lifecycle.launch();
  const projects = page.getByRole("navigation", { name: "Projects" });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, beta);
  await projects.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  await projects.getByRole("button", { name: /^project / }).click();
  const alpha = await realpath(lifecycle.project);
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(alpha);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Keep this history");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Kept reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing saved history");

  await rename(beta, join(lifecycle.home, "moved"));
  await prompt.fill("Draft for alpha");
  await projects.getByRole("button", { name: /^beta / }).click();
  await expect(page.getByRole("alert")).toContainText(`Could not open ${beta}`);
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(alpha);
  await expect(projects.getByRole("button", { name: /^beta / })).toBeVisible();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Kept reply");
  await expect(prompt).toHaveValue("Draft for alpha");
  await page.screenshot({ path: info.outputPath("missing-destination.png") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Keep this history");
  lifecycle.complete("Continued");
  await expect(page.getByRole("status")).toHaveText("Idle");
  expect(await lifecycle.history()).toHaveLength(1);
  expect((await readFile(saved.path, "utf8")).startsWith(saved.bytes)).toBe(true);
});

// Answers a held provider request with a `read marker.txt` tool call.
function readMarker(response: ServerResponse | undefined) {
  if (!response) throw new Error("Missing provider request");
  for (const [delta, finish_reason] of [
    [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "read-marker",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) },
          },
        ],
      },
      null,
    ],
    [{}, "tool_calls"],
  ] as const)
    response.write(
      `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}
