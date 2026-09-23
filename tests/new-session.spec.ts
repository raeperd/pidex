import { expect } from "@playwright/test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, test } from "./support/lifecycle.js";

test("#192 starts another Pi session from an empty list and an idle session", async ({
  lifecycle,
}) => {
  const { page, children } = await lifecycle.launch();
  const list = page.getByRole("region", { name: "Saved sessions" });
  await expect(list).toContainText("No saved sessions in this project.");
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Unsent first draft");
  await list.getByRole("button", { name: "New session" }).click();
  await expect(prompt).toHaveValue("");
  await expect(page.getByRole("region", { name: "Messages" }).getByLabel("user")).toHaveCount(0);
  expect(lifecycle.requests).toHaveLength(0);

  await prompt.fill("First saved prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("First saved reply");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("First saved reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [first] = await lifecycle.history();
  if (!first) throw new Error("Missing first Pi history");

  await prompt.fill("Another unsent draft");
  await list.getByRole("button", { name: "New session" }).click();
  await expect(prompt).toHaveValue("");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  expect(lifecycle.requests).toHaveLength(1);
  await prompt.fill("Second saved prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("Second saved prompt");
  expect(lifecycle.requestBodies[1]).not.toContain("First saved prompt");
  lifecycle.complete("Second saved reply");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Second saved reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  expect(await lifecycle.history()).toHaveLength(2);
  expect(await readFile(first.path, "utf8")).toBe(first.bytes);
  const [backend] = children();
  if (!backend) throw new Error("Missing Pi backend");
  process.kill(backend, "SIGKILL");
  await expect.poll(() => alive(backend)).toBe(false);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Second saved reply");
  expect(await readFile(first.path, "utf8")).toBe(first.bytes);
  expect(lifecycle.requests).toHaveLength(2);
});

test("#192 rejects New session while a run is active", async ({ lifecycle }) => {
  const { page } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Keep this run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  await expect(page.getByRole("button", { name: "New session" })).toBeDisabled();
  const rejected = await page.evaluate(async () => {
    const snapshot = await new Promise<{ projectPath: string; id: string }>((resolve) => {
      const unsubscribe = window.desktop.subscribe((value) => {
        if (value?._tag !== "Snapshot") return;
        unsubscribe();
        resolve(value.conversation);
      });
    });
    return window.desktop.newSession(snapshot.projectPath, snapshot.id).then(
      () => "accepted",
      () => "rejected",
    );
  });
  expect(rejected).toBe("rejected");
  lifecycle.complete("Still the same run");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Still the same run");
  await expect(page.getByRole("status")).toHaveText("Idle");
  expect(await lifecycle.history()).toHaveLength(1);
});

test("#192 keeps the current session and recovery history when preparation fails", async ({
  lifecycle,
}) => {
  await using cleanup = new AsyncDisposableStack();
  const { page } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("History to preserve");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Still available");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const [first] = await lifecycle.history();
  if (!first) throw new Error("Missing saved history");
  const directory = dirname(first.path);
  await chmod(directory, 0o500);
  cleanup.defer(() => chmod(directory, 0o700));
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("alert")).toContainText("Pi history");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Still available");
  await chmod(directory, 0o700);
  await prompt.fill("Continue original session");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  await expect.poll(() => lifecycle.requestBodies.length).toBe(2);
  expect(lifecycle.requestBodies[1]).toContain("History to preserve");
  lifecycle.complete("Recovered");
  await expect(page.getByLabel("assistant", { exact: true }).last()).toHaveText("Recovered");
  expect(await lifecycle.history()).toHaveLength(1);
});

test("#192 reloads Pi setup when a fresh session replaces an idle session", async ({
  lifecycle,
}) => {
  const auth = join(lifecycle.home, ".pi", "agent", "auth.json");
  await writeFile(auth, "{}");
  const { page } = await lifecycle.launch();
  await expect(page.getByRole("alert")).toContainText("authentication is unavailable");
  await writeFile(auth, JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }));
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Fresh credentials");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Authenticated");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Authenticated");
});

