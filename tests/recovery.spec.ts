import { expect } from "@playwright/test";
import { alive, test } from "./support/lifecycle.js";

test("#135 manually recovers the exact saved session after idle and busy crashes", async ({
  lifecycle,
}) => {
  const { page, process: main, children } = await lifecycle.launch();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await prompt.fill("Remember pear");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(1);
  lifecycle.complete("Saved pear");
  await expect(page.getByRole("status")).toHaveText("Idle");
  const saved = await lifecycle.history();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.bytes).toContain("Saved pear");
  for (const busy of [false, true]) {
    if (busy) {
      await prompt.fill("Continue");
      await send.click();
      await expect.poll(() => lifecycle.requests.length).toBe(2);
    }
    const [oldChild] = children();
    if (!oldChild) throw new Error("Missing child");
    process.kill(oldChild, "SIGKILL");
    await expect.poll(() => alive(oldChild)).toBe(false);
    const beforeRestart = await lifecycle.history();
    await expect(page.getByRole("alert")).toContainText("backend stopped");
    await expect(send).toBeDisabled();
    expect(main.pid && alive(main.pid)).toBe(true);
    expect(children()).toEqual([]);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await page.evaluate(() => Promise.all([window.desktop.restart(), window.desktop.restart()]));
    await expect(page.getByRole("status")).toHaveText("Idle");
    expect(await lifecycle.history()).toEqual(beforeRestart);
    await expect(page.getByLabel("assistant", { exact: true })).toHaveText("Saved pear");
    expect(children()).toHaveLength(1);
    expect(children()[0]).not.toBe(oldChild);
    expect(lifecycle.requests).toHaveLength(busy ? 2 : 1);
    if (!busy) expect(await lifecycle.history()).toEqual(saved);
    else await expect(page.getByRole("alert")).toContainText("interrupted");
  }
  await prompt.fill("Next");
  await send.click();
  await expect.poll(() => lifecycle.requests.length).toBe(3);
  lifecycle.complete("Ready");
  await expect(page.getByRole("status")).toHaveText("Idle");
  await expect(page.getByLabel("assistant", { exact: true })).toHaveText(["Saved pear", "Ready"]);
});
