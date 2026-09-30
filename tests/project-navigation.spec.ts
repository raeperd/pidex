import { expect } from "@playwright/test";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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
  await expect(projects.getByRole("button", { name: "beta", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(list).toContainText("No saved sessions in this project.");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue("");
  await prompt.fill("Remember the beta compass");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Instructions for beta project.");
  expect(lifecycle.requestBodies[1]).not.toContain("alpha");
  lifecycle.complete("Beta compass remembered.");
  await expect(page.getByRole("status")).toHaveText("Idle");

  await projects.getByRole("button", { name: "project", exact: true }).click();
  await expect(current).toContainText(alpha);
  await expect(list.getByRole("radio")).toHaveCount(1);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Alpha lantern remembered.",
  );
  await prompt.fill("What did I ask you to remember?");
  await send.click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(3);
  expect(lifecycle.requestBodies[2]).toContain("Instructions for alpha project.");
  expect(lifecycle.requestBodies[2]).toContain("alpha lantern");
  expect(lifecycle.requestBodies[2]).not.toContain("beta");
  lifecycle.complete("The alpha lantern.");
  await expect(page.getByRole("status")).toHaveText("Idle");

  await projects.getByRole("button", { name: "beta", exact: true }).click();
  await expect(current).toContainText(beta);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Beta compass remembered.",
  );
  expect(lifecycle.requests).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("navigated.png") });
});

test("#195 disables project and session navigation during a run", async ({ lifecycle }) => {
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  const { app, page } = await lifecycle.launch();
  const projects = page.getByRole("navigation", { name: "Projects" });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, beta);
  await projects.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  await page.getByRole("textbox", { name: "Prompt" }).fill("Keep running");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  await expect(projects.getByRole("button", { name: "project", exact: true })).toBeDisabled();
  await expect(projects.getByRole("button", { name: "Add project" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New session" })).toBeDisabled();
  lifecycle.complete("Finished");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(projects.getByRole("button", { name: "project", exact: true })).toBeEnabled();
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
  await projects.getByRole("button", { name: "project", exact: true }).click();
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
  await projects.getByRole("button", { name: "beta", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(`Could not open ${beta}`);
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(alpha);
  await expect(projects.getByRole("button", { name: "beta", exact: true })).toBeVisible();
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
