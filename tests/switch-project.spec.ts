import { expect, type Page } from "@playwright/test";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  await recent(lifecycle.home, [beta]);
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

test("#195 rejects switching, New session, Resume session, and stale or competing sends while running or stopping", async ({
  lifecycle,
}) => {
  const alpha = await realpath(lifecycle.project);
  const beta = join(await realpath(lifecycle.home), "beta");
  const unlisted = join(await realpath(lifecycle.home), "unlisted");
  await mkdir(beta);
  await mkdir(unlisted);
  await recent(lifecycle.home, [beta]);
  const { app, page } = await lifecycle.launch(false);
  await lifecycle.holdStops(app);
  await page.getByRole("button", { name: "Choose project" }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  const selected = await current(page);
  const attempts = () =>
    page.evaluate(
      async ([destination, projectPath, id, sessionFile]) => ({
        switch: (await window.desktop.switchProject(destination, id)).error,
        newSession: await window.desktop.newSession(projectPath, id).then(() => "", String),
        resume: (await window.desktop.resumeSession({ projectPath, sessionId: id, sessionFile }))
          .error,
        send: await window.desktop
          .send("Competing prompt", crypto.randomUUID(), id)
          .then(() => "", String),
      }),
      [beta, selected.projectPath, selected.id, selected.sessionFile] as const,
    );

  expect(
    await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
      unlisted,
      selected.id,
    ] as const),
  ).toEqual({ error: "Choose this project with the folder picker." });
  expect(
    await page.evaluate(
      ([path, id]) => window.desktop.newSession(path, id).then(() => "", String),
      [beta, selected.id] as const,
    ),
  ).toContain("selected project changed");
  const stale = await page.evaluate(([path]) => window.desktop.switchProject(path, "stale-id"), [
    beta,
  ] as const);
  expect(stale.error).toContain("selected session changed");
  const staleSend = await page.evaluate(() =>
    window.desktop.send("Stale prompt", crypto.randomUUID(), "stale-id").then(() => "", String),
  );
  expect(staleSend).toContain("selected session changed");
  expect(lifecycle.requests).toHaveLength(0);

  await page.getByRole("textbox", { name: "Prompt" }).fill("Keep this run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  for (const status of ["Running", "Stopping"]) {
    if (status === "Stopping") await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("status")).toHaveText(status);
    const rejected = await attempts();
    expect(rejected.switch).toContain("Wait for the current reply");
    expect(rejected.newSession).toContain("Wait for the current reply");
    expect(rejected.resume).toContain("Wait for the current run");
    expect(rejected.send).toContain("Wait for the current reply");
    expect((await current(page)).id).toBe(selected.id);
  }
  await expect.poll(() => lifecycle.cancellations.length).toBe(1);
  lifecycle.cancellations[0]?.end();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(alpha);
  expect(lifecycle.requests).toHaveLength(1);
  expect(await lifecycle.history()).toHaveLength(1);
});

for (const failure of ["missing", "unreadable"] as const)
  test(`#195 keeps the current session and recovery locator when the destination is ${failure}`, async ({
    lifecycle,
  }) => {
    await using cleanup = new AsyncDisposableStack();
    const alpha = await realpath(lifecycle.project);
    const destination = join(await realpath(lifecycle.home), "destination");
    if (failure === "unreadable") {
      await mkdir(destination);
      await chmod(destination, 0);
      cleanup.defer(() => chmod(destination, 0o700));
    }
    await recent(lifecycle.home, [destination]);
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
    const result = await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
      destination,
      selected.id,
    ] as const);
    expect(result.error).toContain(`Could not open ${destination}`);
    await expect(page.getByRole("status")).toHaveText("Idle");
    await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Kept reply");
    expect((await current(page)).id).toBe(selected.id);
    expect(JSON.parse(await readFile(join(lifecycle.home, "metadata.json"), "utf8"))).toEqual({
      version: 1,
      recentProjects: [alpha, destination],
    });

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
    expect((await readFile(saved.path, "utf8")).startsWith(saved.bytes)).toBe(true);
  });

// Desktop only switches to projects it selected; seed them as previously opened.
function recent(home: string, projects: string[]) {
  return writeFile(
    join(home, "metadata.json"),
    JSON.stringify({ version: 1, recentProjects: projects }),
  );
}

function current(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ id: string; projectPath: string; sessionFile: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((value) => {
          if (value?._tag !== "Snapshot") return;
          unsubscribe();
          resolve(value.conversation);
        });
      }),
  );
}
