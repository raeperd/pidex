import { expect } from "@playwright/test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./support/lifecycle.js";

test("#195 switches the owned server to a second project and rejects stale targets", async ({
  lifecycle,
}) => {
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  const secondPath = await realpath(secondProject);
  await writeFile(join(lifecycle.project, "AGENTS.md"), "First project instruction");
  await writeFile(join(secondProject, "AGENTS.md"), "Second project instruction");
  const app = await lifecycle.launch();
  const initial = await app.page.evaluate(
    () =>
      new Promise<{ projectPath: string; id: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({ projectPath: update.conversation.projectPath, id: update.conversation.id });
          }
        });
      }),
  );
  await app.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondPath);
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: "Choose project" })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(
    "second-project",
  );
  await app.page.evaluate(() => {
    const unsubscribe = window.desktop.subscribe((update) => {
      if (update?._tag === "EntryUpserted" && update.entry.id === "late-old-session") {
        document.body.dataset.staleDelivered = "true";
        unsubscribe();
      }
    });
  });
  await app.app.evaluate(({ BrowserWindow }, oldId) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("conversation", {
      _tag: "EntryUpserted",
      sessionId: oldId,
      entry: { id: "late-old-session", role: "assistant", text: "STALE_OLD_EVENT" },
    });
  }, initial.id);
  await expect(app.page.locator("body")).toHaveAttribute("data-stale-delivered", "true");
  await expect(app.page.getByRole("region", { name: "Messages" })).not.toContainText(
    "STALE_OLD_EVENT",
  );
  expect(app.children()).toHaveLength(1);
  const stale = await app.page.evaluate(
    ({ target, selected }) =>
      window.desktop.switchProject(target, selected.projectPath, selected.id),
    { target: initial.projectPath, selected: initial },
  );
  expect(stale.error).toContain("selected session changed");
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Read this project's instructions");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  await expect
    .poll(() => JSON.stringify(lifecycle.providerInputs[0]))
    .toContain("Second project instruction");
  expect(JSON.stringify(lifecycle.providerInputs[0])).not.toContain("First project instruction");
  lifecycle.complete("Second project selected");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const metadata = JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"));
  expect(metadata.recentProjects[0]).toBe(await realpath(secondProject));
});

test("#195 disables navigation during a run and rejects competing API operations", async ({
  lifecycle,
}) => {
  const app = await lifecycle.launch();
  const projectPath = await realpath(lifecycle.project);
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  const target = await realpath(secondProject);
  await writeFile(
    join(lifecycle.home, "metadata.json"),
    JSON.stringify({ version: 1, recentProjects: [projectPath, target] }),
  );
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Saved before busy run");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved answer");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const listed = await app.page.evaluate((path) => window.desktop.listSessions(path), projectPath);
  const locator = listed.sessions[0];
  if (!locator) throw new Error("Missing saved session");
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Keep running");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  await expect(app.page.getByRole("button", { name: "Projects" })).toBeDisabled();
  await expect(app.page.getByRole("button", { name: "New session" })).toBeDisabled();
  const rejected = await app.page.evaluate(
    async ({ nextProject, savedSession }) => {
      const current = await new Promise<{ projectPath: string; id: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({ projectPath: update.conversation.projectPath, id: update.conversation.id });
          }
        });
      });
      return {
        switched: await window.desktop.switchProject(nextProject, current.projectPath, current.id),
        created: await window.desktop
          .newSession(current.projectPath, current.id)
          .then(() => "", String),
        resumed: await window.desktop.resumeSession(savedSession),
        sent: await window.desktop.send("competing prompt").then(() => "", String),
      };
    },
    { nextProject: target, savedSession: locator },
  );
  expect(rejected.switched.error).toContain("Wait for the current run");
  expect(rejected.created).toContain("Wait for the current reply");
  expect(rejected.resumed.error).toContain("Wait for the current run");
  expect(rejected.sent).toContain("Wait for the current reply");
  expect(lifecycle.requests).toHaveLength(2);
  lifecycle.complete("Busy run finished");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(
    projectPath,
  );
});

test("#195 preflight failure keeps the previous session usable", async ({ lifecycle }) => {
  const missing = join(lifecycle.home, "missing-project");
  await writeFile(
    join(lifecycle.home, "metadata.json"),
    JSON.stringify({ version: 1, recentProjects: [missing] }),
  );
  const app = await lifecycle.launch();
  const selected = await app.page.evaluate(
    () =>
      new Promise<{ projectPath: string; id: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({ projectPath: update.conversation.projectPath, id: update.conversation.id });
          }
        });
      }),
  );
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: missing })
    .click();
  await expect(app.page.getByRole("alert")).toContainText("Cannot open");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const result = await app.page.evaluate(
    (target) => window.desktop.switchProject(target.missing, target.projectPath, target.id),
    { missing, ...selected },
  );
  expect(result.error).toContain("Cannot open");
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Previous work remains usable");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Still here");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
});

