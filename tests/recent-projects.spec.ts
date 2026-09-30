import { expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { alive, test } from "./support/lifecycle.js";

test("#193 reopens a recent project after relaunch without resuming or provider requests", async ({
  lifecycle,
}, info) => {
  const project = await realpath(lifecycle.project);
  const first = await lifecycle.launch(false);
  const recent = first.page.getByRole("region", { name: "Recent projects" });
  await expect(recent).toContainText("No recent projects yet.");
  await first.page.getByRole("button", { name: "Choose project" }).click();
  await expect(first.page.getByRole("region", { name: "Saved sessions" })).toBeVisible({
    timeout: 15000,
  });
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Saved before Quit");
  await first.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved reply");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const children = first.children();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  for (const pid of children) await expect.poll(() => alive(pid)).toBe(false);
  expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
    version: 1,
    recentProjects: [project],
  });

  const second = await lifecycle.launch(false);
  const entries = second.page.getByRole("region", { name: "Recent projects" }).getByRole("button");
  await expect(entries).toHaveCount(1);
  await expect(entries).toHaveAccessibleName(`project ${project}`);
  await expect(second.page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(second.children()).toHaveLength(0);
  await second.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await second.page.getByRole("button", { name: "Choose project" }).click();
  await expect(second.page.getByRole("button", { name: "Choose project" })).toBeEnabled();
  await expect(second.page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  await expect(entries).toHaveCount(1);
  const unlisted = await second.page.evaluate(
    (path) => window.desktop.openProject(path),
    join(await realpath(lifecycle.home), ".pi"),
  );
  expect(unlisted).toEqual({
    conversation: null,
    error: "Choose this project with the folder picker.",
  });
  expect(second.children()).toHaveLength(0);
  expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
    version: 1,
    recentProjects: [project],
  });
  await second.page.screenshot({ path: info.outputPath("recent-projects.png") });
  await entries.click();
  const list = second.page.getByRole("region", { name: "Saved sessions" });
  await expect(list.getByRole("radio")).toHaveCount(1, { timeout: 15000 });
  await expect(list.getByRole("radio")).toHaveAccessibleName(/Saved before Quit/);
  await expect(second.page.getByRole("region", { name: "Current project" })).toContainText(project);
  await expect(second.page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await expect(second.page.getByRole("status")).toHaveText("Idle");
  expect(lifecycle.requests).toHaveLength(1);
});

test("#193 keeps one recent entry for a project chosen through a path alias", async ({
  lifecycle,
}) => {
  const project = await realpath(lifecycle.project);
  const other = join(lifecycle.home, "other");
  await mkdir(other);
  const alias = join(lifecycle.home, "alias");
  await symlink(lifecycle.project, alias);
  for (const selected of [lifecycle.project, other, alias]) {
    const { app, page, process: main } = await lifecycle.launch(false);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, selected);
    await page.getByRole("button", { name: "Choose project" }).click();
    await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
    await app.evaluate(({ app: application }) => {
      setImmediate(() => application.quit());
    });
    await expect.poll(() => main.exitCode).toBe(0);
  }
  const { page } = await lifecycle.launch(false);
  const entries = page.getByRole("region", { name: "Recent projects" }).getByRole("button");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toHaveAccessibleName(`project ${project}`);
  await expect(entries.nth(1)).toHaveAccessibleName(`other ${await realpath(other)}`);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 keeps a missing recent project with an actionable error", async ({
  lifecycle,
}, info) => {
  const project = await realpath(lifecycle.project);
  const first = await lifecycle.launch();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  const moved = join(lifecycle.home, "moved");
  await rename(lifecycle.project, moved);

  const { page, children } = await lifecycle.launch(false);
  const entries = page.getByRole("region", { name: "Recent projects" }).getByRole("button");
  await entries.click();
  await expect(page.getByRole("alert")).toContainText(`Could not find ${project}`);
  await expect(page.getByRole("alert")).toContainText("stays in your recent projects");
  await expect(entries).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  expect(children()).toHaveLength(0);
  expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
    version: 1,
    recentProjects: [project],
  });
  await page.screenshot({ path: info.outputPath("missing-project.png") });
  await rename(moved, lifecycle.project);
  await entries.click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(page.getByRole("region", { name: "Saved sessions" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(lifecycle.requests).toHaveLength(0);
});

test("#193 preserves unreadable metadata and still opens a chosen project", async ({
  lifecycle,
}) => {
  const metadata = join(lifecycle.home, "metadata.json");
  await writeFile(metadata, "{ not json");
  const { app, page, process: main } = await lifecycle.launch(false);
  await expect(page.getByRole("alert")).toContainText(
    `Cannot read Pidex metadata: ${await realpath(metadata)}`,
  );
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await app.evaluate(({ app: application }) => {
    setImmediate(() => application.quit());
  });
  await expect.poll(() => main.exitCode).toBe(0);
  expect(await readFile(metadata, "utf8")).toBe("{ not json");
});

test("#193 shows a metadata save failure and saves after the folder is writable again", async ({
  lifecycle,
}) => {
  await using cleanup = new AsyncDisposableStack();
  const { app, page, process: main } = await lifecycle.launch(false);
  await chmod(lifecycle.home, 0o500);
  cleanup.defer(() => chmod(lifecycle.home, 0o700));
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(page.getByRole("alert")).toContainText("Cannot save Pidex metadata");
  await chmod(lifecycle.home, 0o700);
  expect(await readdir(lifecycle.home)).not.toContain("metadata.json");
  await app.evaluate(({ app: application }) => {
    setImmediate(() => application.quit());
  });
  await expect.poll(() => main.exitCode).toBe(0);
  const second = await lifecycle.launch(false);
  await second.page.getByRole("button", { name: "Choose project" }).click();
  await expect(second.page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(second.page.getByRole("alert")).toHaveCount(0);
  expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
    version: 1,
    recentProjects: [await realpath(lifecycle.project)],
  });
});
