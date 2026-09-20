import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright requires destructuring even when only testInfo is needed.
// oxlint-disable-next-line no-empty-pattern
test("#131 edits a busy draft, rejects a transport send, then explicitly submits after completion", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-131-"));
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
  const requests: string[] = [];
  let finish: (() => void) | undefined;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (content: string, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`,
        );
      chunk("Working");
      finish = () => {
        chunk(" complete", "stop");
        response.end("data: [DONE]\n\n");
      };
    });
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
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) {
      const exited = new Promise<void>((resolve) => electronProcess.once("exit", () => resolve()));
      electronProcess.kill("SIGKILL");
      await exited;
    }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  try {
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    const composer = page.getByRole("textbox", { name: "Prompt" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await composer.fill("first task");
    await send.click();
    await expect(conversation.getByRole("status")).toHaveText("Running");
    await expect(conversation.getByText("Working", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(composer).toBeEditable();
    await composer.fill("next tas");
    await composer.press("End");
    await composer.press("k");
    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveValue("next task");
    await expect(send).toBeDisabled();
    expect(requests).toHaveLength(1);
    // #131 supporting check: preload -> main -> authenticated Effect RPC -> real Pi.
    expect(
      await page.evaluate(async () => {
        try {
          await window.desktop.send("busy transport submission");
          return "accepted";
        } catch (error) {
          return String(error);
        }
      }),
    ).toContain("Wait for the current reply.");
    expect(requests).toHaveLength(1);
    finish?.();
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(conversation.getByText("Working complete", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("next task");
    await expect(composer).toBeEditable();
    await expect(send).toBeEnabled();
    expect(requests).toHaveLength(1);
    // A focused Send button supports deliberate keyboard submission after completion.
    await send.focus();
    await send.press("Enter");
    await expect.poll(() => requests.length).toBe(2);
    expect(JSON.parse(requests[1] ?? "{}").messages).toContainEqual({
      role: "user",
      content: [{ type: "text", text: "next task" }],
    });
    finish?.();
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(composer).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("draft-submitted.png") });
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
