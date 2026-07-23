import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

describe("HTTP control surface", () => {
  let app: Awaited<ReturnType<typeof createPidexServer>>; let origin: string; let csrf: string;
  beforeEach(async () => {
    process.env.PIDEX_ADAPTER = "fake"; process.env.WORKSPACE_ROOTS = process.cwd(); process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-state-"));
    app = await createPidexServer(); await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve)); const address = app.server.address(); if (!address || typeof address === "string") throw new Error("No address"); origin = `http://127.0.0.1:${address.port}`;
    csrf = (await (await fetch(`${origin}/api/bootstrap`)).json() as { csrfToken: string }).csrfToken;
  });
  afterEach(async () => { await app.close(); });
  it("enforces Host, CSRF, request limits, and completes the fake flow", async () => {
    const badHostStatus = await new Promise<number>((resolve, reject) => { const target = new URL(origin); const request = http.request({ hostname: target.hostname, port: target.port, path: "/api/health", headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }); request.on("error", reject); request.end(); }); expect(badHostStatus).toBe(403);
    const noCsrf = await fetch(`${origin}/api/workspaces/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: process.cwd() }) }); expect(noCsrf.status).toBe(403);
    const huge = await fetch(`${origin}/api/workspaces/open`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf }, body: JSON.stringify({ path: "x".repeat(70_000) }) }); expect(huge.status).toBe(413);
    const opened = await fetch(`${origin}/api/workspaces/open`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf }, body: JSON.stringify({ path: process.cwd() }) }); expect(opened.status).toBe(200); const workspace = await opened.json() as { id: string };
    const created = await fetch(`${origin}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf }, body: JSON.stringify({ workspaceId: workspace.id }) }); expect(created.status).toBe(201); const chat = await created.json() as { chatId: string };
    const sent = await fetch(`${origin}/api/chats/${chat.chatId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pidex-CSRF": csrf }, body: JSON.stringify({ text: "hello", delivery: "normal" }) }); expect(sent.status).toBe(202);
  });
});
