import { expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "./support/lifecycle.js";

test("#191 lists only the canonical project's Pi histories, newest activity first, without continuing", async ({
  lifecycle,
}, info) => {
  const project = await realpath(lifecycle.project);
  const other = join(await realpath(lifecycle.home), "other");
  await mkdir(other);
  const alias = join(lifecycle.home, "alias");
  await symlink(project, alias);
  const older = seed(project, "Older prompt", 1000);
  const newer = seed(project, "Newer prompt", 2000, "Named CLI session");
  const unrelated = seed(other, "Other project prompt", 3000);
  const otherFile = unrelated.getSessionFile();
  if (!otherFile) throw new Error("Missing fixture history");
  // Pi's directory naming is not an identity boundary: misplaced/overlapping histories stay hidden.
  await copyFile(otherFile, join(older.getSessionDir(), "other-project.jsonl"));
  const originals = await lifecycle.history();

  for (const { path, expected } of [
    { path: alias, expected: [newer, older] },
    { path: other, expected: [unrelated] },
  ]) {
    const { app, page, process: main } = await lifecycle.launch(false);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, path);
    await page.getByRole("button", { name: "Choose project" }).click();
    const list = page.getByRole("region", { name: "Saved sessions" });
    await expect(list).toBeVisible({ timeout: 15000 });
    const entries = list.getByRole("radio");
    await expect(entries).toHaveCount(expected.length);
    for (const [index, session] of expected.entries()) {
      await expect(entries.nth(index)).toHaveAttribute("value", session.getSessionId());
      await expect(list.locator("time").nth(index)).toHaveAttribute(
        "datetime",
        new Date(index === 0 && path === alias ? 2000 : path === other ? 3000 : 1000).toISOString(),
      );
    }
    await entries.first().check();
    await expect(list.getByLabel("Session file", { exact: true })).toHaveText(
      expected[0]?.getSessionFile() ?? "missing session",
    );
    await expect(list.getByLabel("Project directory", { exact: true })).toHaveText(
      path === alias ? project : other,
    );
    await expect(list).toContainText(path === alias ? "Named CLI session" : "Other project prompt");
    const wrongProject = await page.evaluate(
      (projectPath) => window.desktop.listSessions(projectPath),
      path === alias ? other : project,
    );
    expect(wrongProject.sessions).toHaveLength(0);
    expect(wrongProject.errors[0]?.path).toBe(path === alias ? other : project);
    expect(wrongProject.errors[0]?.message).toContain("not the selected project");
    expect(lifecycle.requests).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(path === alias ? "project.png" : "other.png") });
    await app
      .context()
      .tracing.stop({ path: info.outputPath(path === alias ? "project.zip" : "other.zip") });
    await app.evaluate(({ app: application }) => {
      setImmediate(() => application.quit());
    });
    await expect.poll(() => main.exitCode).toBe(0);
  }
  for (const file of originals) expect(await readFile(file.path, "utf8")).toBe(file.bytes);
  expect(await lifecycle.history()).toEqual(originals);

  function seed(cwd: string, prompt: string, timestamp: number, name?: string) {
    const directory = join(
      lifecycle.home,
      ".pi",
      "agent",
      "sessions",
      `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    );
    const session = SessionManager.create(cwd, directory);
    session.appendMessage({ role: "user", content: prompt, timestamp });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Saved reply" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
    if (name) {
      session.appendSessionInfo(name);
      session.appendMessage({ role: "user", content: "Unfinished saved prompt", timestamp });
    }
    return session;
  }
});

test("#191 explains an inaccessible history root before session startup and allows retry", async ({
  lifecycle,
}) => {
  await using cleanup = new AsyncDisposableStack();
  const root = join(lifecycle.home, ".pi", "agent", "sessions");
  await mkdir(root);
  await chmod(root, 0);
  cleanup.defer(() => chmod(root, 0o700));
  const { page } = await lifecycle.launch(false);
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("alert")).toContainText(root, { timeout: 15000 });
  await expect(page.getByRole("alert")).toContainText("permissions");
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  await chmod(root, 0o700);
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("region", { name: "Saved sessions" })).toContainText(
    "No saved sessions in this project.",
    { timeout: 15000 },
  );
  expect(lifecycle.requests).toHaveLength(0);
});

for (const failure of ["file", "directory", "invalid metadata"]) {
  test(`#191 distinguishes empty history from unreadable ${failure} and preserves healthy Pidex history`, async ({
    lifecycle,
  }) => {
    await using cleanup = new AsyncDisposableStack();
    const first = await lifecycle.launch();
    const initialList = first.page.getByRole("region", { name: "Saved sessions" });
    await expect(initialList).toContainText("No saved sessions in this project.");
    expect(lifecycle.requests).toHaveLength(0);
    await first.page.getByRole("textbox", { name: "Prompt" }).fill("Saved Pidex prompt");
    await first.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => lifecycle.requests.length).toBe(1);
    lifecycle.complete("Saved Pidex reply");
    await expect(first.page.getByLabel("assistant", { exact: true })).toHaveText(
      "Saved Pidex reply",
    );
    await expect(first.page.getByRole("status")).toHaveText("Idle");
    const [original] = await lifecycle.history();
    if (!original) throw new Error("Missing saved Pidex history");
    await first.app.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await expect.poll(() => first.process.exitCode).toBe(0);
    const damaged =
      failure === "directory"
        ? dirname(original.path)
        : join(dirname(original.path), "unreadable.jsonl");
    if (failure === "invalid metadata") {
      await writeFile(damaged, original.bytes.replace(/"id":"[^"]+"/, '"id":"../invalid"'));
    } else {
      if (failure === "file") await copyFile(original.path, damaged);
      await chmod(damaged, 0);
      cleanup.defer(() => chmod(damaged, failure === "directory" ? 0o700 : 0o600));
    }
    const { page } = await lifecycle.launch();
    const list = page.getByRole("region", { name: "Saved sessions" });
    await expect(list.getByRole("alert")).toContainText(damaged);
    await expect(list.getByRole("alert")).toContainText("Check file and folder permissions");
    await expect(list.getByText("No saved sessions in this project.")).toHaveCount(0);
    await expect(list.getByRole("radio")).toHaveCount(failure === "directory" ? 0 : 1);
    if (failure !== "directory")
      await expect(list.getByRole("radio")).toHaveAccessibleName(/Saved Pidex prompt/);
    expect(lifecycle.requests).toHaveLength(1);
    if (failure !== "invalid metadata") {
      await chmod(damaged, failure === "directory" ? 0o700 : 0o600);
      await list.getByRole("button", { name: "Retry" }).click();
      await expect(list.getByRole("alert")).toHaveCount(0);
      await expect(list.getByRole("radio")).toHaveCount(failure === "file" ? 2 : 1);
    }
    expect(await readFile(original.path, "utf8")).toBe(original.bytes);
    if (failure === "file") expect(await readFile(damaged, "utf8")).toBe(original.bytes);
  });
}
