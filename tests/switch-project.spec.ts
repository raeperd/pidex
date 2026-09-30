import { expect, type Page } from "@playwright/test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive, test } from "./support/lifecycle.js";

test("#195 switches idle work to another project with its instructions, working directory, and recovery locator", async ({
  lifecycle,
}, info) => {
  const alpha = await realpath(lifecycle.project);
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  for (const [path, name] of [
    [alpha, "alpha"],
    [beta, "beta"],
  ] as const) {
    await writeFile(join(path, "AGENTS.md"), `Instructions for ${name} project.`);
    await writeFile(join(path, "marker.txt"), `${name} marker contents`);
  }
  const { app, page, children } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Remember the alpha lantern");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(1);
  expect(lifecycle.requestBodies[0]).toContain("Instructions for alpha project.");
  lifecycle.complete("Alpha lantern remembered.");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [alphaHistory] = await lifecycle.history();
  if (!alphaHistory) throw new Error("Missing alpha history");

  const before = await current(page);
  expect(
    await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
      beta,
      before.id,
    ] as const),
  ).toEqual({ error: "" });
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  const switched = await current(page);
  expect(switched.id).not.toBe(before.id);
  await app.evaluate(({ BrowserWindow }, sessionId) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("conversation", {
      _tag: "EntryUpserted",
      sessionId,
      entry: { id: "late-alpha-reply", role: "assistant", text: "Late alpha reply" },
    });
  }, before.id);
  await expect(page.getByRole("region", { name: "Saved sessions" })).toContainText(
    "No saved sessions in this project.",
  );
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);

  await prompt.fill("Read marker.txt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Instructions for beta project.");
  expect(lifecycle.requestBodies[1]).not.toContain("alpha");
  const response = lifecycle.requests[1];
  if (!response) throw new Error("Missing beta provider request");
  for (const [delta, finish_reason] of [
    [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "read-marker",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) },
          },
        ],
      },
      null,
    ],
    [{}, "tool_calls"],
  ] as const)
    response.write(
      `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
  await expect.poll(() => lifecycle.requestBodies.length).toBe(3);
  expect(lifecycle.requestBodies[2]).toContain("beta marker contents");
  lifecycle.complete("Beta marker read.");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Beta marker read.");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const betaHistory = (await lifecycle.history()).find((file) => file.path !== alphaHistory.path);
  expect(JSON.parse(betaHistory?.bytes.split("\n")[0] ?? "{}")).toMatchObject({
    id: switched.id,
    cwd: beta,
  });
  expect(await readFile(alphaHistory.path, "utf8")).toBe(alphaHistory.bytes);

  // The Desktop recovery locator follows the switch: a crash restores the beta session.
  const [backend] = children();
  if (!backend) throw new Error("Missing Pi backend");
  process.kill(backend, "SIGKILL");
  await expect.poll(() => alive(backend)).toBe(false);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Beta marker read.");

  const restored = await current(page);
  expect(
    await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
      alpha,
      restored.id,
    ] as const),
  ).toEqual({ error: "" });
  const list = page.getByRole("region", { name: "Saved sessions" });
  await expect(list.getByRole("radio")).toHaveCount(1);
  await list.getByRole("radio").check();
  await list.getByRole("button", { name: "Resume session" }).click();
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(
    "Alpha lantern remembered.",
  );
  await prompt.fill("What did I ask you to remember?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(4);
  expect(lifecycle.requestBodies[3]).toContain("Instructions for alpha project.");
  expect(lifecycle.requestBodies[3]).toContain("alpha lantern");
  expect(lifecycle.requestBodies[3]).not.toContain("beta");
  lifecycle.complete("The alpha lantern.");
  await expect(page.getByRole("status")).toHaveText("Idle");
  expect((await readFile(alphaHistory.path, "utf8")).startsWith(alphaHistory.bytes)).toBe(true);
  expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
    version: 1,
    recentProjects: [alpha, beta],
  });
  await page.screenshot({ path: info.outputPath("switched-back.png") });
});

test("#195 rejects switching and stale sends while a run is active", async ({ lifecycle }) => {
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  const { page } = await lifecycle.launch();
  const selected = await current(page);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Keep this run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const busy = await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
    beta,
    selected.id,
  ] as const);
  expect(busy.error).toContain("Wait for the current reply");
  lifecycle.complete("Same run");
  await expect(page.getByRole("status")).toHaveText("Idle");

  const stale = await page.evaluate(([path]) => window.desktop.switchProject(path, "stale-id"), [
    beta,
  ] as const);
  expect(stale.error).toContain("selected session changed");
  const staleSend = await page.evaluate(() =>
    window.desktop.send("Stale prompt", crypto.randomUUID(), "stale-id").then(() => "", String),
  );
  expect(staleSend).toContain("selected session changed");
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(
    await realpath(lifecycle.project),
  );
  expect(lifecycle.requests).toHaveLength(1);
  expect(await lifecycle.history()).toHaveLength(1);
});

test("#195 keeps the current session and recovery locator when the destination is unavailable", async ({
  lifecycle,
}) => {
  const { page, children } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Keep this history");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Kept reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [saved] = await lifecycle.history();
  if (!saved) throw new Error("Missing saved history");
  const selected = await current(page);
  const missing = join(await realpath(lifecycle.home), "missing");
  const result = await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
    missing,
    selected.id,
  ] as const);
  expect(result.error).toContain(`Could not open ${missing}`);
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Kept reply");
  expect((await current(page)).id).toBe(selected.id);

  const [backend] = children();
  if (!backend) throw new Error("Missing Pi backend");
  process.kill(backend, "SIGKILL");
  await expect.poll(() => alive(backend)).toBe(false);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Kept reply");
  await prompt.fill("Continue after the failed switch");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Keep this history");
  lifecycle.complete("Continued");
  await expect(page.getByRole("status")).toHaveText("Idle");
  expect(await lifecycle.history()).toHaveLength(1);
});

function current(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ id: string; projectPath: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((value) => {
          if (value?._tag !== "Snapshot") return;
          unsubscribe();
          resolve(value.conversation);
        });
      }),
  );
}
