import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright requires destructuring even when only testInfo is needed.
// oxlint-disable-next-line no-empty-pattern
test("#130 streams Markdown and tools, rejects invalid sends, saves history, and cancels on Quit", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-130-"));
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
  let finish: (() => void) | undefined;
  const provider = createServer((request, response) => {
    providerRequests++;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (providerRequests !== 2) {
      chunk({ role: "assistant", content: "Writing " });
      finish = () => {
        chunk({ content: "hello" });
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
      };
    } else {
      chunk({
        role: "assistant",
        content:
          'Saved **hello**<script>document.title="unsafe"</script><img src="x" onerror="document.title=\'unsafe\'">',
      });
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
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
    // Hold the real RPC response after acceptance, without replacing app handlers.
    const acknowledgement = await app.evaluateHandle(() => {
      const originalFetch = globalThis.fetch;
      let held = false;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const payload = await request.clone().text();
        const response = await originalFetch(request);
        if (payload.includes('"text":"Write hello to note.txt"')) {
          held = true;
          await gate;
        }
        return response;
      };
      return { release: () => release?.(), isHeld: () => held };
    });
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    // Cold Pi imports can exceed five seconds on macOS CI.
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(conversation.getByText("GPT-4.1", { exact: true })).toBeVisible();
    await expect(conversation.getByText("No messages yet.")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Prompt" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    for (const prompt of ["", "  \n "]) {
      expect(
        await page.evaluate(async (text) => {
          try {
            await window.desktop.send(text);
            return "accepted";
          } catch {
            return "rejected";
          }
        }, prompt),
      ).toBe("rejected");
    }
    expect(providerRequests).toBe(0);
    await composer.fill("Write hello to note.txt");
    await send.click();
    await expect(conversation.getByRole("status")).toHaveText("Running");
    await expect(conversation.getByText("Writing", { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect.poll(() => acknowledgement.evaluate((gate) => gate.isHeld())).toBe(true);
    await composer.fill("Next prompt");
    await acknowledgement.evaluate((gate) => gate.release());
    expect(
      await page.evaluate(async () => {
        try {
          await window.desktop.send("Second submission");
          return "accepted";
        } catch {
          return "rejected";
        }
      }),
    ).toBe("rejected");
    expect(providerRequests).toBe(1);
    expect(finish).toBeDefined();
    finish?.();
    await expect(conversation.getByText("Saved hello", { exact: true })).toBeVisible();
    await expect(conversation.locator("strong")).toHaveText("hello");
    await expect(conversation.locator("script, img")).toHaveCount(0);
    await expect(page).toHaveTitle("pidex");
    const tool = conversation.locator("details");
    await expect(tool.locator("summary")).toHaveText("write · Completed");
    await expect(tool.getByLabel("Input")).not.toBeVisible();
    await expect(tool.getByLabel("Result")).not.toBeVisible();
    await tool.locator("summary").click();
    await expect(tool.getByLabel("Input")).toContainText('"path": "note.txt"');
    await expect(tool.getByLabel("Input")).toContainText('"content": "hello"');
    await expect(tool.getByLabel("Result")).toContainText("Successfully wrote to note.txt");
    await expect(conversation.locator('[aria-label="assistant"], details')).toHaveText([
      "Writing hello",
      /write · Completed/,
      "Saved hello",
    ]);
    expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(composer).toHaveValue("Next prompt");
    await expect(send).toBeEnabled();
    const files = await readdir(join(agentDir, "sessions"), { recursive: true });
    const historyFile = files.find((file) => file.endsWith(".jsonl"));
    if (!historyFile) throw new Error("Expected Pi history");
    const history = await readFile(join(agentDir, "sessions", historyFile), "utf8");
    expect(history).toContain("Write hello to note.txt");
    expect(history).toContain("Saved **hello**");
    expect(history).toContain("toolResult");
    expect(providerRequests).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("reply.png") });
    await composer.fill("Remain active until Quit");
    await send.click();
    await expect(conversation.getByRole("status")).toHaveText("Running");
    await expect.poll(() => providerRequests).toBe(3);
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
