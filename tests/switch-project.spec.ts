import { expect } from "@playwright/test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const busy = await app.page.evaluate(
    ({ target, selected }) =>
      window.desktop.switchProject(target, selected.projectPath, selected.id),
    { target: secondPath, selected: initial },
  );
  expect(busy.error).toBe("");
  const destination = busy.conversation;
  if (!destination) throw new Error("No selected conversation");
  expect(destination.projectPath).toBe(await realpath(secondProject));
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

test("#195 preflight failure keeps the previous session usable", async ({ lifecycle }) => {
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
  const missing = join(lifecycle.home, "missing-project");
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
