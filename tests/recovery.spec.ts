import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./support/lifecycle.js";

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

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
