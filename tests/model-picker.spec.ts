import { expect, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive, test } from "./support/lifecycle.js";

test("#215 searches models by provider, name, or ID and navigates by keyboard", async ({
  lifecycle,
}) => {
  const settings = await piSettings(lifecycle.agentDir);
  const { page } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Unsent draft");
  const { search, options } = await openPicker(page);
  await expect(search).toBeFocused();

  await search.fill("GPT-6 Luna");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("openai · gpt-6-luna");
  await expect(options.nth(0)).toContainText("Current");
  await expect(options.nth(1)).toContainText("moonbase · luna-6");
  await expect(options.nth(1)).not.toContainText("Current");
  for (const [query, model] of [
    ["moonbase", "moonbase · luna-6"],
    ["luna-6", "moonbase · luna-6"],
    ["openai gpt-6-luna", "openai · gpt-6-luna"],
  ]) {
    await search.fill(query);
    await expect(options).toHaveCount(1);
    await expect(options).toContainText(model);
  }
  await search.fill("no such model");
  await expect(options).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("No models match “no such model”.");

  await search.fill("GPT-6 Luna");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", "model-option-1");
  await search.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await search.press("End");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await search.press("Home");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  // Enter inside the composer form must not send the draft.
  await search.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Idle");

  await search.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue("Unsent draft");
  await expect(page.getByRole("button", { name: "Model: GPT-6 Luna" })).toBeVisible();
  // Moving focus elsewhere closes the picker without taking focus back.
  await openPicker(page);
  await page.getByRole("searchbox", { name: "Search saved sessions" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search saved sessions" })).toBeFocused();
  await expect(prompt).toHaveValue("Unsent draft");
  expect(lifecycle.requests).toHaveLength(0);
  expect(await piSettings(lifecycle.agentDir)).toEqual(settings);
});

test("#215 keeps other providers usable when one auth check fails, and Retry rediscovers", async ({
  lifecycle,
}) => {
  const settings = await piSettings(lifecycle.agentDir);
  const { page } = await lifecycle.launch();
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
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Unsent draft");
  const { dialog, search, options } = await openPicker(page);
  await expect(dialog.getByRole("alert")).toContainText("moonbase");
  await search.fill("GPT-6 Luna");
  await expect(options).toHaveCount(1);
  await expect(options).toContainText("openai · gpt-6-luna");

  await writeFile(auth, valid);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(options).toHaveCount(2);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(options.nth(0)).toContainText("Current");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Model: GPT-6 Luna" })).toBeVisible();
  await expect(prompt).toHaveValue("Unsent draft");
  expect(lifecycle.requests).toHaveLength(0);
  expect(await piSettings(lifecycle.agentDir)).toEqual(settings);
});

test("#215 distinguishes loading, no authenticated models, and discovery failure", async ({
  lifecycle,
}) => {
  const auth = join(lifecycle.agentDir, "auth.json");
  await writeFile(auth, "{}");
  const settings = await piSettings(lifecycle.agentDir);
  const { page, children } = await lifecycle.launch();
  // The picker stays usable while setup disables Send.
  await expect(page.getByRole("alert")).toContainText("authentication");
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Unsent draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const { dialog, options } = await openPicker(page);
  await expect(dialog).toContainText("No authenticated models");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(options).toHaveCount(0);

  // Pi waits for a held credential lock; discovery stays loading until its bound expires.
  await mkdir(`${auth}.lock`);
  await writeFile(auth, JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }));
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog).toContainText("Loading models…");
  await expect(dialog.getByRole("alert")).toContainText("could not check provider authentication", {
    timeout: 10_000,
  });
  await rm(`${auth}.lock`, { recursive: true });
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(options.first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // Discovery never changes Send gating.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  const [backend] = children();
  if (!backend) throw new Error("Missing Pi backend");
  process.kill(backend, "SIGKILL");
  await expect.poll(() => alive(backend)).toBe(false);
  // Reopening runs discovery again.
  await dialog.getByRole("combobox").press("Escape");
  await openPicker(page);
  await expect(dialog.getByRole("alert")).toContainText("Could not load models");
  await expect(options).toHaveCount(0);
  await expect(prompt).toHaveValue("Unsent draft");
  expect(lifecycle.requests).toHaveLength(0);
  // The test rewrote auth.json itself; Pidex leaves the other Pi files alone.
  expect((await piSettings(lifecycle.agentDir)).toSpliced(1, 1)).toEqual(settings.toSpliced(1, 1));
});

async function openPicker(page: Page) {
  await page.getByRole("button", { name: /^Model:/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose model" });
  return {
    dialog,
    search: dialog.getByRole("combobox", { name: "Search models" }),
    options: dialog.getByRole("option"),
  };
}

async function piSettings(agentDir: string) {
  return Promise.all(
    ["settings.json", "auth.json", "models.json"].map((file) =>
      readFile(join(agentDir, file), "utf8"),
    ),
  );
}
