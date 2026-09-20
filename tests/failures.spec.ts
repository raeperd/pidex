import { _electron as electron, expect, test, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
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

// oxlint-disable-next-line no-empty-pattern
test("#138 preserves context-overflow failures when Pi removes the failed reply", async ({}, testInfo) => {
  await using fixture = await launch(testInfo, "ready", { failure: "context overflow" });
  const { page, requests } = fixture;
  await page.getByRole("button", { name: "Choose project" }).click();
  const composer = page.getByRole("textbox", { name: "Prompt" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("first task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await composer.fill("next task");
  fixture.fail();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByRole("alert")).toContainText("try again");
  await expect(composer).toHaveValue("next task");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(1);
  const updates = await fixture.updates.evaluate((messages) => messages.join("\n"));
  for (const secret of ["pidex-test-key", "private-provider-detail"]) {
    expect(updates).not.toContain(secret);
    expect(await page.locator("body").innerText()).not.toContain(secret);
    expect(fixture.logs.join("")).not.toContain(secret);
  }
});

for (const outcome of ["fails", "recovers", "overflows again", "is stopped"] as const) {
  // oxlint-disable-next-line no-empty-pattern
  test(`#138 reports the final outcome when overflow compaction ${outcome}`, async ({}, testInfo) => {
    await using fixture = await launch(testInfo, "ready", {
      failure: "context overflow",
      manual: true,
      keepRecentTokens: 1,
    });
    const { page, requests } = fixture;
    await page.getByRole("button", { name: "Choose project" }).click();
    const composer = page.getByRole("textbox", { name: "Prompt" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Save a prior turn");
    await send.click();
    await expect.poll(() => requests.length).toBe(1);
    fixture.complete("Saved history " + "context ".repeat(100));
    await expect(page.getByRole("status")).toHaveText("Idle");

    await composer.fill("Continue the task");
    await send.click();
    await expect.poll(() => requests.length).toBe(2);
    fixture.fail();
    await expect.poll(() => requests.length).toBe(3);
    await expect.poll(() => fixture.bodies[2]).toContain("structured context checkpoint summary");
    await expect(page.getByRole("status")).toHaveText("Running");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await composer.fill("next task");

    if (outcome === "is stopped") {
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    } else if (outcome === "fails") {
      fixture.fail();
    } else {
      fixture.complete("Summary of saved history");
      await expect.poll(() => requests.length).toBe(4);
      await expect(page.getByRole("status")).toHaveText("Running");
      await expect(page.getByRole("alert")).toHaveCount(0);
      if (outcome === "recovers") fixture.complete("Recovered reply");
      else fixture.fail();
    }
    await expect(page.getByRole("status")).toHaveText("Idle");
    if (outcome === "fails" || outcome === "overflows again") {
      await expect(page.getByRole("alert")).toContainText("try again");
    } else {
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    if (outcome === "recovers")
      await expect(page.getByLabel("assistant").last()).toHaveText("Recovered reply");
    await expect(composer).toHaveValue("next task");
    await expect(send).toBeEnabled();
    expect(requests).toHaveLength(outcome === "fails" || outcome === "is stopped" ? 3 : 4);
  });
}

// oxlint-disable-next-line no-empty-pattern
test("#138 clears transient provider failures when a retry succeeds", async ({}, testInfo) => {
  await using fixture = await launch(testInfo, "ready", { manual: true });
  const { page, requests } = fixture;
  await page.getByRole("button", { name: "Choose project" }).click();
  const composer = page.getByRole("textbox", { name: "Prompt" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("first task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  fixture.fail();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole("status")).toHaveText("Running");
  await expect(page.getByRole("alert")).toHaveCount(0);
  fixture.complete("Recovered reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("assistant").last()).toHaveText("Recovered reply");
  expect(requests).toHaveLength(2);
});

async function launch(
  testInfo: TestInfo,
  setup: "missing credentials" | "unresolved default model" | "ready",
  options: {
    failure?: "unavailable" | "context overflow";
    manual?: boolean;
    keepRecentTokens?: number;
  } = {},
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
        ...(options.keepRecentTokens === undefined
          ? {}
          : { compaction: { keepRecentTokens: options.keepRecentTokens } }),
      }),
    );
    const requests: ServerResponse[] = [];
    const bodies: string[] = [];
    let fail: (() => void) | undefined;
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => bodies.push(body));
      requests.push(response);
      const respond = () =>
        response
          .writeHead(options.failure === "context overflow" ? 400 : 503, {
            "content-type": "application/json",
          })
          .end(
            JSON.stringify({
              error: {
                message: `${options.failure === "context overflow" ? "maximum context length exceeded" : "Service unavailable"}: pidex-test-key private-provider-detail`,
                type:
                  options.failure === "context overflow" ? "invalid_request_error" : "server_error",
              },
            }),
          );
      if (options.manual || requests.length === 1) fail = respond;
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
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
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
      bodies,
      complete: (text: string) => {
        const response = requests.at(-1);
        if (!response) throw new Error("No pending provider request");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [
          [{ role: "assistant", content: text }, null],
          [{}, "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      },
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
