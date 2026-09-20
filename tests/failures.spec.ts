import { _electron as electron, expect, test, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const setup of ["missing credentials", "unresolved default model"] as const) {
  // Playwright requires destructuring even when only testInfo is needed.
  // oxlint-disable-next-line no-empty-pattern
  test(`#138 explains ${setup} and disables Send without losing drafts`, async ({}, testInfo) => {
    await using fixture = await launch(testInfo, setup);
    const { page, requests } = fixture;
    await page.getByRole("button", { name: "Choose project" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      setup === "missing credentials" ? "authentication" : "model",
      { timeout: 15_000 },
    );
    await expect(alert).toContainText(setup === "missing credentials" ? "/login" : "/model");
    await expect(alert).toContainText("restart Pidex");
    const composer = page.getByRole("textbox", { name: "Prompt" });
    await expect(composer).toBeEditable();
    await composer.fill("next task");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveValue("next task");
    await expect(page.getByRole("status")).toHaveText("Idle");
    // Setup guards also apply to an authenticated client bypassing the disabled UI.
    expect(
      await page.evaluate(async () => {
        try {
          await window.desktop.send("cannot send");
          return "accepted";
        } catch {
          return "rejected";
        }
      }),
    ).toBe("rejected");
    expect(requests).toHaveLength(0);
  });
}

// oxlint-disable-next-line no-empty-pattern
test("#138 exhausts stock provider retries, shows a sanitized error, and preserves the draft", async ({}, testInfo) => {
  test.setTimeout(45_000);
  await using fixture = await launch(testInfo, "ready");
  const { page, requests } = fixture;
  await page.getByRole("button", { name: "Choose project" }).click();
  const composer = page.getByRole("textbox", { name: "Prompt" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("first task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect.poll(() => requests.length).toBe(1);
  await expect(composer).toHaveValue("");
  await composer.fill("next task");
  fixture.fail();
  // Pi 0.85.1 defaults: initial request + three retries, with 2s/4s/8s backoff.
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 25_000 });
  await expect(page.getByRole("alert")).toContainText("provider");
  await expect(page.getByRole("alert")).toContainText("try again");
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue("next task");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(4);
  // Idle is the completion barrier; another draft edit must not schedule provider work.
  await composer.press("End");
  await composer.press("!");
  await expect(composer).toHaveValue("next task!");
  expect(requests).toHaveLength(4);
  const updates = await fixture.updates.evaluate((messages) => messages.join("\n"));
  for (const secret of ["pidex-test-key", "private-provider-detail"]) {
    expect(updates).not.toContain(secret);
    expect(await page.locator("body").innerText()).not.toContain(secret);
    expect(fixture.logs.join("")).not.toContain(secret);
  }
});

async function launch(
  testInfo: TestInfo,
  setup: "missing credentials" | "unresolved default model" | "ready",
) {
  const cleanup = new AsyncDisposableStack();
  try {
    const temporary = await mkdtemp(join(tmpdir(), "pidex-138-"));
    cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
    const project = join(temporary, "project");
    const agentDir = join(temporary, ".pi", "agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    if (setup !== "missing credentials")
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({ openai: { type: "api_key", key: "pidex-test-key" } }),
      );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: setup === "unresolved default model" ? "missing-model" : "gpt-4.1",
      }),
    );
    const requests: number[] = [];
    let fail: (() => void) | undefined;
    const provider = createServer((request, response) => {
      request.resume();
      requests.push(Date.now());
      const respond = () =>
        response.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "Service unavailable: pidex-test-key private-provider-detail",
              type: "server_error",
            },
          }),
        );
      if (requests.length === 1) fail = respond;
      else respond();
    });
    cleanup.defer(
      () =>
        new Promise<void>((resolve, reject) => {
          provider.closeAllConnections();
          provider.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider fixture did not listen");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            models: [
              {
                id: "gpt-4.1",
                name: "GPT-4.1",
                api: "openai-completions",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const app = await electron.launch({
      args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
      env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir() },
    });
    cleanup.defer(async () => {
      await app.close();
    });
    const logs: string[] = [];
    app.process().stderr?.on("data", (data) => logs.push(String(data)));
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    cleanup.defer(async () => {
      await page.screenshot({ path: testInfo.outputPath("result.png") }).catch(() => {});
      await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
      if (testInfo.status !== testInfo.expectedStatus)
        await writeFile(
          testInfo.outputPath("electron.log"),
          logs
            .join("")
            .replaceAll(temporary, "[temporary]")
            .replaceAll("pidex-test-key", "[credential]"),
        );
    });
    const updates = await page.evaluateHandle(() => {
      const messages: string[] = [];
      window.desktop.subscribe((update) => messages.push(JSON.stringify(update)));
      return messages;
    });
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    return {
      page,
      requests,
      fail: () => {
        if (!fail) throw new Error("Provider request is not held");
        fail();
      },
      updates,
      logs,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}