test("#195 locator acknowledgment failure disables Send and recovers the previous session", async ({
  lifecycle,
}) => {
  const app = await lifecycle.launch();
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Preserve this history");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Previous reply");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const [old] = await lifecycle.history();
  if (!old) throw new Error("Missing previous history");
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  const target = await realpath(secondProject);
  const fault = await app.app.evaluateHandle((_electron, destination) => {
    const childProcess = process.getBuiltinModule("child_process");
    const prototype = childProcess.ChildProcess.prototype;
    const original = prototype.emit;
    let dropped = false;
    prototype.emit = function (
      this: import("node:child_process").ChildProcess,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const locator: unknown = args[0];
      if (
        event === "message" &&
        typeof locator === "object" &&
        locator !== null &&
        "type" in locator &&
        locator.type === "session-locator" &&
        "projectPath" in locator &&
        locator.projectPath === destination
      ) {
        const send = this.send;
        this.send = function (
          this: import("node:child_process").ChildProcess,
          ...values: unknown[]
        ) {
          const message = values[0];
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "session-locator-ack"
          ) {
            dropped = true;
            return true;
          }
          return send.apply(this, values as Parameters<typeof send>);
        } as typeof send;
      }
      return original.apply(this, [event, ...args] as Parameters<typeof original>);
    } as typeof original;
    return { dropped: () => dropped };
  }, target);
  const selected = await app.page.evaluate(
    () =>
      new Promise<{ projectPath: string; id: string; sessionFile: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({
              projectPath: update.conversation.projectPath,
              id: update.conversation.id,
              sessionFile: update.conversation.sessionFile,
            });
          }
        });
      }),
  );
  expect(selected.sessionFile).toBe(old.path);
  const result = await app.page.evaluate(
    ({ path, current }) => window.desktop.switchProject(path, current.projectPath, current.id),
    { path: target, current: selected },
  );
  expect(result.error).toContain("recovery locator");
  expect(await fault.evaluate((gate) => gate.dropped())).toBe(true);
  await expect(app.page.getByRole("status")).toHaveText("Unavailable");
  await expect(app.page.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(await readFile(old.path, "utf8")).toBe(old.bytes);
  const restartResult = await app.page.evaluate(() => window.desktop.restart());
  expect(restartResult).toBeNull();
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const recovered = await app.page.evaluate(
    () =>
      new Promise<{ projectPath: string; sessionFile: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({
              projectPath: update.conversation.projectPath,
              sessionFile: update.conversation.sessionFile,
            });
          }
        });
      }),
  );
  expect(recovered.sessionFile).toBe(old.path);
  await expect(app.page.getByRole("region", { name: "Messages" })).toContainText("Previous reply");
});

