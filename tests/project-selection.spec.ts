import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright requires destructuring even when only testInfo is needed.
// oxlint-disable-next-line no-empty-pattern
test("#129 Cancel then choose a project with a fresh idle conversation, then Quit", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-129-"));
  cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, "project");
  const agentDir = join(temporary, ".pi", "agent");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "pidex-test-key" } }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.6-luna" }),
  );
  let providerRequests = 0;
  const provider = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(500).end("No model request expected during idle startup");
  });
  cleanup.defer(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!provider.listening) return resolve();
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
    JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${address.port}/v1` } } }),
  );
  const app = await electron.launch({
    args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
    env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir() },
  });
  const electronProcess = app.process();
  const context = app.context();
  const logs: string[] = [];
  electronProcess.stderr?.on("data", (data) => logs.push(String(data)));
  let childPid: number | undefined;
  cleanup.defer(async () => {
    childPid ??= findServer();
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) await app.close();
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    const picker = await app.evaluateHandle(({ dialog }) => {
      const observation = { opened: false };
      dialog.showOpenDialog = async () => {
        observation.opened = true;
        return { canceled: true, filePaths: [] };
      };
      return observation;
    });
    await page.getByRole("button", { name: "Choose project" }).click();
    await expect(page.getByRole("button", { name: "Choose project" })).toBeEnabled();
    expect(await picker.evaluate((observation) => observation.opened)).toBe(true);
    await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    // Cold Pi imports can exceed five seconds on macOS CI.
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(conversation.getByText("GPT-5.6 Luna", { exact: true })).toBeVisible();
    await expect(conversation.getByText("No messages yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose project" })).toHaveCount(0);
    expect(providerRequests).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("idle.png") });
    childPid = findServer();
    if (!childPid) throw new Error("Expected an owned server process");
    await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
    await app.evaluate(({ app: application }) => {
      setImmediate(() => application.quit());
    });
    await expect.poll(() => electronProcess.exitCode).toBe(0);
    const ownedPid = childPid;
    await expect
      .poll(
        () => {
          try {
            process.kill(ownedPid, 0);
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
            throw error;
          }
        },
        { message: "owned server terminates after Quit" },
      )
      .toBe(false);
  } catch (error) {
    if (!page.isClosed())
      await page.screenshot({ path: testInfo.outputPath("failure.png"), timeout: 5000 });
    await writeFile(
      testInfo.outputPath("electron.log"),
      logs.join("").replaceAll(temporary, "[temporary]"),
    );
    await context.tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => {});
    throw error;
  }
  function findServer() {
    try {
      return (
        Number(
          execFileSync("pgrep", ["-P", String(electronProcess.pid), "-f", "/dist/server/main.js"], {
            encoding: "utf8",
          }).trim(),
        ) || undefined
      );
    } catch {
      return undefined;
    }
  }
});

for (const provider of [
  { id: "amazon-bedrock", model: "amazon.nova-lite-v1:0", name: "Nova Lite" },
  { id: "google-vertex", model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
]) {
  // Playwright requires destructuring even when only testInfo is needed.
  // oxlint-disable-next-line no-empty-pattern
  test(`#129 ${provider.id} accepts Pi credentials without an API key`, async ({}, testInfo) => {
    await using cleanup = new AsyncDisposableStack();
    const temporary = await mkdtemp(join(tmpdir(), "pidex-129-"));
    cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
    const project = join(temporary, "project");
    const agentDir = join(temporary, ".pi", "agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: provider.id, defaultModel: provider.model }),
    );
    // Match credentials saved by Pi's AWS profile and ADC login flows.
    const env =
      provider.id === "amazon-bedrock"
        ? { AWS_PROFILE: "pidex-test" }
        : { GOOGLE_CLOUD_PROJECT: "pidex-test", GOOGLE_CLOUD_LOCATION: "us-central1" };
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ [provider.id]: { type: "api_key", env } }),
    );
    if (provider.id === "google-vertex") {
      const gcloud = join(temporary, ".config", "gcloud");
      await mkdir(gcloud, { recursive: true });
      await writeFile(
        join(gcloud, "application_default_credentials.json"),
        JSON.stringify({
          type: "authorized_user",
          client_id: "pidex-test",
          client_secret: "pidex-test",
          refresh_token: "pidex-test",
        }),
      );
    }
    // Isolate personal credentials. This checks Pi's local auth resolution;
    // no prompt is sent and no cloud credential exchange is needed.
    const app = await electron.launch({
      args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
      env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir(), PI_OFFLINE: "1" },
    });
    cleanup.defer(() => app.close());
    const logs: string[] = [];
    app.process().stderr?.on("data", (data) => logs.push(String(data)));
    const page = await app.firstWindow();
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    cleanup.defer(async () => {
      await page.screenshot({ path: testInfo.outputPath("result.png") }).catch(() => {});
      await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
      await writeFile(
        testInfo.outputPath("electron.log"),
        logs.join("").replaceAll(temporary, "[temporary]").replaceAll("pidex-test", "[credential]"),
      );
    });
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await page.getByRole("textbox", { name: "Prompt" }).fill("next task");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await expect(conversation.getByText(provider.name, { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
