import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const provider of [
  { id: "amazon-bedrock", model: "amazon.nova-lite-v1:0", name: "Nova Lite" },
  { id: "google-vertex", model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
]) {
  for (const configured of [true, false]) {
    // Playwright requires destructuring even when only testInfo is needed.
    // oxlint-disable-next-line no-empty-pattern
    test(`${configured ? "#129" : "#138"} ${provider.id} ${configured ? "accepts Pi credentials without an API key" : "blocks Send when credentials are missing"}`, async ({}, testInfo) => {
      await using cleanup = new AsyncDisposableStack();
      const temporary = await mkdtemp(join(tmpdir(), "pidex-auth-"));
      cleanup.defer(() => rm(temporary, { recursive: true, force: true }));
      const project = join(temporary, "project");
      const agentDir = join(temporary, ".pi", "agent");
      await mkdir(project, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider.id, defaultModel: provider.model }),
      );
      if (configured) {
        // Match credentials saved by Pi's AWS profile and ADC login flows.
        const env =
          provider.id === "amazon-bedrock"
            ? { AWS_PROFILE: "pidex-test" }
            : { GOOGLE_CLOUD_PROJECT: "pidex-test", GOOGLE_CLOUD_LOCATION: "us-central1" };
        await writeFile(
          join(agentDir, "auth.json"),
          JSON.stringify({ [provider.id]: { type: "api_key", env } }),
        );
        if (provider.id === "google-vertex") {
          const gcloud = join(temporary, ".config", "gcloud");
          await mkdir(gcloud, { recursive: true });
          await writeFile(
            join(gcloud, "application_default_credentials.json"),
            JSON.stringify({
              type: "authorized_user",
              client_id: "pidex-test",
              client_secret: "pidex-test",
              refresh_token: "pidex-test",
            }),
          );
        }
      }
      // Isolate personal credentials. This checks Pi's local auth resolution;
      // no prompt is sent and no cloud credential exchange is needed.
      const app = await electron.launch({
        args: ["dist/desktop/main.js", `--user-data-dir=${temporary}`],
        env: { PATH: process.env.PATH ?? "", HOME: temporary, TMPDIR: tmpdir(), PI_OFFLINE: "1" },
      });
      cleanup.defer(() => app.close());
      const logs: string[] = [];
      app.process().stderr?.on("data", (data) => logs.push(String(data)));
      const page = await app.firstWindow();
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      cleanup.defer(async () => {
        await page.screenshot({ path: testInfo.outputPath("result.png") }).catch(() => {});
        await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") });
        await writeFile(
          testInfo.outputPath("electron.log"),
          logs
            .join("")
            .replaceAll(temporary, "[temporary]")
            .replaceAll("pidex-test", "[credential]"),
        );
      });
      await app.evaluate(({ dialog }, projectPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
      }, project);
      await page.getByRole("button", { name: "Choose project" }).click();
      const conversation = page.getByRole("region", { name: "Conversation" });
      await expect(conversation).toBeVisible({ timeout: 15_000 });
      await expect(conversation.getByRole("status")).toHaveText("Idle");
      await page.getByRole("textbox", { name: "Prompt" }).fill("next task");
      const send = page.getByRole("button", { name: "Send", exact: true });
      if (configured) {
        await expect(send).toBeEnabled();
        await expect(conversation.getByText(provider.name, { exact: true })).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
      } else {
        await expect(send).toBeDisabled();
        await expect(page.getByRole("alert")).toContainText("authentication is unavailable");
      }
    });
  }
}
