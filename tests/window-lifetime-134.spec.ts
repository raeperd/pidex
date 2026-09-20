import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["after completion", "during run", "after connection failure"]) {
  const finishWhileClosed = scenario === "after completion";
  // oxlint-disable-next-line no-empty-pattern
  test(`#134 actual window close and activation ${scenario}`, async ({}, testInfo) => {
    await using cleanup = new AsyncDisposableStack();
    const temporary = await mkdtemp(join(tmpdir(), "pidex-134-"));
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
    let finish: () => void = () => {
      throw new Error(`Provider response is not held: ${scenario}`);
    };
    let advanceMarkdown: () => void = () => {
      throw new Error(`Tool response has not started: ${scenario}`);
    };
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
        chunk({ role: "assistant", content: "Saved " });
        advanceMarkdown = () => chunk({ content: "ordered " });
        finish = () => {
          chunk({ content: "Finished" });
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
      env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir() },
    });
    const electronProcess = app.process();
    const context = app.context();
    const logs: string[] = [];
    electronProcess.stderr?.on("data", (data) => logs.push(String(data)));
    electronProcess.stdout?.on("data", (data) => logs.push(String(data)));
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
        const exited = new Promise<void>((resolve) =>
          electronProcess.once("exit", () => resolve()),
        );
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
      await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15_000 });
      childPid = findServer();
      expect(childPid).toBeTruthy();
      const initial = await page.evaluate(() => window.desktop.chooseProject());
      await page.getByRole("textbox", { name: "Prompt" }).fill("Write hello to note.txt");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Running");
      await expect.poll(() => providerRequests).toBe(1);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect.poll(() => page.isClosed()).toBe(true);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
        0,
      );
      expect(findServer()).toBe(childPid);
      expect(electronProcess.exitCode).toBeNull();
      if (scenario === "after connection failure") {
        if (!childPid) throw new Error("Expected backend PID");
        process.kill(childPid, "SIGKILL");
        await expect
          .poll(() => logs.join(""))
          .toContain("Could not reconnect. Pi history is preserved.");
        expect(
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        ).toBe(0);
        await app.evaluate(({ app: application }) => application.emit("activate"));
        const restoredWindow = await app.firstWindow();
        await expect(restoredWindow.getByRole("status")).toHaveText("Disconnected");
        await expect(restoredWindow.getByRole("alert")).toHaveText(
          "Could not reconnect. Pi history is preserved.",
        );
        expect(findServer()).toBeUndefined();
        expect(providerRequests).toBe(1);
        await restoredWindow.screenshot({ path: testInfo.outputPath("connection-error.png") });
        await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
        return;
      }
      finish();
      await expect.poll(() => providerRequests).toBe(2);
      expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
      const files = (await readdir(join(agentDir, "sessions"), { recursive: true })).filter(
        (file) => file.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) throw new Error("Expected session file");
      if (finishWhileClosed) {
        advanceMarkdown();
        finish();
        await expect
          .poll(async () =>
            (await readFile(join(agentDir, "sessions", file), "utf8")).includes(
              "Saved ordered Finished",
            ),
          )
          .toBe(true);
      }
      expect(findServer()).toBe(childPid);
      await app.evaluate(({ app: application }) => application.emit("activate"));
      const reopened = await app.firstWindow();
      await expect(reopened.getByRole("status")).toHaveText(finishWhileClosed ? "Idle" : "Running");
      await expect(reopened.getByLabel("assistant")).toHaveText([
        "Writing hello",
        finishWhileClosed ? "Saved ordered Finished" : "Saved",
      ]);
      const restored = await reopened.evaluate(() => window.desktop.chooseProject());
      expect(restored?.id).toBe(initial?.id);
      if (!finishWhileClosed) {
        advanceMarkdown();
        await expect(reopened.getByLabel("assistant").last()).toHaveText("Saved ordered");
        finish();
        await expect(reopened.getByRole("status")).toHaveText("Idle");
        await expect(reopened.getByLabel("assistant").last()).toHaveText("Saved ordered Finished");
      }
      await expect(reopened.getByLabel("user")).toHaveCount(1);
      const finalFiles = (await readdir(join(agentDir, "sessions"), { recursive: true })).filter(
        (name) => name.endsWith(".jsonl"),
      );
      expect(finalFiles).toEqual(files);
      const history = await readFile(join(agentDir, "sessions", file), "utf8");
      expect(history.match(/"role":"user"/g)).toHaveLength(1);
      expect(history.match(/"role":"toolResult"/g)).toHaveLength(1);
      expect(providerRequests).toBe(2);
      expect(findServer()).toBe(childPid);
      expect(electronProcess.exitCode).toBeNull();
      await reopened.screenshot({ path: testInfo.outputPath("reactivated.png") });
      await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
    } catch (error) {
      const visible = app.windows().find((candidate) => !candidate.isClosed());
      if (visible)
        await visible.screenshot({ path: testInfo.outputPath("failure.png"), timeout: 5000 });
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
            execFileSync(
              "pgrep",
              ["-P", String(electronProcess.pid), "-f", "/dist/server/main.js"],
              {
                encoding: "utf8",
              },
            ).trim(),
          ) || undefined
        );
      } catch {
        return undefined;
      }
    }
  });
}
