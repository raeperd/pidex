import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const accepted of [true, false]) {
  // oxlint-disable-next-line no-empty-pattern
  test(`#133 reconnect after ${accepted ? "accepted Send before acknowledgment" : "connection fault before acceptance"}`, async ({}, testInfo) => {
    await using cleanup = new AsyncDisposableStack();
    const temporary = await mkdtemp(join(tmpdir(), "pidex-133-"));
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
    let advanceMarkdown: (() => void) | undefined;
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
      if (electronProcess.exitCode === null && electronProcess.signalCode === null)
        await app.close();
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      const fault = await app.evaluateHandle(
        (_electron, modulePath) => {
          const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
            modulePath,
          );
          const prototype = NodeSocket.NodeWS.WebSocket.prototype;
          const originalEmit = prototype.emit;
          const originalSend = prototype.send;
          let armed: "accepted" | "lost" | undefined;
          let offline = false;
          let dropping = false;
          let current: { terminate: () => void } | undefined;
          const wire: string[] = [];
          prototype.send = function (...args: unknown[]) {
            if (armed && String(args[0]).includes('"tag":"Send"')) {
              dropping = true;
              if (armed === "lost") {
                offline = true;
                armed = undefined;
                this.terminate();
                return;
              }
            }
            return originalSend.apply(this, args);
          };
          prototype.emit = function (event: string | symbol, ...args: unknown[]) {
            if (event === "open") {
              current = { terminate: () => this.terminate() };
              if (offline) {
                this.terminate();
                return true;
              }
            }
            if (event === "message") {
              const data = String(args[0]);
              if (dropping) {
                if (data.includes('"_tag":"Exit"') && data.includes('"_tag":"Success"')) {
                  offline = true;
                  armed = undefined;
                  this.terminate();
                }
                return true;
              }
              wire.push(data);
            }
            return originalEmit.apply(this, [event, ...args]);
          };
          return {
            arm: (wasAccepted: boolean) => {
              armed = wasAccepted ? "accepted" : "lost";
            },
            reconnect: () => {
              offline = false;
              dropping = false;
              wire.length = 0;
            },
            disconnect: () => {
              offline = true;
              current?.terminate();
            },
            updates: () => wire,
          };
        },
        fileURLToPath(import.meta.resolve("@effect/platform-node")),
      );
      await app.evaluate(({ dialog }, projectPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
      }, project);
      await page.getByRole("button", { name: "Choose project" }).click();
      const conversation = page.getByRole("region", { name: "Conversation" });
      await expect(conversation.getByRole("status")).toHaveText("Idle", { timeout: 15_000 });
      childPid = findServer();
      expect(childPid).toBeTruthy();
      const composer = page.getByRole("textbox", { name: "Prompt" });
      const send = page.getByRole("button", { name: "Send", exact: true });
      await composer.fill("Write hello to note.txt");
      await fault.evaluate((gate, wasAccepted) => gate.arm(wasAccepted), accepted);
      await send.click();
      await expect(conversation.getByRole("status")).toHaveText("Disconnected");
      await expect(composer).toHaveValue("Write hello to note.txt");
      await expect(send).toBeDisabled();
      await composer.fill("My next draft");
      if (accepted) {
        await expect.poll(() => providerRequests).toBe(1);
        finish?.();
        await expect.poll(() => providerRequests).toBe(2);
        expect(await readFile(join(project, "note.txt"), "utf8")).toBe("hello");
      }
      await fault.evaluate((gate) => gate.reconnect());
      await expect(conversation.getByRole("status")).toHaveText(accepted ? "Running" : "Idle");
      await expect(composer).toHaveValue("My next draft");
      if (accepted) {
        await expect(conversation.getByLabel("assistant")).toHaveText(["Writing hello", "Saved"]);
        await expect(page.getByRole("alert")).toHaveCount(0);
        advanceMarkdown?.();
        await expect(conversation.getByLabel("assistant").last()).toHaveText("Saved ordered");
        finish?.();
        await expect(conversation.getByRole("status")).toHaveText("Idle");
        const updates = await fault.evaluate((gate) => gate.updates());
        const chunks = updates.filter((value) => value.includes('"_tag":"Chunk"'));
        expect(chunks[0]).toContain('"_tag":"Snapshot"');
        expect(chunks[0]).toContain('"text":"Saved "');
        expect(chunks.slice(1).join("")).toContain('"delta":"ordered "');
        await fault.evaluate((gate) => gate.disconnect());
        await expect(conversation.getByRole("status")).toHaveText("Disconnected");
        await fault.evaluate((gate) => gate.reconnect());
        await expect(conversation.getByRole("status")).toHaveText("Idle");
        await expect(conversation.getByLabel("assistant")).toHaveText([
          "Writing hello",
          "Saved ordered Finished",
        ]);
        await expect(conversation.getByLabel("user")).toHaveCount(1);
        const files = (await readdir(join(agentDir, "sessions"), { recursive: true })).filter(
          (file) => file.endsWith(".jsonl"),
        );
        expect(files).toHaveLength(1);
        const file = files[0];
        if (!file) throw new Error("Expected session file");
        const history = await readFile(join(agentDir, "sessions", file), "utf8");
        expect(history.match(/"role":"user"/g)).toHaveLength(1);
        expect(history.match(/"type":"toolResult"|"role":"toolResult"/g)).toHaveLength(1);
      } else {
        await expect(page.getByRole("alert")).toContainText("Acceptance is uncertain");
        await expect(conversation.getByLabel("user")).toHaveCount(0);
      }
      expect(providerRequests).toBe(accepted ? 2 : 0);
      expect(findServer()).toBe(childPid);
      expect(electronProcess.exitCode).toBeNull();
      await page.screenshot({ path: testInfo.outputPath("reconnected.png") });
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
