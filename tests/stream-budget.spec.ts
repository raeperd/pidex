import { expect, test } from "@playwright/test";
import { NodeSocket } from "@effect/platform-node";
import { Schema } from "effect";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { ConversationUpdate } from "../packages/api/index.js";

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
          `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
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
        defaultModel: "gpt-4.1",
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
      const socket = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${ready.port}/rpc/`, {
        headers: { authorization: "Bearer fixture-secret", origin: "pidex://app" },
      });
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
    await fast.next((message) => message._tag === "Chunk");
    await slow.next((message) => message._tag === "Chunk");
    fast.send({
      _tag: "Request",
      id: "2",
      tag: "Send",
      payload: { text: "Stream a controlled response" },
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
            message.values?.some((value) => value._tag === "TextDelta" && value.delta === delta) ===
            true,
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
          message.values?.some((value) => value._tag === "TextDelta" && value.delta === "tail") ===
          true,
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
