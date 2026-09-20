import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// oxlint-disable-next-line no-empty-pattern
test("#132 stops with acknowledgment, preserves work, and ignores stale Stops after continuation", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-132-"));
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
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4.1" }),
  );
  let providerRequests = 0;
  let cancellationRequests = 0;
  let acknowledge: (() => void) | undefined;
  let continueReply: (() => void) | undefined;
  const provider = createServer((request, response) => {
    request.resume();
    if (request.url === "/cancel") {
      cancellationRequests++;
      acknowledge = () => response.end("acknowledged");
      return;
    }
    providerRequests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (providerRequests === 1) {
      chunk({ role: "assistant", content: "Working" });
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "write-note",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({ path: "note.txt", content: "hello" }),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
      response.end("data: [DONE]\n\n");
    } else if (providerRequests === 2) {
      chunk({ role: "assistant", content: "Partial output" });
    } else {
      chunk({ role: "assistant", content: "Contin" });
      continueReply = () => {
        chunk({ content: "ued" });
        chunk({}, "stop");
        response.end("data: [DONE]\n\n");
      };
    }
  });
  cleanup.defer(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!provider.listening) return resolve();
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
    env: {
      PATH: process.env.PATH ?? "",
      HOME: temporary,
      TMPDIR: tmpdir(),
      PIDEX_TEST_PROVIDER_URL: `http://127.0.0.1:${address.port}`,
    },
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
    await app.evaluate(
      (_electron, fixturePath) => {
        process.env.NODE_OPTIONS = `--import=${fixturePath}`;
      },
      fileURLToPath(new URL("./fixtures/cancellation-fetch.mjs", import.meta.url)),
    );
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    const status = conversation.getByRole("status");
    await expect(status).toHaveText("Idle", { timeout: 15_000 });
    const initial = await page.evaluate(() => window.desktop.chooseProject());
    const composer = page.getByRole("textbox", { name: "Prompt" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await composer.fill("Write hello to note.txt");
    await send.click();
    await expect(conversation.getByText("Working", { exact: true })).toBeVisible();
    await expect(conversation.getByText("Partial output", { exact: true })).toBeVisible();
    const active = await page.evaluate(() => window.desktop.chooseProject());
    const files = await readdir(join(agentDir, "sessions"), { recursive: true });
    const historyFile = files.find((file) => file.endsWith(".jsonl"));
    if (!historyFile) throw new Error("Expected saved history");
    const historyPath = join(agentDir, "sessions", historyFile);
    const saved = await readFile(historyPath, "utf8");
    expect(saved).toContain("Working");
    expect(saved).toContain("toolResult");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => cancellationRequests).toBe(1);
    await expect(status).toHaveText("Stopping");
    if (!active?.runId) throw new Error("Expected active run identity");
    const repeated = await page.evaluateHandle((runId) => {
      let settled = false;
      const pending = Promise.all([window.desktop.stop(runId), window.desktop.stop(runId)]).then(
        () => {
          settled = true;
        },
      );
      return { pending, settled: () => settled };
    }, active.runId);
    await composer.fill("Continue");
    await expect(composer).toBeEditable();
    await expect(send).toBeDisabled();
    expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
    await page.screenshot({ path: testInfo.outputPath("stopping.png") });
    expect(await repeated.evaluate((requests) => requests.settled())).toBe(false);
    expect(cancellationRequests).toBe(1);
    acknowledge?.();
    await repeated.evaluate((requests) => requests.pending);
    await expect(status).toHaveText("Idle");
    await expect(conversation.getByText("Partial output", { exact: true })).toBeVisible();
    expect(await readFile(historyPath, "utf8")).toContain(saved);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(conversation.getByText("Contin", { exact: true })).toBeVisible();
    const later = await page.evaluate(() => window.desktop.chooseProject());
    expect(later?.id).toBe(initial?.id);
    expect(later?.runId).not.toBe(active?.runId);
    if (!active?.runId) throw new Error("Expected active run identity");
    // Supplement UI Stop with repeated stale requests through authenticated RPC.
    await page.evaluate(async (runId) => {
      await Promise.all([window.desktop.stop(runId), window.desktop.stop(runId)]);
      await window.desktop.stop(runId);
    }, active.runId);
    await expect(status).toHaveText("Running");
    expect(cancellationRequests).toBe(1);
    continueReply?.();
    await expect(conversation.getByText("Continued", { exact: true })).toBeVisible();
    await expect(status).toHaveText("Idle");
    expect(await readFile(historyPath, "utf8")).toContain("Continue");
    expect(await readdir(join(agentDir, "sessions"), { recursive: true })).toEqual(files);
    expect(providerRequests).toBe(3);
    await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
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
