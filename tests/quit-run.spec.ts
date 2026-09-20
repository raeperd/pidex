import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const connection of ["connected", "disconnected", "unobserved"]) {
  const unobserved = connection === "unobserved";
  const disconnected = connection !== "connected";
  const title = unobserved
    ? "#137 Quit confirms when RPC drops before the run is observed"
    : disconnected
      ? "#137 confirmed Quit after RPC disconnect still awaits Pi before exiting"
      : "#137 Cancel Quit keeps work alive; Confirm awaits cancellation before both processes exit";
  // oxlint-disable-next-line no-empty-pattern
  test(title, async ({}, testInfo) => {
    await using cleanup = new AsyncDisposableStack();
    const temporary = await mkdtemp(join(tmpdir(), "pidex-137-"));
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
      } else {
        chunk({ role: "assistant", content: "Partial output" });
        continueReply = () => chunk({ content: " Still working" });
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
      const transport = await app.evaluateHandle(
        (_electron, modulePath) => {
          const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
            modulePath,
          );
          const prototype = NodeSocket.NodeWS.WebSocket.prototype;
          const originalEmit = prototype.emit;
          let disconnect: (() => void) | undefined;
          let dropNextRun = false;
          prototype.emit = function (event: string | symbol, ...args: unknown[]) {
            if (event === "open") disconnect = () => this.terminate();
            if (event === "message" && dropNextRun && String(args[0]).includes('"StateChanged"')) {
              dropNextRun = false;
              this.terminate();
              return false;
            }
            return originalEmit.apply(this, [event, ...args]);
          };
          return {
            disconnect: () => disconnect?.(),
            dropNext: () => {
              dropNextRun = true;
            },
          };
        },
        fileURLToPath(import.meta.resolve("@effect/platform-node")),
      );
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
      const composer = page.getByRole("textbox", { name: "Prompt" });
      const send = page.getByRole("button", { name: "Send", exact: true });
      if (unobserved) await transport.evaluate((wire) => wire.dropNext());
      await composer.fill("Write hello to note.txt");
      await send.click();
      if (unobserved) {
        await expect(status).toHaveText("Disconnected");
        await expect.poll(() => providerRequests).toBe(2);
      } else {
        await expect(conversation.getByText("Working", { exact: true })).toBeVisible();
        await expect(conversation.getByText("Partial output", { exact: true })).toBeVisible();
      }
      const active = await page.evaluate(() => window.desktop.chooseProject());
      expect(active?.runId === null).toBe(unobserved);
      const files = await readdir(join(agentDir, "sessions"), { recursive: true });
      const historyFile = files.find((file) => file.endsWith(".jsonl"));
      if (!historyFile) throw new Error("Expected saved history");
      const historyPath = join(agentDir, "sessions", historyFile);
      const saved = await readFile(historyPath, "utf8");
      expect(saved).toContain("Working");
      expect(saved).toContain("toolResult");
      childPid = findServer();
      if (!childPid) throw new Error("Expected owned backend");
      const ownedPid = childPid;
      const confirmation = await app.evaluateHandle(({ dialog }) => {
        let response = 0;
        const requests: Electron.MessageBoxOptions[] = [];
        dialog.showMessageBox = async (
          first: Electron.BaseWindow | Electron.MessageBoxOptions,
          options?: Electron.MessageBoxOptions,
        ) => {
          const supplied = options ?? ("message" in first ? first : undefined);
          if (!supplied) throw new Error("Expected native Quit options");
          requests.push(supplied);
          return { response, checkboxChecked: false };
        };
        return {
          requests,
          confirm: () => {
            response = 1;
          },
        };
      });
      await app.evaluate(({ app: application }) => {
        setImmediate(() => application.quit());
      });
      await expect.poll(() => confirmation.evaluate((gate) => gate.requests.length)).toBe(1);
      expect(await confirmation.evaluate((gate) => gate.requests[0])).toMatchObject({
        buttons: ["Cancel", "Quit"],
        defaultId: 0,
        cancelId: 0,
      });
      expect(electronProcess.exitCode).toBeNull();
      expect(process.kill(ownedPid, 0)).toBe(true);
      expect(cancellationRequests).toBe(0);
      continueReply?.();
      if (!unobserved)
        await expect(conversation.getByLabel("assistant").last()).toContainText("Still working");
      expect((await page.evaluate(() => window.desktop.chooseProject()))?.runId).toBe(
        active?.runId,
      );
      await expect(status).toHaveText(unobserved ? "Disconnected" : "Running");
      if (connection === "disconnected") {
        await transport.evaluate((wire) => wire.disconnect());
        await expect(status).toHaveText("Disconnected");
        expect(process.kill(ownedPid, 0)).toBe(true);
        expect(cancellationRequests).toBe(0);
      }
      await confirmation.evaluate((gate) => gate.confirm());
      await app.evaluate(({ app: application }) => {
        setImmediate(() => application.quit());
      });
      await expect.poll(() => cancellationRequests).toBe(1);
      await expect.poll(() => confirmation.evaluate((gate) => gate.requests.length)).toBe(2);
      await expect(status).toHaveText(disconnected ? "Disconnected" : "Stopping");
      await app.evaluate(({ app: application }) => {
        application.quit();
      });
      expect(await confirmation.evaluate((gate) => gate.requests.length)).toBe(2);
      expect(electronProcess.exitCode).toBeNull();
      expect(electronProcess.signalCode).toBeNull();
      expect(process.kill(ownedPid, 0)).toBe(true);
      expect(await readFile(historyPath, "utf8")).toContain(saved);
      expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
      await page.screenshot({ path: testInfo.outputPath("quitting.png") });
      await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
      acknowledge?.();
      // Observe exit externally. Do not query the UI after acknowledgment releases.
      await expect.poll(() => electronProcess.exitCode).toBe(0);
      await expect
        .poll(() => {
          try {
            process.kill(ownedPid, 0);
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
            throw error;
          }
        })
        .toBe(false);
      expect(await readFile(historyPath, "utf8")).toContain(saved);
      expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
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
