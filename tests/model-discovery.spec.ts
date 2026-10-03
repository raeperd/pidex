import { expect, type Page } from "@playwright/test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation } from "../packages/api/index.js";
import { test } from "./support/lifecycle.js";

test("#215 discovers models by provider and model ID without changing Pi", async ({
  lifecycle,
}) => {
  const settings = await piSettings(lifecycle.agentDir);
  const { page } = await lifecycle.launch();
  const conversation = await currentConversation(page);
  expect(conversation.model).toEqual({ provider: "openai", id: "gpt-6-luna" });

  const { list, error } = await listModels(page, conversation.id);
  expect(error).toBe("");
  expect(list).toMatchObject({ projectPath: conversation.projectPath, sessionId: conversation.id });
  expect(list?.errors).toEqual([]);
  expect(list?.models.filter((model) => model.name === "GPT-6 Luna")).toEqual([
    { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" },
    { provider: "moonbase", id: "luna-6", name: "GPT-6 Luna" },
  ]);
  // A result for an earlier session never describes the current one.
  expect(await listModels(page, "earlier-session")).toEqual({
    list: null,
    error: "The selected session changed. Refresh and try again.",
  });
  expect(lifecycle.requests).toHaveLength(0);
  expect(await piSettings(lifecycle.agentDir)).toEqual(settings);
});

test("#215 scopes discovery to the session after a project switch", async ({ lifecycle }) => {
  const beta = join(await realpath(lifecycle.home), "beta");
  await mkdir(beta);
  await writeFile(
    join(lifecycle.home, "metadata.json"),
    JSON.stringify({ version: 1, recentProjects: [beta] }),
  );
  const { page } = await lifecycle.launch();
  const before = await currentConversation(page);
  expect(
    await page.evaluate(([path, id]) => window.desktop.switchProject(path, id), [
      beta,
      before.id,
    ] as const),
  ).toEqual({ error: "" });
  await expect(page.getByRole("region", { name: "Current project" })).toContainText(beta);
  const after = await currentConversation(page);
  expect((await listModels(page, before.id)).list).toBeNull();
  expect((await listModels(page, after.id)).list).toMatchObject({
    projectPath: beta,
    sessionId: after.id,
    errors: [],
  });
  expect(lifecycle.requests).toHaveLength(0);
});

test("#215 reports a failed provider separately and Retry rediscovers it", async ({
  lifecycle,
}) => {
  const { page } = await lifecycle.launch();
  const conversation = await currentConversation(page);
  const auth = join(lifecycle.agentDir, "auth.json");
  const valid = await readFile(auth, "utf8");
  // A malformed credential fails only that provider's auth check.
  await writeFile(
    auth,
    JSON.stringify({
      openai: { type: "api_key", key: "fixture-key" },
      moonbase: { type: "api_key", key: 6 },
    }),
  );
  const failed = await listModels(page, conversation.id);
  expect(failed.list?.errors).toEqual([
    expect.objectContaining({ provider: "moonbase", message: expect.stringContaining("Retry") }),
  ]);
  expect(failed.list?.models).toContainEqual({
    provider: "openai",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
  });
  expect(failed.list?.models.some((model) => model.provider === "moonbase")).toBe(false);

  await writeFile(auth, valid);
  const retried = await listModels(page, conversation.id);
  expect(retried.list?.errors).toEqual([]);
  expect(retried.list?.models).toContainEqual({
    provider: "moonbase",
    id: "luna-6",
    name: "GPT-6 Luna",
  });
  expect((await currentConversation(page)).model).toEqual({ provider: "openai", id: "gpt-6-luna" });
  expect(lifecycle.requests).toHaveLength(0);
});

test("#215 distinguishes no authenticated models from bounded auth-check failures", async ({
  lifecycle,
}) => {
  const auth = join(lifecycle.agentDir, "auth.json");
  await writeFile(auth, "{}");
  const { page } = await lifecycle.launch();
  const conversation = await currentConversation(page);
  expect(await listModels(page, conversation.id)).toMatchObject({
    list: { models: [], errors: [] },
    error: "",
  });

  // Pi waits for a held credential lock; discovery must give up instead of hanging.
  await mkdir(`${auth}.lock`);
  await writeFile(auth, JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }));
  const locked = await listModels(page, conversation.id);
  expect(locked.list?.models).toEqual([]);
  expect(locked.list?.errors).toContainEqual(expect.objectContaining({ provider: "openai" }));
  await rm(`${auth}.lock`, { recursive: true });
  expect((await listModels(page, conversation.id)).list?.models).toContainEqual({
    provider: "openai",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
  });
  expect(lifecycle.requests).toHaveLength(0);
});

function currentConversation(page: Page) {
  return page.evaluate(
    () =>
      new Promise<typeof Conversation.Type>((resolve) => {
        const stop = window.desktop.subscribe((update) => {
          if (update?._tag !== "Snapshot") return;
          stop();
          resolve(update.conversation);
        });
      }),
  );
}

function listModels(page: Page, sessionId: string) {
  return page.evaluate((id) => window.desktop.listModels(id), sessionId);
}

async function piSettings(agentDir: string) {
  return Promise.all(
    ["settings.json", "auth.json", "models.json"].map((file) =>
      readFile(join(agentDir, file), "utf8"),
    ),
  );
}
