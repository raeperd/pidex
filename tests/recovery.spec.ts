import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { chmod, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { alive, test } from "./support/lifecycle.js";

test("#135 manually recovers the exact saved session after idle and busy crashes", async ({
  lifecycle,
}) => {
  const { app, page, process: main, children } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await prompt.fill("Remember pear");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved pear");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const saved = await lifecycle.history();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.bytes).toContain("Saved pear");
  for (const busy of [false, true]) {
    if (busy) {
      // Drop the running update at the transport boundary; Pi still accepts the prompt.
      await app.evaluate(
        (_electron, modulePath) => {
          const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
            modulePath,
          );
          const prototype = NodeSocket.NodeWS.WebSocket.prototype;
          const original = prototype.emit;
          prototype.emit = function (event: string | symbol, ...args: unknown[]) {
            if (event === "message" && String(args[0]).includes('"status":"running"')) {
              prototype.emit = original;
              return true;
            }
            return original.apply(this, [event, ...args]);
          };
        },
        fileURLToPath(import.meta.resolve("@effect/platform-node")),
      );
      await prompt.fill("Continue");
      await send.click();
      await expect.poll(() => lifecycle.requests.length).toBe(2);
      await expect(page.getByRole("status")).toHaveText("Idle");
    }
    const [oldChild] = children();
    if (!oldChild) throw new Error("Missing child");
    process.kill(oldChild, "SIGKILL");
    await expect.poll(() => alive(oldChild)).toBe(false);
    const beforeRestart = await lifecycle.history();
    await expect(page.getByRole("alert")).toContainText("backend stopped");
    await expect(send).toBeDisabled();
    expect(main.pid && alive(main.pid)).toBe(true);
    expect(children()).toEqual([]);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await page.evaluate(() => Promise.all([window.desktop.restart(), window.desktop.restart()]));
    await expect(page.getByRole("status")).toHaveText("Idle");
    expect(await lifecycle.history()).toEqual(beforeRestart);
    await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Saved pear");
    expect(children()).toHaveLength(1);
    expect(children()[0]).not.toBe(oldChild);
    expect(lifecycle.requests).toHaveLength(busy ? 2 : 1);
    if (!busy) expect(await lifecycle.history()).toEqual(saved);
    else await expect(page.getByRole("alert")).toContainText("interrupted");
  }
  await prompt.fill("Next");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(3);
  lifecycle.complete("Ready");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(["Saved pear", "Ready"]);
});

test("#135 discards an unestablished locator before choosing another project", async ({
  lifecycle,
}) => {
  const { app, page } = await lifecycle.launch(false);
  await app.evaluate(
    (_electron, modulePath) => {
      const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const prototype = NodeSocket.NodeWS.WebSocket.prototype;
      const original = prototype.emit;
      let drop = true;
      prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "message" && drop) {
          drop = false;
          // A dropped socket now reconnects. Crash the child before its first snapshot instead.
          const child = process
            .getBuiltinModule("child_process")
            .execFileSync("pgrep", ["-P", String(process.pid), "-f", "/dist/server/main.js"], {
              encoding: "utf8",
            });
          process.kill(Number(child.trim()), "SIGKILL");
          this.terminate();
          return true;
        }
        return original.apply(this, [event, ...args]);
      };
    },
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not open the project");
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondProject);
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Prompt" }).fill("New project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("New project reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const files = await lifecycle.history();
  expect(files).toHaveLength(1);
  expect(files[0]?.path).toContain("second-project");
});

for (const firstTurn of [false, true]) {
  test(`#136 explains missing history after ${firstTurn ? "an unsaved first turn" : "removing the saved file"}`, async ({
    lifecycle,
  }) => {
    const { page, children } = await lifecycle.launch();
    const identity = await page.evaluate(() =>
      window.desktop.chooseProject().then((value) => value?.id),
    );
    await page.getByRole("textbox", { name: "Prompt" }).fill("Remember pear");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => lifecycle.requests.length).toBe(1);
    if (!firstTurn) {
      lifecycle.complete("Saved pear");
      await expect(page.getByRole("status")).toHaveText("Idle");
    }
    const [child] = children();
    if (!child) throw new Error("Missing child");
    process.kill(child, "SIGKILL");
    await expect.poll(() => alive(child)).toBe(false);
    const files = await lifecycle.history();
    expect(files).toHaveLength(firstTurn ? 0 : 1);
    const other = files[0]
      ? { path: `${files[0].path}.other.jsonl`, bytes: files[0].bytes }
      : undefined;
    if (other) await writeFile(other.path, other.bytes);
    for (const file of files) await rm(file.path);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Idle");
    await expect(page.getByRole("alert")).toContainText("Saved history is missing");
    await expect(
      page.getByRole("heading", { name: "What would you like to build?" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.desktop.chooseProject().then((value) => value?.id)),
    ).not.toBe(identity);
    expect(lifecycle.requests).toHaveLength(1);
    expect(await lifecycle.history()).toEqual(other ? [other] : []);
    expect(children()).toHaveLength(1);
    await page.getByRole("textbox", { name: "Prompt" }).fill("Next");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });
}

