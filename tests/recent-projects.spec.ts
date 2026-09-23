import { expect } from "@playwright/test";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./support/lifecycle.js";

test("#193 reopens a recent project after relaunch without sending a prompt", async ({
  lifecycle,
}, info) => {
  const metadata = join(lifecycle.home, "metadata.json");
  const sessionDrafts = { future: { text: "preserve me" } };
  await writeFile(metadata, JSON.stringify({ version: 1, recentProjects: [], sessionDrafts }));
  const first = await lifecycle.launch();
  await expect(first.page.getByRole("region", { name: "Saved sessions" })).toBeVisible();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  expect(JSON.parse(await readFile(metadata, "utf8"))).toEqual({
    version: 1,
    recentProjects: [await realpath(lifecycle.project)],
    sessionDrafts,
  });
  expect(
    (await readdir(lifecycle.home)).filter((file) => file.startsWith("metadata.json.")),
  ).toEqual([]);

  const second = await lifecycle.launch(false);
  const recent = second.page.getByRole("region", { name: "Recent projects" });
  await expect(recent.getByRole("button", { name: lifecycle.project })).toBeVisible();
  await expect(second.page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  await recent.getByRole("button", { name: lifecycle.project }).click();
  await expect(second.page.getByRole("region", { name: "Saved sessions" })).toBeVisible({
    timeout: 15000,
  });
  expect(lifecycle.requests).toHaveLength(0);
  await second.page.screenshot({ path: info.outputPath("recent-project.png") });
});

test("#193 canonical aliases share one recent entry and cancelling the picker changes nothing", async ({
  lifecycle,
}) => {
  const canonical = await realpath(lifecycle.project);
  const alias = join(lifecycle.home, "alias");
  await symlink(canonical, alias);
  const first = await lifecycle.launch();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);

  const second = await lifecycle.launch(false);
  await second.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, alias);
  await second.page.getByRole("button", { name: "Choose project" }).click();
  await expect(second.page.getByRole("region", { name: "Saved sessions" })).toBeVisible({
    timeout: 15000,
  });
  await second.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => second.process.exitCode).toBe(0);

  const third = await lifecycle.launch(false);
  const recent = third.page.getByRole("region", { name: "Recent projects" });
  await expect(recent.getByRole("button")).toHaveCount(1);
  await expect(recent.getByRole("button", { name: canonical })).toBeVisible();
  await third.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await third.page.getByRole("button", { name: "Choose project" }).click();
  await expect(recent.getByRole("button")).toHaveCount(1);
  await expect(third.page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 unreadable metadata is preserved and blocks project selection", async ({
  lifecycle,
}) => {
  const metadata = join(lifecycle.home, "metadata.json");
  const damaged = "{unreadable";
  await writeFile(metadata, damaged);
  const { page, children } = await lifecycle.launch(false);
  await expect(page.getByRole("alert")).toContainText("metadata");
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("alert")).toContainText("Restore the file and Retry");
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(await readFile(metadata, "utf8")).toBe(damaged);
  expect(children()).toHaveLength(0);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 a missing recent folder stays available with an actionable error", async ({
  lifecycle,
}) => {
  const missing = join(lifecycle.home, "missing");
  await mkdir(missing);
  const first = await lifecycle.launch(false);
  await first.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, missing);
  await first.page.getByRole("button", { name: "Choose project" }).click();
  await expect(first.page.getByRole("region", { name: "Saved sessions" })).toBeVisible({
    timeout: 15000,
  });
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  await rm(missing, { recursive: true });

  const second = await lifecycle.launch(false);
  const recent = second.page.getByRole("region", { name: "Recent projects" });
  await recent.getByRole("button", { name: missing }).click();
  await expect(second.page.getByRole("alert")).toContainText("Choose another folder");
  await expect(recent.getByRole("button", { name: missing })).toBeVisible();
  await expect(second.page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(lifecycle.requests).toHaveLength(0);
});