test("#195 restores each project's history and executes tools in its selected directory", async ({
  lifecycle,
}) => {
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  await writeFile(join(lifecycle.project, "AGENTS.md"), "Use the first project's instructions");
  await writeFile(join(secondProject, "AGENTS.md"), "Use the second project's instructions");
  await writeFile(join(secondProject, "marker.txt"), "SECOND_DIRECTORY_MARKER");
  const app = await lifecycle.launch();
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Remember first history");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  await expect
    .poll(() => JSON.stringify(lifecycle.providerInputs[0]))
    .toContain("first project's instructions");
  lifecycle.complete("First history answer");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  await app.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondProject);
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: "Choose project" })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(
    "second-project",
  );
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Read the selected marker");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  await expect
    .poll(() => JSON.stringify(lifecycle.providerInputs[1]))
    .toContain("second project's instructions");
  expect(JSON.stringify(lifecycle.providerInputs[1])).not.toContain("First history answer");
  const response = lifecycle.requests[1];
  if (!response) throw new Error("Missing provider response");
  response.write(
    `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "selected-cwd", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "pwd && cat marker.txt" }) } }] }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "tool", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  await expect.poll(() => lifecycle.requests.length).toBe(3);
  await expect(app.page.getByRole("region", { name: "Messages" })).toContainText(
    "SECOND_DIRECTORY_MARKER",
  );
  await expect(app.page.getByRole("region", { name: "Messages" })).toContainText(
    await realpath(secondProject),
  );
  lifecycle.complete("Second history answer");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: await realpath(lifecycle.project) })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText("project");
  const sessions = app.page.getByRole("region", { name: "Saved sessions" });
  await expect(sessions.getByRole("radio")).toHaveCount(1);
  await sessions.getByRole("radio").check();
  await sessions.getByRole("button", { name: "Resume session" }).click();
  await expect(app.page.getByRole("region", { name: "Messages" })).toContainText(
    "First history answer",
  );
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Recall first history");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(4);
  await expect
    .poll(() => JSON.stringify(lifecycle.providerInputs[3]))
    .toContain("First history answer");
  expect(JSON.stringify(lifecycle.providerInputs[3])).not.toContain("Second history answer");
  lifecycle.complete("First history restored");
});

test("#195 keeps navigation disabled until Stop settles", async ({ lifecycle }) => {
  const app = await lifecycle.launch(false);
  await app.app.evaluate(
    (_electron, config) => {
      process.env.NODE_OPTIONS = `--import=${config.fixture}`;
      process.env.PIDEX_TEST_PROVIDER_URL = config.providerUrl;
    },
    {
      fixture: fileURLToPath(new URL("./fixtures/cancellation-fetch.mjs", import.meta.url)),
      providerUrl: lifecycle.providerUrl,
    },
  );
  await app.page.getByRole("button", { name: "Choose project" }).click();
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const projectPath = await realpath(lifecycle.project);
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  const target = await realpath(secondProject);
  await writeFile(
    join(lifecycle.home, "metadata.json"),
    JSON.stringify({ version: 1, recentProjects: [projectPath, target] }),
  );
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Save a session");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved answer");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const listed = await app.page.evaluate((path) => window.desktop.listSessions(path), projectPath);
  const saved = listed.sessions[0];
  if (!saved) throw new Error("Missing saved session");
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Stop this run");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  lifecycle.requests[1]?.write(
    `data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: "gpt-5.6-luna", choices: [{ index: 0, delta: { role: "assistant", content: "Working" }, finish_reason: null }] })}\n\n`,
  );
  await app.page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(app.page.getByRole("status")).toHaveText("Stopping");
  await expect(app.page.getByRole("button", { name: "Projects" })).toBeDisabled();
  await expect(app.page.getByRole("button", { name: "New session" })).toBeDisabled();
  const rejected = await app.page.evaluate(
    async ({ targetPath, savedSession }) => {
      const current = await new Promise<{ projectPath: string; id: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((update) => {
          if (update?._tag === "Snapshot") {
            unsubscribe();
            resolve({ projectPath: update.conversation.projectPath, id: update.conversation.id });
          }
        });
      });
      return {
        switched: await window.desktop.switchProject(targetPath, current.projectPath, current.id),
        created: await window.desktop
          .newSession(current.projectPath, current.id)
          .then(() => "", String),
        resumed: await window.desktop.resumeSession(savedSession),
        sent: await window.desktop.send("while stopping").then(() => "", String),
      };
    },
    { targetPath: target, savedSession: saved },
  );
  expect(rejected.switched.error).toContain("Wait for the current run");
  expect(rejected.created).toContain("Wait for the current reply");
  expect(rejected.resumed.error).toContain("Wait for the current run");
  expect(rejected.sent).toContain("Wait for the current reply");
  await expect.poll(() => lifecycle.cancellations.length).toBe(1);
  lifecycle.acknowledgeCancellation();
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  expect(lifecycle.requests).toHaveLength(2);
});

test("#195 a missing saved file in the destination leaves the current selection usable", async ({
  lifecycle,
}) => {
  const secondProject = join(lifecycle.home, "second-project");
  await mkdir(secondProject);
  const app = await lifecycle.launch();
  await app.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondProject);
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: "Choose project" })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(
    "second-project",
  );
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Save second history");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Second history saved");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  const secondPath = await realpath(secondProject);
  const saved = (await app.page.evaluate((path) => window.desktop.listSessions(path), secondPath))
    .sessions[0];
  if (!saved) throw new Error("Missing saved session");
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: await realpath(lifecycle.project) })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(
    await realpath(lifecycle.project),
  );
  await app.page.getByRole("button", { name: "Projects" }).click();
  await app.page
    .getByRole("region", { name: "Switch project" })
    .getByRole("button", { name: secondPath })
    .click();
  await expect(app.page.getByRole("region", { name: "Current project" })).toContainText(secondPath);
  const sessions = app.page.getByRole("region", { name: "Saved sessions" });
  await expect(sessions.getByRole("radio")).toHaveCount(1);
  await rm(saved.sessionFile);
  await sessions.getByRole("radio").check();
  await sessions.getByRole("button", { name: "Resume session" }).click();
  await expect(sessions.getByRole("alert")).toContainText("missing, unreadable, or changed");
  await expect(app.page.getByRole("status")).toHaveText("Idle");
  await app.page.getByRole("textbox", { name: "Prompt" }).fill("Still usable after missing file");
  await app.page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  lifecycle.complete("Current selection stayed usable");
  expect(
    await readFile(saved.sessionFile, "utf8").then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
