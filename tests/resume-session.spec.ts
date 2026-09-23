import { expect } from "@playwright/test";
import { chmod, readFile, realpath, rm } from "node:fs/promises";
import { alive, test } from "./support/lifecycle.js";
import { fileURLToPath } from "node:url";

test("#194 resumes saved Pi history after relaunch and appends follow-up context", async ({
  lifecycle,
}, info) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Remember the blue lantern");
  await first.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("I remember the blue lantern.");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const files = await lifecycle.history();
  expect(files).toHaveLength(1);
  const saved = files[0];
  if (!saved) throw new Error("Missing saved session");
  const children = first.children();
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  for (const pid of children) expect(alive(pid)).toBe(false);

  const second = await lifecycle.launch(false);
  await second.page.getByRole("button", { name: "Choose project" }).click();
  const list = second.page.getByRole("region", { name: "Saved sessions" });
  await expect(list.getByRole("radio")).toHaveCount(1);
  const listed = await second.page.evaluate(
    (projectPath) => window.desktop.listSessions(projectPath),
    await realpath(lifecycle.project),
  );
  const locator = listed.sessions[0];
  if (!locator) throw new Error("Missing listed session");
  const stale = await second.page.evaluate((target) => window.desktop.resumeSession(target), {
    projectPath: locator.projectPath,
    sessionFile: locator.sessionFile,
    sessionId: "stale-session-id",
  });
  expect(stale.error).toContain("missing, unreadable, or changed");
  expect(lifecycle.requests).toHaveLength(1);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(second.page.getByRole("region", { name: "Messages" })).toContainText("blue lantern");
  expect(lifecycle.requests).toHaveLength(1);
  expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);

  await second.page
    .getByRole("textbox", { name: "Prompt" })
    .fill("What did I ask you to remember?");
  await second.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  const busy = await second.page.evaluate((target) => window.desktop.resumeSession(target), {
    projectPath: locator.projectPath,
    sessionFile: locator.sessionFile,
    sessionId: locator.sessionId,
  });
  expect(busy.error).toContain("Wait for the current run");
  await expect.poll(() => JSON.stringify(lifecycle.providerInputs[1])).toContain("blue lantern");
  lifecycle.complete("The blue lantern.");
  await expect(second.page.getByRole("status")).toHaveText("Idle");
  const after = await readFile(saved.path, "utf8");
  expect(after.startsWith(saved.bytes)).toBe(true);
  expect(after).toContain("What did I ask you to remember?");
  expect(await lifecycle.history()).toHaveLength(1);
  await second.page.screenshot({ path: info.outputPath("resumed.png") });
});

test("#194 rejects a stale Resume request for the active session file", async ({ lifecycle }) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Current context");
  await first.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Current reply");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const listed = await first.page.evaluate(
    (projectPath) => window.desktop.listSessions(projectPath),
    await realpath(lifecycle.project),
  );
  const locator = listed.sessions[0];
  if (!locator) throw new Error("Missing active session locator");
  await rm(locator.sessionFile);
  const result = await first.page.evaluate(
    (target) => window.desktop.resumeSession(target),
    locator,
  );
  expect(result.error).toContain("missing, unreadable, or changed");
  expect(result.conversation).toBeNull();
  await expect(first.page.getByRole("status")).toHaveText("Unavailable");
  await expect(first.page.getByRole("button", { name: "Send" })).toBeDisabled();
  const sendFailure = await first.page.evaluate(() =>
    window.desktop.send("Do not recreate missing history").then(() => "", String),
  );
  expect(sendFailure).toContain("Wait for the current reply");
  expect(await lifecycle.history()).toHaveLength(0);
  await expect(first.page.getByRole("region", { name: "Messages" })).toContainText("Current reply");
  expect(lifecycle.requests).toHaveLength(1);
});

test("#194 reconciles a lost Resume acknowledgment before enabling Send or recovery", async ({
  lifecycle,
}, info) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Saved session context");
  await first.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved answer");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing saved session");
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);

  const second = await lifecycle.launch(false);
  const fault = await second.app.evaluateHandle(
    (_electron, modulePath) => {
      const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const prototype = NodeSocket.NodeWS.WebSocket.prototype;
      const originalSend = prototype.send;
      const originalEmit = prototype.emit;
      let armed = false;
      let requestId: number | undefined;
      let offline = false;
      let dropped = false;
      prototype.send = function (...args: unknown[]) {
        const data: unknown = JSON.parse(String(args[0]));
        if (
          armed &&
          typeof data === "object" &&
          data !== null &&
          "tag" in data &&
          data.tag === "ResumeSession" &&
          "id" in data &&
          typeof data.id === "number"
        ) {
          requestId = data.id;
          armed = false;
        }
        return originalSend.apply(this, args);
      };
      prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "open" && offline) {
          this.terminate();
          return true;
        }
        if (event === "message" && requestId !== undefined) {
          const data = String(args[0]);
          if (
            data.includes(`"requestId":${requestId}`) &&
            data.includes('"_tag":"Exit"') &&
            data.includes('"_tag":"Success"')
          ) {
            offline = true;
            requestId = undefined;
            dropped = true;
            this.terminate();
            return true;
          }
        }
        return originalEmit.apply(this, [event, ...args]);
      };
      return {
        arm: () => {
          armed = true;
        },
        wasDropped: () => dropped,
        reconnect: () => {
          offline = false;
        },
        restore: () => {
          prototype.send = originalSend;
          prototype.emit = originalEmit;
        },
      };
    },
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  await second.page.getByRole("button", { name: "Choose project" }).click();
  const list = second.page.getByRole("region", { name: "Saved sessions" });
  await expect(list.getByRole("radio")).toHaveCount(1);
  await list.getByRole("radio").check();
  const composer = second.page.getByRole("textbox", { name: "Prompt" });
  await composer.fill("Draft for the previous session");
  await fault.evaluate((gate) => gate.arm());
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect.poll(() => fault.evaluate((gate) => gate.wasDropped())).toBe(true);
  await expect
    .poll(
      async () =>
        (await list.getByRole("alert").allTextContents()).some((text) =>
          text.includes("uncertain"),
        ) ||
        (await second.page.getByRole("region", { name: "Messages" }).innerText()).includes(
          "Saved session context",
        ),
    )
    .toBe(true);
  // A matching snapshot may already have confirmed the new selection before the RPC fault.
  const draftBeforeReconnect = await composer.inputValue();
  expect(["", "Draft for the previous session"]).toContain(draftBeforeReconnect);
  await expect(second.page.getByRole("button", { name: "Send" })).toBeDisabled();
  await fault.evaluate((gate) => gate.reconnect());
  await expect(second.page.getByRole("region", { name: "Messages" })).toContainText(
    "Saved session context",
  );
  await expect(composer).toHaveValue("");
  expect(lifecycle.requests).toHaveLength(1);
  expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);
  await second.page.screenshot({ path: info.outputPath("reconciled-resume.png") });

  const [pid] = second.children();
  if (!pid) throw new Error("Missing Pi server");
  process.kill(pid, "SIGKILL");
  await expect(second.page.getByRole("button", { name: "Restart" })).toBeVisible();
  await second.page.getByRole("button", { name: "Restart" }).click();
  await expect(second.page.getByRole("region", { name: "Messages" })).toContainText(
    "Saved session context",
  );
  expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);
  await fault.evaluate((gate) => gate.restore());
  await second.app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    setImmediate(() => app.quit());
  });
  await expect.poll(() => second.process.exitCode).toBe(0);
});

