import { expect } from "@playwright/test";
import { chmod, readFile, realpath, rm } from "node:fs/promises";
import { alive, test } from "./support/lifecycle.js";

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
