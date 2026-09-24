import { _electron as electron, expect } from "@playwright/test";
import { testHeadlessFlag } from "./support/headless.js";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSocket as PlatformNodeSocket } from "@effect/platform-node";
import { Schema } from "effect";
import { Conversation, ConversationUpdate } from "../packages/api/index.js";
import { test } from "./support/lifecycle.js";

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
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6-luna" }),
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
        `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
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
      chunk({ role: "assistant", content: "Saved **hel" });
      const parts = [
        "lo**\n\n```ts\nconst answer = ",
        "42;\n```\n\n[reference](https://example.",
        "com)\n\nStable paragraph.\n\n**bold",
        "*",
        "*\n\nInline `co",
        "de`\n\n- one\n\n- **tw",
        "o**\n\n[late][target]",
        "\n\n[target]: https://example.org\n\n~~strike",
        "~",
        "~\n\n[<https://example.net>](",
        '\n\nEscaped \\*literal and some_identifier.\n\n```md\n**literal [link](url\n\nstill code\n```\n\n<script>document.title="unsafe"</script><img src="x" onerror="document.title=\'unsafe\'">\n\n[bad](javascript:alert(1))\r\r**unfinished',
      ];
      advanceMarkdown = () => {
        const part = parts.shift();
        if (part !== undefined) chunk({ content: part });
        else {
          chunk({}, "stop");
          response.end("data: [DONE]\n\n");
        }
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
              id: "gpt-6-luna",
              name: "GPT-6 Luna",
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
      PIDEX_TEST_HEADLESS: testHeadlessFlag,
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
    // Hold the real Send acknowledgement while subscription updates keep flowing.
    const acknowledgement = await app.evaluateHandle(
      (_electron, modulePath) => {
        const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
          modulePath,
        );
        const prototype = NodeSocket.NodeWS.WebSocket.prototype;
        const originalEmit = prototype.emit;
        let armed = false;
        let release: (() => void) | undefined;
        let connections = 0;
        const wire: string[] = [];
        const ipc: string[] = [];
        const contents = _electron.BrowserWindow.getAllWindows()[0]?.webContents;
        if (!contents) throw new Error("Expected application window");
        const originalSend = contents.send.bind(contents);
        contents.send = (channel: string, ...args: unknown[]) => {
          if (channel === "conversation") ipc.push(JSON.stringify(args[0]));
          originalSend(channel, ...args);
        };
        prototype.emit = function (event: string | symbol, ...args: unknown[]) {
          if (event === "open") connections++;
          const data = String(args[0]);
          if (event === "message") wire.push(data);
          if (
            event === "message" &&
            armed &&
            data.includes('"_tag":"Exit"') &&
            data.includes('"_tag":"Success"')
          ) {
            armed = false;
            release = () => originalEmit.apply(this, [event, ...args]);
            return true;
          }
          return originalEmit.apply(this, [event, ...args]);
        };
        return {
          arm: () => {
            armed = true;
          },
          release: () => release?.(),
          isHeld: () => release !== undefined,
          connections: () => connections,
          updates: () => ({ wire, ipc }),
        };
      },
      fileURLToPath(import.meta.resolve("@effect/platform-node")),
    );
    await app.evaluate(({ dialog }, projectPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
    }, project);
    await page.getByRole("button", { name: "Choose project" }).click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    // Cold Pi imports can exceed five seconds on macOS CI.
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(conversation.getByText("GPT-6 Luna", { exact: true })).toBeVisible();
    await expect(
      conversation.getByRole("heading", { name: "What would you like to build?" }),
    ).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Prompt" });
    const send = page.getByRole("button", { name: "Send", exact: true, includeHidden: true });
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
    await acknowledgement.evaluate((gate) => gate.arm());
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
    await expect(conversation.locator("strong")).toHaveText("hel");
    const advance = advanceMarkdown;
    if (!advance) throw new Error("Expected controlled Markdown response");
    await expect(conversation.getByRole("status")).toHaveText("Running");
    advance();
    await expect(conversation.locator("strong")).toHaveText("hello");
    await expect(conversation.locator("pre code")).toContainText("const answer =");
    advance();
    await expect(conversation.locator("pre code")).toHaveText("const answer = 42;\n");
    await expect(conversation.getByRole("link", { name: "reference" })).toHaveCount(0);
    advance();
    await expect(conversation.getByRole("link", { name: "reference" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    await expect(conversation.getByText("Saved hello", { exact: true })).toBeVisible();
    await expect(conversation.locator("strong")).toHaveText(["hello", "bold"]);
    const stableParagraph = await conversation
      .getByText("Stable paragraph.", { exact: true })
      .elementHandle();
    const completedCode = await conversation.locator("pre code").elementHandle();
    advance();
    await expect(conversation.locator("strong")).toHaveText(["hello", "bold"]);
    advance();
    await expect(conversation.getByText("Inline", { exact: false }).locator("code")).toHaveText(
      "co",
    );
    advance();
    await expect(conversation.getByText("Inline", { exact: false }).locator("code")).toHaveText(
      "code",
    );
    await expect(conversation.locator("li strong")).toHaveText("tw");
    advance();
    await expect(conversation.locator("li")).toHaveText(["one", "two"]);
    await expect(conversation.getByRole("link", { name: "late", exact: true })).toHaveCount(0);
    advance();
    await expect(conversation.getByRole("link", { name: "late", exact: true })).toHaveAttribute(
      "href",
      "https://example.org",
    );
    await expect(conversation.locator("s")).toHaveText("strike");
    advance();
    await expect(conversation.locator("s")).toHaveText("strike");
    advance();
    await expect(conversation.getByText("https://example.net", { exact: true })).toBeVisible();
    await expect(conversation.locator('a[href="https://example.net"]')).toHaveCount(0);
    advance();
    await expect(conversation.locator("strong").last()).toHaveText("unfinished");
    await expect(
      conversation.getByText("Escaped *literal and some_identifier.", { exact: true }),
    ).toBeVisible();
    await expect(conversation.locator("pre code").last()).toHaveText(
      "**literal [link](url\n\nstill code\n",
    );
    await expect(conversation.getByRole("link", { name: "bad", exact: true })).toHaveCount(0);
    await expect(conversation.locator("script, img")).toHaveCount(0);
    await expect(page).toHaveTitle("pidex");
    // Completed blocks survive subsequent deltas without replacing their DOM.
    expect(await stableParagraph?.evaluate((node) => node.isConnected)).toBe(true);
    expect(await completedCode?.evaluate((node) => node.isConnected)).toBe(true);
    advance();
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    await expect(conversation.getByText("**unfinished", { exact: true })).toBeVisible();
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
      /Saved hello\s+const answer = 42;\s*reference/,
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
    expect(await acknowledgement.evaluate((gate) => gate.connections())).toBe(1);
    const updates = await acknowledgement.evaluate((gate) => gate.updates());
    for (const messages of [updates.wire, updates.ipc]) {
      expect(messages.filter((message) => message.includes('"_tag":"Snapshot"'))).toHaveLength(1);
      const deltas = messages.filter((message) => message.includes('"_tag":"TextDelta"'));
      expect(deltas).toHaveLength(14);
      expect(deltas[0]).toContain('"delta":"Writing "');
      expect(deltas[1]).toContain('"delta":"hello"');
      for (const delta of deltas) {
        expect(delta).not.toContain('"entries"');
        expect(delta).not.toContain("Write hello to note.txt");
      }
    }
    await page.screenshot({ path: testInfo.outputPath("reply.png") });
    await composer.fill("Remain active until Quit");
    await send.click();
    await expect(conversation.getByRole("status")).toHaveText("Running");
    await expect.poll(() => providerRequests).toBe(3);
    childPid = findServer();
    if (!childPid) throw new Error("Expected an owned server process");
    await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
    await app.evaluate(({ app: application, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
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

test("#183 keeps long Markdown readable and the composer reachable while preserving reading position", async ({
  lifecycle,
}, info) => {
  const { page } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Explain the project layout");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const prose = "## Project layout\n\n" + "A paragraph describing the project.\n\n".repeat(40);
  const response = lifecycle.requests[0];
  response.write(
    `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta: { role: "assistant", content: prose }, finish_reason: null }] })}\n\n`,
  );
  const heading = page.getByRole("heading", { name: "Project layout" });
  await expect(heading).toHaveCSS("color", "rgb(240, 198, 116)");
  const transcript = page.getByRole("region", { name: "Messages" });
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(heading).toBeInViewport();
  lifecycle.complete(
    "\n## Finished\n\n```text\n" +
      "long-token".repeat(100) +
      "\n```\n\n| File | Purpose |\n| --- | --- |\n| " +
      "long-path".repeat(30) +
      " | Source |\n",
  );
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(heading).toBeInViewport();
  await expect(prompt).toBeInViewport();
  await page.screenshot({ path: info.outputPath("conversation-desktop.png") });
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await expect(prompt).toBeInViewport();
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole("table")).toBeInViewport();
  expect(await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("conversation-narrow.png") });
});

test("#183 opening a long tool result preserves its beginning and keeps Stop reachable", async ({
  lifecycle,
}, info) => {
  const result = "A long source line with details ".repeat(6) + "\n";
  await writeFile(join(lifecycle.project, "long.txt"), result.repeat(80));
  const { page } = await lifecycle.launch();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Read long.txt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  const response = lifecycle.requests[0];
  response.write(
    `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-long", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "long.txt" }) } }] }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  const tool = page.getByRole("region", { name: "Messages" }).locator("details");
  await expect(tool.locator("summary")).toHaveText("read · Completed");
  await tool.locator("summary").focus();
  await tool.locator("summary").press("Enter");
  await expect(tool.getByLabel("Result", { exact: true })).toContainText(result.trim());
  // Wait for the disclosure layout and ResizeObserver's resulting scroll to settle.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(tool.getByRole("heading", { name: "Input", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  const transcript = page.getByRole("region", { name: "Messages" });
  expect(await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("tool-expanded-narrow.png") });
});

test.describe("#130 subscription limits", () => {
  for (const scenario of ["item budget", "byte budget", "oversized payload"]) {
    test(`subscription ${scenario} preserves the run and saved history`, async () => {
      await using cleanup = new AsyncDisposableStack();
      const temporary = await mkdtemp(join(tmpdir(), "pidex-stream-budget-"));
      cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
      const agentDir = join(temporary, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      let requests = 0;
      let append: ((text: string) => void) | undefined;
      let finish: (() => void) | undefined;
      const provider = createServer((request, response) => {
        requests++;
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        append = (text) => chunk({ content: text });
        finish = () => {
          chunk({}, "stop");
          response.end("data: [DONE]\n\n");
        };
        chunk({ role: "assistant", content: "start" });
      });
      cleanup.defer(
        () =>
          new Promise<void>((done) => {
            provider.closeAllConnections();
            provider.close(() => done());
          }),
      );
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Provider did not listen");
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({ openai: { type: "api_key", key: "fixture" } }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "openai",
          defaultModel: "gpt-6-luna",
          compaction: { enabled: false },
        }),
      );
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              models: [
                {
                  id: "gpt-6-luna",
                  name: "Fixture",
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
      const child = fork(resolvePath("dist/server/main.js"), [], {
        cwd: temporary,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH, HOME: temporary, PIDEX_SERVER_SECRET: "fixture-secret" },
      });
      cleanup.defer(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
      });
      const [rawReady] = await once(child, "message");
      const ready = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Number, sessionFile: Schema.String }),
      )(rawReady);
      const Message = Schema.Struct({
        _tag: Schema.String,
        requestId: Schema.optional(Schema.String),
        values: Schema.optional(Schema.Array(ConversationUpdate)),
        exit: Schema.optional(Schema.Unknown),
      });
      async function connect(autoAck: boolean) {
        const socket = new PlatformNodeSocket.NodeWS.WebSocket(
          `ws://127.0.0.1:${ready.port}/rpc/`,
          {
            headers: { authorization: "Bearer fixture-secret", origin: "pidex://app" },
          },
        );
        cleanup.defer(() => {
          socket.terminate();
        });
        socket.on("error", () => {});
        let last: typeof Message.Type | undefined;
        const waiters = new Set<{
          predicate: (message: typeof Message.Type) => boolean;
          resolve: (message: typeof Message.Type) => void;
        }>();
        const send = (message: object) => socket.send(`${JSON.stringify(message)}\n`);
        socket.on("message", (data) => {
          for (const line of data.toString().trim().split("\n")) {
            last = Schema.decodeUnknownSync(Message)(JSON.parse(line));
            if (autoAck && last._tag === "Chunk") send({ _tag: "Ack", requestId: last.requestId });
            for (const waiter of waiters)
              if (waiter.predicate(last)) {
                waiters.delete(waiter);
                waiter.resolve(last);
              }
          }
        });
        await once(socket, "open");
        return {
          send,
          next: (
            predicate: (message: typeof Message.Type) => boolean,
          ): Promise<typeof Message.Type> =>
            last && predicate(last)
              ? Promise.resolve(last)
              : new Promise((resolve) => waiters.add({ predicate, resolve })),
        };
      }
      const fast = await connect(true);
      const slow = await connect(false);
      const subscribe = { _tag: "Request", id: "1", tag: "Subscribe", payload: null, headers: [] };
      fast.send(subscribe);
      slow.send(subscribe);
      const first = await fast.next((message) => message._tag === "Chunk");
      await slow.next((message) => message._tag === "Chunk");
      const selected = Schema.decodeUnknownSync(
        Schema.Struct({ _tag: Schema.Literal("Snapshot"), conversation: Conversation }),
      )(first.values?.[0]).conversation;
      fast.send({
        _tag: "Request",
        id: "2",
        tag: "Send",
        payload: {
          projectPath: selected.projectPath,
          sessionId: selected.id,
          text: "Stream a controlled response",
        },
        headers: [],
      });
      await fast.next(
        (message) =>
          message.values?.some((value) => value._tag === "TextDelta" && value.delta === "start") ===
          true,
      );
      const part =
        scenario === "item budget"
          ? "x"
          : scenario === "byte budget"
            ? "x".repeat(512 * 1024)
            : "x".repeat(8 * 1024 * 1024);
      const count = scenario === "item budget" ? 70 : scenario === "byte budget" ? 17 : 1;
      let expected = "start";
      for (let index = 1; index <= count; index++) {
        const delta = `${index}:${part}`;
        expected += delta;
        append?.(delta);
        if (scenario !== "oversized payload") {
          await fast.next(
            (message) =>
              message.values?.some(
                (value) => value._tag === "TextDelta" && value.delta === delta,
              ) === true,
          );
        } else {
          const oversized = await fast.next(
            (message) => message._tag === "Exit" && message.requestId === "1",
          );
          expect(JSON.stringify(oversized.exit)).toContain("payload-too-large");
        }
      }
      slow.send({ _tag: "Ack", requestId: "1" });
      const failure = await slow.next(
        (message) => message._tag === "Exit" && message.requestId === "1",
      );
      expect(JSON.stringify(failure.exit)).toContain(
        scenario === "oversized payload" ? "payload-too-large" : "slow-consumer",
      );
      // A new subscriber receives the current snapshot without replaying the prompt.
      const resumed = await connect(true);
      resumed.send(subscribe);
      if (scenario !== "item budget") {
        const oversized = await resumed.next((message) => message._tag === "Exit");
        expect(JSON.stringify(oversized.exit)).toContain("payload-too-large");
      } else {
        const initial = await resumed.next((message) => message._tag === "Chunk");
        const snapshot = initial.values?.[0];
        if (snapshot?._tag !== "Snapshot") throw new Error("Expected initial snapshot");
        expect(snapshot.conversation.status).toBe("running");
        expect(
          snapshot.conversation.entries.some(
            (entry) => entry.role === "assistant" && entry.text === expected,
          ),
        ).toBe(true);
        // The new subscription continues after its snapshot without duplicating history.
        append?.("tail");
        expected += "tail";
        await resumed.next(
          (message) =>
            message.values?.some(
              (value) => value._tag === "TextDelta" && value.delta === "tail",
            ) === true,
        );
      }
      finish?.();
      if (scenario !== "oversized payload") {
        await fast.next(
          (message) =>
            message.values?.some(
              (value) => value._tag === "StateChanged" && value.status === "idle",
            ) === true,
        );
        if (scenario === "item budget")
          await resumed.next(
            (message) =>
              message.values?.some(
                (value) => value._tag === "StateChanged" && value.status === "idle",
              ) === true,
          );
      }
      await expect
        .poll(async () =>
          (await readFile(ready.sessionFile, "utf8").catch(() => "")).includes(expected),
        )
        .toBe(true);
      expect(requests).toBe(1);
    });
  }
});
