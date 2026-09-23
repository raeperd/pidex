import { _electron as electron, expect, test as base } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend<{ lifecycle: Awaited<ReturnType<typeof setup>> }>({
  // Playwright requires an object binding pattern for fixtures.
  // oxlint-disable-next-line no-empty-pattern
  lifecycle: async ({}, use, info) => {
    await using cleanup = new AsyncDisposableStack();
    const fixture = await setup(cleanup);
    try {
      await use(fixture);
    } finally {
      for (const { app, process: child } of fixture.apps) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const page = app.windows()[0];
        if (info.status !== info.expectedStatus && page && !page.isClosed())
          await page.screenshot({ path: info.outputPath("failure.png") }).catch(() => {});
        await app
          .context()
          .tracing.stop({ path: info.outputPath("trace.zip") })
          .catch(() => {});
      }
      await writeFile(
        info.outputPath("electron.log"),
        fixture.logs.join("").replaceAll(fixture.home, "[home]"),
      );
    }
  },
});

async function setup(cleanup: AsyncDisposableStack) {
  const home = await mkdtemp(join(tmpdir(), "pidex-lifecycle-"));
  cleanup.defer(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "project");
  const agentDir = join(home, ".pi", "agent");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6-luna" }),
  );
  const requests: ServerResponse[] = [];
  const requestBodies: string[] = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => requestBodies.push(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    requests.push(response);
  });
  cleanup.defer(
    () =>
      new Promise<void>((resolve, reject) => {
        provider.closeAllConnections();
        provider.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port");
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
  const apps: {
    app: Awaited<ReturnType<typeof electron.launch>>;
    process: import("node:child_process").ChildProcess;
  }[] = [];
  const logs: string[] = [];
  return {
    home,
    project,
    requests,
    requestBodies,
    apps,
    logs,
    async launch(selectProject = true) {
      const app = await electron.launch({
        args: ["dist/desktop/main.js", `--user-data-dir=${home}`],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: tmpdir(),
          DISPLAY: process.env.DISPLAY ?? "",
          XAUTHORITY: process.env.XAUTHORITY ?? "",
        },
      });
      const processHandle = app.process();
      apps.push({ app, process: processHandle });
      processHandle.stderr?.on("data", (data) => logs.push(String(data)));
      cleanup.defer(async () => {
        if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
        for (const pid of children(processHandle.pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        if (processHandle.exitCode === null && processHandle.signalCode === null) await app.close();
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(5000);
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, project);
      if (selectProject) {
        await page.getByRole("button", { name: "Choose project" }).click();
        await expect(page.getByRole("status")).toHaveText("Idle", { timeout: 15000 });
      }
      return { app, page, process: processHandle, children: () => children(processHandle.pid) };
    },
    complete(text: string) {
      const response = requests.at(-1);
      if (!response) throw new Error("No pending provider request");
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: text }, null],
        [{}, "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    },
    async history() {
      const root = join(agentDir, "sessions");
      const files = await readdir(root, { recursive: true });
      return Promise.all(
        files
          .filter((file) => file.endsWith(".jsonl"))
          .toSorted()
          .map(async (file) => {
            const path = join(root, file);
            return { path, bytes: await readFile(path, "utf8") };
          }),
      );
    },
  };
}

function children(parent: number | undefined) {
  if (!parent) return [];
  try {
    return execFileSync("pgrep", ["-P", String(parent), "-f", "/dist/server/main.js"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map(Number);
  } catch {
    return [];
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