test("#136 preserves unreadable history and reports the replacement child's permission error", async ({
  lifecycle,
}) => {
  const { app, page: initialPage, children } = await lifecycle.launch();
  let page = initialPage;
  await page.getByRole("textbox", { name: "Prompt" }).fill("Remember pear");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved pear");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing history");
  const [child] = children();
  if (!child) throw new Error("Missing child");
  process.kill(child, "SIGKILL");
  await expect.poll(() => alive(child)).toBe(false);
  await chmod(saved.path, 0);
  try {
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Cannot read saved history" }),
    ).toContainText("EACCES");
    await expect(
      page.getByRole("alert").filter({ hasText: "Cannot read saved history" }),
    ).toContainText("permissions");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(lifecycle.requests).toHaveLength(1);
    await expect.poll(children).toEqual([]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => app.windows().length).toBe(0);
    await app.evaluate(({ app: application }) => application.emit("activate"));
    page = await app.firstWindow();
    await expect(
      page.getByRole("alert").filter({ hasText: "Cannot read saved history" }),
    ).toContainText("EACCES");
  } finally {
    await chmod(saved.path, 0o600);
    expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);
    expect(await lifecycle.history()).toEqual([saved]);
  }
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Saved pear");
  expect(await lifecycle.history()).toEqual([saved]);
  expect(lifecycle.requests).toHaveLength(1);
});

test("#135 clears the crash notice when Restart completes in a recreated window", async ({
  lifecycle,
}) => {
  const { app, page, children } = await lifecycle.launch();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Remember pear");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved pear");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const saved = await lifecycle.history();
  const [child] = children();
  if (!child) throw new Error("Missing child");
  process.kill(child, "SIGKILL");
  await expect.poll(() => alive(child)).toBe(false);
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  const held = app.evaluate(
    ({ app: application }, modulePath) =>
      new Promise<void>((resolve) => {
        const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
          modulePath,
        );
        const prototype = NodeSocket.NodeWS.WebSocket.prototype;
        const original = prototype.emit;
        prototype.emit = function (event: string | symbol, ...args: unknown[]) {
          if (event === "message" && String(args[0]).includes('"Snapshot"')) {
            prototype.emit = original;
            process
              .getBuiltinModule("events")
              .EventEmitter.prototype.once.call(application, "pidex-test-release-snapshot", () =>
                original.apply(this, [event, ...args]),
              );
            resolve();
            return true;
          }
          return original.apply(this, [event, ...args]);
        };
      }),
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await held;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.windows().length).toBe(0);
  await app.evaluate(({ app: application }) => application.emit("activate"));
  const reopened = await app.firstWindow();
  await expect(reopened.getByRole("status")).toHaveText("Disconnected");
  await app.evaluate(({ app: application }) => application.emit("pidex-test-release-snapshot"));
  await expect(reopened.getByRole("status")).toHaveText("Idle");
  await expect(reopened.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  await expect(reopened.getByLabel("assistant", { exact: true })).toHaveText("Saved pear");
  expect(children()).toHaveLength(1);
  expect(await lifecycle.history()).toEqual(saved);
  expect(lifecycle.requests).toHaveLength(1);
});

test("#135 restores Restart after a backend crash while the window is closed", async ({
  lifecycle,
}) => {
  const { app, page, children, process: main } = await lifecycle.launch();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Remember pear");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved pear");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const saved = await lifecycle.history();
  const [child] = children();
  if (!child) throw new Error("Missing child");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.windows().length).toBe(0);
  process.kill(child, "SIGKILL");
  await expect.poll(() => alive(child)).toBe(false);
  expect(main.pid && alive(main.pid)).toBe(true);
  expect(children()).toEqual([]);
  await app.evaluate(({ app: application }) => application.emit("activate"));
  const reopened = await app.firstWindow();
  await expect(reopened.getByRole("alert")).toContainText("backend stopped");
  await expect(reopened.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await reopened.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(reopened.getByRole("status")).toHaveText("Idle");
  await expect(reopened.getByLabel("assistant", { exact: true })).toHaveText("Saved pear");
  expect(children()).toHaveLength(1);
  expect(children()[0]).not.toBe(child);
  expect(await lifecycle.history()).toEqual(saved);
  expect(lifecycle.requests).toHaveLength(1);
});
