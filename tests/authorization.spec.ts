import { _electron as electron, expect, test } from "@playwright/test";
import { NodeSocket } from "@effect/platform-node";
import { Schema } from "effect";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConversationUpdate,
  Conversation,
  ConversationUpdate,
} from "../packages/api/index.js";

// Playwright requires destructuring even when only testInfo is needed.
// oxlint-disable-next-line no-empty-pattern
test("#140 rejects unauthorized Send and Subscribe before work or delivery", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-140-"));
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
  const providerInputs: string[] = [];
  let providerRequests = 0;
  const provider = createServer(async (request, response) => {
    providerRequests++;
    let body = "";
    for await (const part of request) body += part;
    providerInputs.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: "assistant", content: providerInputs.length === 1 ? "Saved pear" : "hello" });
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
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
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [
            {
              id: "gpt-4.1",
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
  const app = await electron.launch({
    args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
    env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir() },
  });
  cleanup.defer(() => app.close());
  const logs = { stdout: "", stderr: "", renderer: "" };
  app.process().stdout?.on("data", (data) => {
    logs.stdout += String(data);
  });
  app.process().stderr?.on("data", (data) => {
    logs.stderr += String(data);
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    logs.renderer += `${message.text()}\n`;
  });
  // Observe the real main-process handshake, without replacing transport or handlers.
  // Keep credential extraction outside renderer tracing and never assert its raw value.
  const observation = await app.evaluateHandle(({ BrowserWindow }) => {
    const prototype = process.getBuiltinModule("http").ClientRequest.prototype;
    const originalEmit = prototype.emit;
    let connection: { url: string; authorization: string } | undefined;
    prototype.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "finish" && this.path === "/rpc/") {
        const authorization = this.getHeader("authorization");
        if (typeof authorization === "string")
          connection = { url: `ws://${this.getHeader("host")}${this.path}`, authorization };
      }
      return originalEmit.apply(this, [event, ...args]);
    };
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) throw new Error("Expected application window");
    const originalSend = contents.send.bind(contents);
    const payloads: string[] = [];
    contents.send = (channel: string, ...args: unknown[]) => {
      payloads.push(JSON.stringify([channel, ...args]));
      originalSend(channel, ...args);
    };
    return { connection: () => connection, payloads: () => payloads };
  });
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, project);
  await page.getByRole("button", { name: "Choose project" }).click();
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation).toBeVisible({ timeout: 15_000 });
  const connection = await observation.evaluate((value) => value.connection());
  if (!connection) throw new Error("Expected the main-process connection");
  const url = connection.url;
  const secret = connection.authorization.slice("Bearer ".length);
  expect(secret.length > 0).toBe(true);
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  try {
    await page.getByRole("textbox", { name: "Prompt" }).fill("Remember pear");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(conversation.getByText("Saved pear", { exact: true })).toBeVisible();
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    expect(providerRequests).toBe(1);
    const files = await readdir(join(agentDir, "sessions"), { recursive: true });
    const historyFile = files.find((file) => file.endsWith(".jsonl"));
    if (!historyFile) throw new Error("Expected saved Pi history");
    const historyPath = join(agentDir, "sessions", historyFile);
    const history = await readFile(historyPath);
    expect(history.toString()).toContain("Saved pear");
    const ui = await conversation.innerHTML();
    const control = await connect(connection.authorization, "pidex://app", "Subscribe");
    await expect.poll(() => control.state?.status).toBe("idle");
    const before = JSON.stringify(control.state);
    expect(before).toContain("Saved pear");
    for (const [name, authorization, origin] of [
      ["absent credential", undefined, "pidex://app"],
      ["wrong credential", "Bearer wrong-credential", "pidex://app"],
      ["unapproved Origin", connection.authorization, "https://unapproved.invalid"],
    ]) {
      for (const method of ["Send", "Subscribe"]) {
        await test.step(`${name}: ${method}`, async () => {
          const rejected = await connect(authorization, origin, method);
          expect(rejected.status).toBe(403);
          expect(rejected.opened).toBe(false);
          expect(rejected.messages).toEqual([]);
          expect(rejected.responseBytes).toBe(0);
          // A fresh snapshot is a server round trip after rejection, not a timing sleep.
          const checkpoint = await connect(connection.authorization, "pidex://app", "Subscribe");
          await expect.poll(() => checkpoint.state !== undefined).toBe(true);
          expect(JSON.stringify(checkpoint.state)).toBe(before);
          checkpoint.socket.close();
          expect(JSON.stringify(control.state)).toBe(before);
          expect(await conversation.innerHTML()).toBe(ui);
          expect(await readFile(historyPath)).toEqual(history);
          expect(providerRequests).toBe(1);
        });
      }
    }
    control.send({
      _tag: "Request",
      id: "2",
      tag: "Send",
      payload: { text: "Reply hello" },
      headers: [],
    });
    await expect
      .poll(() =>
        control.messages.some(
          (message) =>
            message._tag === "Exit" &&
            message.requestId === "2" &&
            message.exit?._tag === "Success",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        control.state?.entries.some(
          (entry) => entry.role === "assistant" && entry.text === "hello",
        ),
      )
      .toBe(true);
    await expect.poll(() => control.state?.status).toBe("idle");
    await expect(conversation.getByText("hello", { exact: true })).toBeVisible();
    await expect(conversation.getByRole("status")).toHaveText("Idle");
    expect(providerRequests).toBe(2);
    expect(providerInputs[1]).toContain("Reply hello");
    expect(
      control.state?.entries.filter(
        (entry) => entry.role === "user" && entry.text === "Reply hello",
      ),
    ).toHaveLength(1);
    expect(await readFile(historyPath, "utf8")).toContain("Reply hello");
    const payloads = await observation.evaluate((value) => value.payloads());
    for (const text of [
      ...payloads,
      ...Object.values(logs),
      ...providerInputs,
      JSON.stringify(control.messages),
    ]) {
      expect(
        text.includes(secret),
        "launch credential stays out of renderer payloads and logs",
      ).toBe(false);
      expect(
        text.includes("pidex-test-key"),
        "provider credential stays out of renderer payloads and logs",
      ).toBe(false);
    }
    await page.screenshot({ path: testInfo.outputPath("authorized-control.png") });
    await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
    await writeFile(
      testInfo.outputPath("electron.log"),
      Object.values(logs)
        .join("\n")
        .replaceAll(secret, "[credential]")
        .replaceAll("pidex-test-key", "[credential]")
        .replaceAll(temporary, "[temporary]"),
    );
    await app
      .context()
      .tracing.stop({ path: testInfo.outputPath("trace.zip") })
      .catch(() => {});
    throw error;
  }

  async function connect(
    authorization: string | undefined,
    origin: string | undefined,
    method: string,
  ) {
    const Message = Schema.Struct({
      _tag: Schema.String,
      requestId: Schema.optional(Schema.String),
      values: Schema.optional(Schema.Array(ConversationUpdate)),
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
    });
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}) },
      handshakeTimeout: 5000,
    });
    cleanup.defer(() => socket.terminate());
    let state: typeof Conversation.Type | undefined;
    const result = {
      socket,
      status: 0,
      opened: false,
      responseBytes: 0,
      messages: new Array<typeof Message.Type>(),
      get state() {
        return state;
      },
      send: (message: object) => socket.send(`${JSON.stringify(message)}\n`),
    };
    await new Promise<void>((done, reject) => {
      socket.on("error", reject);
      socket.on("unexpected-response", (_request, response) => {
        result.status = response.statusCode ?? 0;
        response.on("data", (data: Buffer) => {
          result.responseBytes += data.length;
        });
        response.on("end", () => {
          socket.terminate();
          done();
        });
      });
      socket.on("message", (data) => {
        for (const line of data.toString().trim().split("\n")) {
          const message = Schema.decodeUnknownSync(Message)(JSON.parse(line));
          result.messages.push(message);
          for (const update of message.values ?? []) {
            if (update._tag === "Snapshot") state = update.conversation;
            else if (state) state = applyConversationUpdate(state, update);
          }
          if (message._tag === "Chunk") result.send({ _tag: "Ack", requestId: message.requestId });
        }
      });
      socket.once("open", () => {
        result.opened = true;
        result.send({
          _tag: "Request",
          id: "1",
          tag: method,
          payload: method === "Send" ? { text: "Reply hello" } : null,
          headers: [],
        });
        done();
      });
    });
    return result;
  }
});
