import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright requires destructuring even when only testInfo is needed.
// oxlint-disable-next-line no-empty-pattern
test("#129 Cancel leaves the project chooser available", async ({}, testInfo) => {
  await using cleanup = new AsyncDisposableStack();
  const temporary = await mkdtemp(join(tmpdir(), "pidex-129-"));
  cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
  const app = await electron.launch({
    args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
    env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir() },
  });
  const electronProcess = app.process();
  cleanup.defer(async () => {
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) await app.close();
  });
  const logs: string[] = [];
  app.process().stderr?.on("data", (data) => logs.push(String(data)));
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  try {
    const picker = await app.evaluateHandle(({ dialog }) => {
      const observation = { opened: false };
      dialog.showOpenDialog = async () => {
        observation.opened = true;
        return { canceled: true, filePaths: [] };
      };
      return observation;
    });
    await page.getByRole("button", { name: "Choose project" }).click();
    await expect(page.getByRole("button", { name: "Choose project" })).toBeEnabled();
    expect(await picker.evaluate((observation) => observation.opened)).toBe(true);
    await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
    await app.context().tracing.stop();
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure.png"), timeout: 5000 });
    await writeFile(
      testInfo.outputPath("electron.log"),
      logs.join("").replaceAll(temporary, "[temporary]"),
    );
    await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
    throw error;
  }
});
