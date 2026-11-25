import { expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
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

test("#194 a lost Resume response keeps the previous session selected and usable", async ({
  lifecycle,
}, info) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Saved session context");
  await first.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved answer");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing saved session");
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);

  const second = await lifecycle.launch();
  const fault = await second.app.evaluateHandle(
    (_electron, modulePath) => {
      const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const prototype = NodeSocket.NodeWS.WebSocket.prototype;
      const originalEmit = prototype.emit;
      let armed = false;
      let dropped = false;
      prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        const data = String(args[0]);
        // Lose the connection exactly when the saved session's transcript is on its way back.
        if (armed && event === "message" && data.includes("Saved session context")) {
          armed = false;
          dropped = true;
          this.terminate();
          return true;
        }
        return originalEmit.apply(this, [event, ...args]);
      };
      return {
        arm: () => {
          armed = true;
        },
        wasDropped: () => dropped,
        restore: () => {
          prototype.emit = originalEmit;
        },
      };
    },
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  const list = second.page.getByRole("region", { name: "Saved sessions" });
  const composer = second.page.getByRole("textbox", { name: "Prompt" });
  await list.getByRole("radio").check();
  await composer.fill("Draft for the current session");
  await fault.evaluate((gate) => gate.arm());
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect.poll(() => fault.evaluate((gate) => gate.wasDropped())).toBe(true);
  await expect(list.getByRole("alert")).toContainText("Check the connection");
  await expect(second.page.getByRole("status")).toHaveText("Idle");
  await expect(second.page.getByRole("region", { name: "Messages" })).not.toContainText(
    "Saved session context",
  );
  await expect(composer).toHaveValue("Draft for the current session");
  await expect(second.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await second.page.screenshot({ path: info.outputPath("lost-resume.png") });
  await fault.evaluate((gate) => gate.restore());
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(second.page.getByRole("region", { name: "Messages" })).toContainText(
    "Saved session context",
  );
  expect(lifecycle.requests).toHaveLength(1);
  expect(await readFile(saved.path, "utf8")).toBe(saved.bytes);
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

test("#194 resumes a Pi CLI session without writing to its history", async ({ lifecycle }) => {
  const project = await realpath(lifecycle.project);
  const seeded = SessionManager.create(
    project,
    join(
      lifecycle.home,
      ".pi",
      "agent",
      "sessions",
      `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    ),
  );
  seeded.appendMessage({ role: "user", content: "CLI prompt", timestamp: 1 });
  seeded.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "CLI reply" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-6-luna",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const file = seeded.getSessionFile();
  if (!file) throw new Error("Missing seeded session file");
  const bytes = await readFile(file, "utf8");
  // Pi records these when it opens a session; reading must not add them.
  expect(bytes).not.toContain("thinking_level_change");
  const { page } = await lifecycle.launch();
  const list = page.getByRole("region", { name: "Saved sessions" });
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("CLI reply");
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(lifecycle.requests).toHaveLength(0);
});
