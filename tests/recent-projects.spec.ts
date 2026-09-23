import { expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "./support/lifecycle.js";

test("#193 a second app process cannot overwrite the same recent-project metadata", async ({
  lifecycle,
}) => {
  await using cleanup = new AsyncDisposableStack();
  const first = await lifecycle.launch(false);
  const binary: unknown = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") throw new Error("Electron binary is unavailable");
  const second = spawn(binary, ["dist/desktop/main.js", `--user-data-dir=${lifecycle.home}`], {
    env: { PATH: process.env.PATH ?? "", HOME: lifecycle.home, TMPDIR: tmpdir() },
  });
  cleanup.defer(() => {
    if (second.exitCode === null) second.kill("SIGKILL");
  });
  await expect.poll(() => second.exitCode, { timeout: 10000 }).toBe(0);
  await expect(first.page.getByRole("button", { name: "Choose project" })).toBeVisible();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
});

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
  await second.app.context().tracing.stop({ path: info.outputPath("trace.zip") });
  await second.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => second.process.exitCode).toBe(0);
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
  await third.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => third.process.exitCode).toBe(0);
});

test("#193 recanonicalizing a moved recent project removes its old path", async ({ lifecycle }) => {
  const first = await lifecycle.launch();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  const moved = join(lifecycle.home, "moved-project");
  await rename(lifecycle.project, moved);
  await symlink(moved, lifecycle.project);

  const second = await lifecycle.launch(false);
  await second.page
    .getByRole("region", { name: "Recent projects" })
    .getByRole("button", { name: lifecycle.project })
    .click();
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
  await expect(recent.getByRole("button", { name: moved })).toBeVisible();
  await third.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => third.process.exitCode).toBe(0);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 choosing another alias also removes a moved project's stale path", async ({
  lifecycle,
}) => {
  const first = await lifecycle.launch();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  const moved = join(lifecycle.home, "moved-project");
  const alias = join(lifecycle.home, "another-alias");
  await rename(lifecycle.project, moved);
  await symlink(moved, lifecycle.project);
  await symlink(moved, alias);

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
  await expect(recent.getByRole("button", { name: moved })).toBeVisible();
  await third.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => third.process.exitCode).toBe(0);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 unreadable metadata is preserved and blocks project selection", async ({
  lifecycle,
}) => {
  const metadata = join(lifecycle.home, "metadata.json");
  const damaged = "{unreadable";
  await writeFile(metadata, damaged);
  const { app, page, process, children } = await lifecycle.launch(false);
  await expect(page.getByRole("alert")).toContainText("metadata");
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("alert")).toContainText("Restore the file and Retry");
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(await readFile(metadata, "utf8")).toBe(damaged);
  expect(children()).toHaveLength(0);
  expect(lifecycle.requests).toHaveLength(0);
  await app.evaluate(({ app: application }) => {
    setImmediate(() => application.quit());
  });
  await expect.poll(() => process.exitCode).toBe(0);
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
  await second.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => second.process.exitCode).toBe(0);
});
