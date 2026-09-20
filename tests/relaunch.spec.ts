import { expect } from "@playwright/test";
import { Schema } from "effect";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { alive, test } from "./support/lifecycle.js";

test("#141 full Quit and relaunch starts a distinct conversation and preserves original history bytes", async ({
  lifecycle,
}, info) => {
  const first = await lifecycle.launch();
  await first.page.getByRole("textbox", { name: "Prompt" }).fill("Old conversation");
  await first.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("old reply");
  await expect(first.page.getByLabel("assistant", { exact: true })).toHaveText("old reply");
  await expect(first.page.getByRole("status")).toHaveText("Idle");
  const [original] = await lifecycle.history();
  if (!original) throw new Error("Missing original history");
  const header = Schema.decodeUnknownSync(
    Schema.Struct({ type: Schema.Literal("session"), id: Schema.String, cwd: Schema.String }),
  );
  const originalIdentity = header(JSON.parse(original.bytes.split("\n")[0] ?? ""));
  expect(originalIdentity.cwd).toBe(await realpath(lifecycle.project));
  const [originalChild] = first.children();
  if (!originalChild || !first.process.pid) throw new Error("Missing original process");
  await first.app.context().tracing.stop({ path: info.outputPath("before-quit.zip") });
  await first.app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect.poll(() => first.process.exitCode).toBe(0);
  await expect.poll(() => alive(originalChild)).toBe(false);
  expect(alive(first.process.pid)).toBe(false);

  const second = await lifecycle.launch();
  const [newChild] = second.children();
  if (!newChild || !second.process.pid) throw new Error("Missing new process");
  expect(second.process.pid).not.toBe(first.process.pid);
  expect(newChild).not.toBe(originalChild);
  expect(second.children()).toHaveLength(1);
  await expect(second.page.getByRole("status")).toHaveText("Idle");
  await expect(second.page.getByText("No messages yet.")).toBeVisible();
  await expect(second.page.getByLabel("assistant", { exact: true })).toHaveCount(0);
  expect(await lifecycle.history()).toEqual([original]);
  expect(lifecycle.requests).toHaveLength(1);
  const freshIdentity = await second.page.evaluate(() =>
    window.desktop.chooseProject().then((value) => value?.id),
  );
  expect(freshIdentity).not.toBe(originalIdentity.id);
  await second.page.getByRole("textbox", { name: "Prompt" }).fill("New conversation");
  await second.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => lifecycle.requests.length).toBe(2);
  lifecycle.complete("new reply");
  await expect(second.page.getByRole("status")).toHaveText("Idle");
  await expect(second.page.getByLabel("assistant", { exact: true })).toHaveText("new reply");
  const histories = await lifecycle.history();
  expect(histories).toHaveLength(2);
  const fresh = histories.find((file) => file.path !== original.path);
  if (!fresh) throw new Error("Missing distinct history file");
  const savedIdentity = header(JSON.parse(fresh.bytes.split("\n")[0] ?? ""));
  expect(savedIdentity.id).toBe(freshIdentity);
  expect(savedIdentity.id).not.toBe(originalIdentity.id);
  expect(savedIdentity.cwd).toBe(await realpath(lifecycle.project));
  expect(fresh.bytes).toContain("new reply");
  expect(fresh.bytes).not.toContain("old reply");
  expect(await readFile(original.path, "utf8")).toBe(original.bytes);
  await writeFile(
    info.outputPath("process-observations.json"),
    JSON.stringify(
      {
        originalMain: first.process.pid,
        originalBackend: originalChild,
        originalExited: true,
        relaunchedMain: second.process.pid,
        relaunchedBackend: newChild,
        originalSession: originalIdentity.id,
        newSession: savedIdentity.id,
        originalBytesUnchanged: true,
      },
      null,
      2,
    ),
  );
});