test("#192 serializes simultaneous New session and Send against one selected session", async ({
  lifecycle,
}) => {
  const { page } = await lifecycle.launch();
  const selected = await page.evaluate(
    () =>
      new Promise<{ projectPath: string; id: string }>((resolve) => {
        const unsubscribe = window.desktop.subscribe((value) => {
          if (value?._tag !== "Snapshot") return;
          unsubscribe();
          resolve(value.conversation);
        });
      }),
  );
  const results = await page.evaluate(
    ({ projectPath, id }) =>
      Promise.allSettled([
        window.desktop.newSession(projectPath, id),
        window.desktop.send("Racing prompt", crypto.randomUUID()),
      ]),
    selected,
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  if (results[1]?.status === "fulfilled") {
    await expect.poll(() => lifecycle.requests.length).toBe(1);
    lifecycle.complete("Original session won");
    await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Original session won");
    await expect(page.getByRole("status")).toHaveText("Idle");
    expect(await lifecycle.history()).toHaveLength(1);
  } else {
    const current = await page.evaluate(
      () =>
        new Promise<{ id: string; entryCount: number }>((resolve) => {
          const unsubscribe = window.desktop.subscribe((value) => {
            if (value?._tag !== "Snapshot") return;
            unsubscribe();
            resolve({ id: value.conversation.id, entryCount: value.conversation.entries.length });
          });
        }),
    );
    expect(current.id).not.toBe(selected.id);
    expect(current.entryCount).toBe(0);
    expect(lifecycle.requests).toHaveLength(0);
  }
});

test("#192 ignores delayed updates from the replaced session", async ({ lifecycle }) => {
  const { app, page } = await lifecycle.launch();
  const old = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const unsubscribe = window.desktop.subscribe((value) => {
          if (value?._tag !== "Snapshot") return;
          unsubscribe();
          resolve(value.conversation.id);
        });
      }),
  );
  await page.getByRole("button", { name: "New session" }).click();
  const received = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const unsubscribe = window.desktop.subscribe((value) => {
          if (value?._tag !== "StateChanged" || value.runId !== "old-run") return;
          unsubscribe();
          resolve();
        });
      }),
  );
  await app.evaluate(({ BrowserWindow }, sessionId) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.webContents.send("conversation", {
      _tag: "EntryUpserted",
      sessionId,
      entry: { id: "late-old-reply", role: "assistant", text: "Old reply arrived late" },
    });
    window?.webContents.send("conversation", {
      _tag: "StateChanged",
      sessionId,
      status: "running",
      runId: "old-run",
      messageCount: 1,
      error: "",
    });
  }, old);
  await received;
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Idle");
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Only new session context");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  await expect.poll(() => lifecycle.requestBodies.length).toBe(1);
  expect(lifecycle.requestBodies[0]).not.toContain("Old reply arrived late");
  lifecycle.complete("New reply");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("New reply");
});

test("#192 recovers the new locator when its RPC acknowledgment is lost", async ({ lifecycle }) => {
  const { app, page, children } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Original history");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Original reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const fault = await app.evaluateHandle(
    (_electron, modulePath) => {
      const { NodeSocket } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const prototype = NodeSocket.NodeWS.WebSocket.prototype;
      const originalSend = prototype.send;
      const originalEmit = prototype.emit;
      let requestId: number | undefined;
      let dropped = false;
      let offline = false;
      prototype.send = function (...args: unknown[]) {
        const data: unknown = JSON.parse(String(args[0]));
        if (
          typeof data === "object" &&
          data !== null &&
          "tag" in data &&
          data.tag === "NewSession" &&
          "id" in data &&
          typeof data.id === "number"
        )
          requestId = data.id;
        return originalSend.apply(this, args);
      };
      prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        const data = String(args[0]);
        if (event === "open" && offline) {
          this.terminate();
          return true;
        }
        if (
          event === "message" &&
          requestId !== undefined &&
          data.includes(`"requestId":${requestId}`) &&
          data.includes('"_tag":"Exit"')
        ) {
          dropped = true;
          offline = true;
          requestId = undefined;
          this.terminate();
          return true;
        }
        return originalEmit.apply(this, [event, ...args]);
      };
      return {
        dropped: () => dropped,
        reconnect: () => {
          offline = false;
        },
      };
    },
    fileURLToPath(import.meta.resolve("@effect/platform-node")),
  );
  await prompt.fill("Unsent old-session draft");
  await page.getByRole("button", { name: "New session" }).click();
  await expect.poll(() => fault.evaluate((gate) => gate.dropped())).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Disconnected");
  const [backend] = children();
  if (!backend) throw new Error("Missing Pi backend");
  process.kill(backend, "SIGKILL");
  await expect.poll(() => alive(backend)).toBe(false);
  await fault.evaluate((gate) => gate.reconnect());
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
  await expect(page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue("");
  await expect(page.getByRole("alert")).toContainText("Saved history is missing");
  await prompt.fill("New history after lost acknowledgment");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  lifecycle.complete("New reply");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText("New reply");
  expect(await lifecycle.history()).toHaveLength(2);
});
