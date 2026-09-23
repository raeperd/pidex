import { _electron as electron, expect, test } from "@playwright/test";
import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Only folder-dialog results and provider responses are controlled; Pi runs real stock tools.
// A temporary home isolates configuration and credentials from the local environment.
for (const instructions of ["AGENTS.md", "CLAUDE.md"]) {
  // Playwright requires destructuring even when only testInfo is needed.
  // oxlint-disable-next-line no-empty-pattern
  test(`#139 stock Pi loads ${instructions}, excludes customization, and executes stock tools`, async ({}, testInfo) => {
    await using cleanup = new AsyncDisposableStack();
    const temporary = await mkdtemp(join(tmpdir(), "pidex-139-"));
    cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
    const project = join(temporary, "project");
    const agentDir = join(temporary, ".pi", "agent");
    const coverageDir = join(temporary, "coverage");
    const originalFiles = new Map<string, string>();
    const excluded: string[] = [];
    await prepareResources();
    const calls = [
      {
        name: "write",
        arguments: { path: "note.txt", content: "hello" },
        result: "Successfully wrote to note.txt",
      },
      { name: "read", arguments: { path: "note.txt" }, result: "hello" },
      {
        name: "edit",
        arguments: { path: "note.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
        result: "Successfully replaced 1 block(s) in note.txt",
      },
      { name: "bash", arguments: { command: "cat note.txt" }, result: "goodbye" },
    ];
    const requests: string[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const call = calls[requests.length];
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = call
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `stock-${call.name}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ],
            }
          : { role: "assistant", content: "Stock tools finished." };
        response.write(
          `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
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
    await fixture(
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
        NODE_V8_COVERAGE: coverageDir,
      },
    });
    const child = app.process();
    const logs: string[] = [];
    child.stderr?.on("data", (data) => logs.push(String(data)));
    let backendPid: number | undefined;
    cleanup.defer(async () => {
      backendPid ??= findBackend();
      if (backendPid) {
        try {
          process.kill(backendPid, "SIGKILL");
        } catch {
          /* The backend may already have exited. */
        }
        const pid = backendPid;
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH")
                  return false;
                throw error;
              }
            },
            { message: "fixture backend exits before removing its project" },
          )
          .toBe(false);
      }
      if (child.exitCode === null && child.signalCode === null) await app.close();
    });
    const page = await app.firstWindow();
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    try {
      await app.evaluate(({ dialog }, projectPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
      }, project);
      await page.getByRole("button", { name: "Choose project" }).click();
      // Remember the child before an Electron crash can reparent it.
      await expect.poll(() => (backendPid ??= findBackend())).toBeGreaterThan(0);
      const conversation = page.getByRole("region", { name: "Conversation" });
      await expect(conversation).toBeVisible({ timeout: 15_000 });
      await expect(conversation.getByRole("status")).toHaveText("Idle");
      await expect(conversation.getByText("GPT-6 Luna", { exact: true })).toBeVisible();
      expect(requests).toHaveLength(0);
      // A loaded template would expand this slash command before the provider sees it.
      await page.getByRole("textbox", { name: "Prompt" }).fill("/global-prompt");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(conversation.getByText("Stock tools finished.", { exact: true })).toBeVisible();
      await expect(conversation.getByRole("status")).toHaveText("Idle");
      await expect(conversation.locator("details summary")).toHaveText(
        calls.map((call) => `${call.name} · Completed`),
      );
      for (const [index, call] of calls.entries()) {
        const tool = conversation.locator("details").nth(index);
        await tool.locator("summary").click();
        await expect(tool.getByLabel("Input")).toHaveText(JSON.stringify(call.arguments, null, 2));
        await expect(tool.getByLabel("Result")).toContainText(call.result);
      }
      expect(await readFile(join(project, "note.txt"), "utf8")).toBe("goodbye");
      expect(requests).toHaveLength(5);
      verifyProviderInput();
      await page.screenshot({ path: testInfo.outputPath("stock-tools.png") });
      await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
      await app.evaluate(({ app: application }) => {
        setImmediate(() => application.quit());
      });
      await expect.poll(() => child.exitCode).toBe(0);
      // Compare after graceful Quit so settings flushed during shutdown are checked too.
      for (const [path, bytes] of originalFiles)
        expect(await readFile(path, "utf8"), path).toBe(bytes);
      expect(await readdir(temporary)).not.toContain("extension-loaded");
      await verifyUnloadedResources();
    } catch (error) {
      if (!page.isClosed())
        await page
          .screenshot({ path: testInfo.outputPath("failure.png"), timeout: 5000 })
          .catch(() => {});
      await writeFile(
        testInfo.outputPath("electron.log"),
        logs.join("").replaceAll(temporary, "[temporary]"),
      );
      await app
        .context()
        .tracing.stop({ path: testInfo.outputPath("trace.zip") })
        .catch(() => {});
      throw error;
    }

    function findBackend() {
      try {
        return (
          Number(
            execFileSync("pgrep", ["-P", String(child.pid), "-f", "/dist/server/main.js"], {
              encoding: "utf8",
            }).trim(),
          ) || undefined
        );
      } catch {
        return undefined;
      }
    }

    async function prepareResources() {
      await fixture(join(project, instructions), "PROJECT_RULE_11\n");
      await fixture(join(temporary, "AGENTS.md"), "PARENT_RULE_12\n");
      await fixture(join(agentDir, "AGENTS.md"), "GLOBAL_RULE_13\n");
      // Stock Pi prefers AGENTS.md in a directory; the CLAUDE-only case covers fallback.
      if (instructions === "AGENTS.md") {
        await fixture(join(project, "CLAUDE.md"), "SHADOWED_CLAUDE_14\n");
      }
      for (const [scope, directory] of [
        ["global", agentDir],
        ["project", join(project, ".pi")],
      ]) {
        if (!scope || !directory) throw new Error("Missing resource fixture scope");
        const configured = join(temporary, `${scope}-configured`);
        const packageRoot = join(temporary, `${scope}-package`);
        await resources(directory, scope);
        await resources(configured, `${scope}-configured`);
        await resources(packageRoot, `${scope}-package`);
        await fixture(
          join(packageRoot, "package.json"),
          JSON.stringify({
            name: `${scope}-fixture`,
            pi: {
              extensions: ["extensions"],
              skills: ["skills"],
              prompts: ["prompts"],
              themes: ["themes"],
            },
          }),
        );
        for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
          const sentinel = `EXCLUDED_${scope}_${name}`;
          excluded.push(sentinel);
          await fixture(join(directory, name), sentinel);
        }
        await fixture(
          join(directory, "settings.json"),
          JSON.stringify(
            {
              defaultProvider: "openai",
              defaultModel: "gpt-6-luna",
              defaultProjectTrust: "always",
              packages:
                scope === "global"
                  ? [
                      {
                        source: packageRoot,
                        extensions: ["**"],
                        skills: ["**"],
                        prompts: ["**"],
                        themes: ["**"],
                      },
                    ]
                  : [packageRoot],
              extensions: [join(configured, "extensions")],
              skills: [join(configured, "skills")],
              prompts: [join(configured, "prompts")],
              themes: [join(configured, "themes")],
              theme: `EXCLUDED_${scope}_theme`,
            },
            null,
            2,
          ) + "\n",
        );
      }
      for (const [scope, root] of [
        ["home", temporary],
        ["project", project],
      ]) {
        if (!scope || !root) throw new Error("Missing skill fixture scope");
        const sentinel = `EXCLUDED_${scope}_agents_skill`;
        excluded.push(sentinel);
        await fixture(
          join(root, ".agents/skills", `${scope}-skill`, "SKILL.md"),
          `---\nname: ${scope}-skill\ndescription: ${sentinel}\n---\n${sentinel}\n`,
        );
      }
      await fixture(
        join(agentDir, "auth.json"),
        JSON.stringify({ openai: { type: "api_key", key: "pidex-test-key" } }),
      );

      async function resources(root: string, scope: string) {
        const sdkDir = dirname(
          fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
        );
        const stockTheme = await readFile(
          join(sdkDir, "modes/interactive/theme/dark.json"),
          "utf8",
        );
        for (const kind of ["extension", "skill", "prompt", "theme"])
          excluded.push(`EXCLUDED_${scope}_${kind}`);
        await fixture(
          join(root, "extensions/sentinel.js"),
          `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(temporary, "extension-loaded"))}, "EXCLUDED_${scope}_extension"); }\n`,
        );
        await fixture(
          join(root, "skills", `${scope}-skill`, "SKILL.md"),
          `---\nname: ${scope}-skill\ndescription: EXCLUDED_${scope}_skill\n---\nEXCLUDED_${scope}_skill\n`,
        );
        await fixture(join(root, "prompts", `${scope}-prompt.md`), `EXCLUDED_${scope}_prompt\n`);
        await fixture(
          join(root, "themes/sentinel.json"),
          stockTheme.replace('"name": "dark"', `"name": "EXCLUDED_${scope}_theme"`),
        );
      }
    }

    function verifyProviderInput() {
      const decodeRequest = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            messages: Schema.Array(
              Schema.Struct({
                role: Schema.String,
                content: Schema.Unknown,
                tool_call_id: Schema.optional(Schema.String),
              }),
            ),
            tools: Schema.Array(
              Schema.Struct({ function: Schema.Struct({ name: Schema.String }) }),
            ),
          }),
        ),
      );
      for (const request of requests) {
        const input = decodeRequest(request);
        const system = input.messages
          .filter((message) => message.role === "system" || message.role === "developer")
          .map((message) => message.content)
          .join("\n");
        for (const sentinel of ["PROJECT_RULE_11", "PARENT_RULE_12", "GLOBAL_RULE_13"])
          expect(system).toContain(sentinel);
        expect(system).not.toContain("SHADOWED_CLAUDE_14");
        for (const sentinel of excluded) expect(request).not.toContain(sentinel);
        expect(input.tools.map((tool) => tool.function.name).toSorted()).toEqual([
          "bash",
          "edit",
          "read",
          "write",
        ]);
        expect(input.messages.find((message) => message.role === "user")?.content).toEqual([
          { type: "text", text: "/global-prompt" },
        ]);
      }
      const finalRequest = requests.at(-1);
      if (!finalRequest) throw new Error("Expected provider request");
      const results = decodeRequest(finalRequest).messages.filter(
        (message) => message.role === "tool",
      );
      expect(results.map((result) => result.tool_call_id)).toEqual(
        calls.map((call) => `stock-${call.name}`),
      );
      for (const [index, call] of calls.entries())
        expect(results[index]?.content).toContain(call.result);
    }

    async function fixture(path: string, bytes: string) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      originalFiles.set(path, bytes);
    }

    async function verifyUnloadedResources() {
      // V8 observes the real backend without replacing SDK loaders. Themes and dormant
      // templates cannot be proven unloaded merely by their absence from provider input.
      // These function names follow the pinned SDK; review them when upgrading Pi.
      const decodeCoverage = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            result: Schema.Array(
              Schema.Struct({
                url: Schema.String,
                functions: Schema.Array(
                  Schema.Struct({
                    functionName: Schema.String,
                    ranges: Schema.Array(Schema.Struct({ count: Schema.Number })),
                  }),
                ),
              }),
            ),
          }),
        ),
      );
      const scripts = [];
      for (const file of await readdir(coverageDir)) {
        if (file.endsWith(".json"))
          scripts.push(...decodeCoverage(await readFile(join(coverageDir, file), "utf8")).result);
      }
      await writeFile(
        testInfo.outputPath("resource-coverage.json"),
        JSON.stringify(
          scripts.filter((entry) =>
            /\/core\/(resource-loader|extensions\/loader|skills|prompt-templates|package-manager)\.js$/.test(
              entry.url,
            ),
          ),
        ).replaceAll(temporary, "[temporary]"),
      );
      for (const [file, names] of [
        ["resource-loader.js", ["loadThemeFromFile"]],
        ["extensions/loader.js", ["loadExtension"]],
        ["skills.js", ["loadSkills"]],
        ["prompt-templates.js", ["loadPromptTemplates"]],
        // Package collection happens before resource filters, so check it separately.
        ["package-manager.js", ["collectPackageResources"]],
      ] satisfies [string, string[]][]) {
        const script = scripts.find((entry) => entry.url.endsWith(`/core/${file}`));
        expect(script, `coverage for ${file}`).toBeDefined();
        for (const name of names) {
          const fn = script?.functions.find((entry) => entry.functionName === name);
          expect(fn, `coverage for ${name}`).toBeDefined();
          expect(fn?.ranges[0]?.count, `${name} must not run`).toBe(0);
        }
      }
    }
  });
}