test("#194 Restart resolves an uncertain Resume when the file is no longer available", async ({
  lifecycle,
}, info) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("History to restore");
  await first.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved answer");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing saved session");
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);

  const second = await lifecycle.launch(false);
  const fault = await second.app.evaluateHandle(
    (_electron, modulePath) => {
      const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const prototype = NodeSocket.NodeWS.WebSocket.prototype;
      const originalSend = prototype.send;
      const originalEmit = prototype.emit;
      let armed = false;
      let offline = false;
      prototype.send = function (...args: unknown[]) {
        if (armed && String(args[0]).includes('"tag":"ResumeSession"')) {
          armed = false;
          offline = true;
          this.terminate();
          return;
        }
        return originalSend.apply(this, args);
      };
      prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "open" && offline) {
          this.terminate();
          return true;
        }
        return originalEmit.apply(this, [event, ...args]);
      };
      return {
        arm: () => {
          armed = true;
        },
        restore: () => {
          prototype.send = originalSend;
          prototype.emit = originalEmit;
        },
      };
    },
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  await second.page.getByRole("button", { name: "Choose project" }).click();
  const list = second.page.getByRole("region", { name: "Saved sessions" });
  await expect(list.getByRole("radio")).toHaveCount(1);
  await list.getByRole("radio").check();
  const composer = second.page.getByRole("textbox", { name: "Prompt" });
  await composer.fill("Draft for old selection");
  await fault.evaluate((gate) => gate.arm());
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(second.page.getByRole("button", { name: "Restart" })).toBeVisible();
  await expect(second.page.getByRole("button", { name: "Send" })).toBeDisabled();
  await rm(saved.path);
  await fault.evaluate((gate) => gate.restore());
  await second.page.getByRole("button", { name: "Restart" }).click();
  await expect(second.page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(composer).toHaveValue("");
  await expect(second.page.getByRole("region", { name: "Messages" })).not.toContainText(
    "History to restore",
  );
  expect(lifecycle.requests).toHaveLength(1);
  await second.page.screenshot({ path: info.outputPath("uncertain-restart.png") });
  await second.app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    setImmediate(() => app.quit());
  });
  await expect.poll(() => second.process.exitCode).toBe(0);
});

for (const failure of ["missing", "unreadable"] as const)
  test(`#194 ${failure} saved file rejects resume and keeps the current session usable`, async ({
    lifecycle,
  }, info) => {
    const first = await lifecycle.launch();
    await first.page.getByRole("textbox", { name: "Prompt" }).fill("Keep this session");
    await first.page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => lifecycle.requests.length).toBe(1);
    lifecycle.complete("Saved reply");
    await expect(first.page.getByRole("status")).toHaveText("Idle");
    await first.app.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await expect.poll(() => first.process.exitCode).toBe(0);

    const second = await lifecycle.launch(false);
    await second.page.getByRole("button", { name: "Choose project" }).click();
    const list = second.page.getByRole("region", { name: "Saved sessions" });
    await expect(list.getByRole("radio")).toHaveCount(1);
    await list.getByRole("radio").check();
    const [saved] = await lifecycle.history();
    if (!saved) throw new Error("Missing saved session");
    if (failure === "missing") await rm(saved.path);
    else await chmod(saved.path, 0);
    await list.getByRole("button", { name: "Resume session" }).click();
    await expect(list.getByRole("alert")).toContainText("missing, unreadable, or changed");
    expect(lifecycle.requests).toHaveLength(1);
    if (failure === "missing") expect(await lifecycle.history()).toHaveLength(0);
    await expect(second.page.getByRole("button", { name: "Send" })).toBeDisabled();
    await second.page.screenshot({ path: info.outputPath(`${failure}-history.png`) });
    await list.getByRole("button", { name: "Retry" }).click();
    await expect(list.getByRole("radio")).toHaveCount(0);
    if (failure === "unreadable") {
      await chmod(saved.path, 0o600);
      expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);
    }
  });
