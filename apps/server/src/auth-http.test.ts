import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPidexServer } from "./main.js";

describe.sequential("desktop HTTP authentication", () => {
  let app: Awaited<ReturnType<typeof createPidexServer>>;
  let origin: string;
  let stateDirectory: string;
  const previousStateDirectory = process.env.PIDEX_STATE_DIR;

  beforeAll(async () => {
    stateDirectory = await mkdtemp(path.join(os.tmpdir(), "pidex-auth-http-"));
    process.env.PIDEX_STATE_DIR = stateDirectory;
    app = await createPidexServer({
      desktopBootstrapCredential: "desktop-bootstrap-test-credential",
    });
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    if (previousStateDirectory === undefined) delete process.env.PIDEX_STATE_DIR;
    else process.env.PIDEX_STATE_DIR = previousStateDirectory;
    if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
  });

  it("rejects bootstrap without an authenticated session", async () => {
    const response = await fetch(`${origin}/api/rpc/system/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });

    expect(response.status).toBe(401);
  });

  it("exchanges a desktop grant for an HttpOnly session exactly once", async () => {
    const grantResponse = await fetch(`${origin}/api/auth/desktop-grant`, {
      method: "POST",
      headers: { authorization: "Bearer desktop-bootstrap-test-credential" },
    });
    expect(grantResponse.status).toBe(201);
    const grantBody: unknown = await grantResponse.json();
    if (!isSecretResponse(grantBody)) throw new Error("Expected a desktop grant secret");

    const exchange = () =>
      fetch(`${origin}/api/auth/desktop-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: grantBody.secret }),
      });
    const sessionResponse = await exchange();
    expect(sessionResponse.status).toBe(204);
    const cookie = sessionResponse.headers.get("set-cookie");
    expect(cookie).toMatch(/^pidex_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);

    const bootstrap = await fetch(`${origin}/api/rpc/system/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify({ json: {} }),
    });
    expect(bootstrap.status).toBe(200);
    expect((await exchange()).status).toBe(401);
  });

  it("accepts a WebSocket ticket once and rejects its replay", async () => {
    const { cookie, csrfToken } = await createDesktopSession(origin);
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { cookie, "x-pidex-csrf": csrfToken },
    });
    expect(ticketResponse.status).toBe(201);
    const ticketBody: unknown = await ticketResponse.json();
    if (!isSecretResponse(ticketBody)) throw new Error("Expected a WebSocket ticket");
    const websocketUrl = `${origin.replace("http:", "ws:")}/api/ws?ticket=${ticketBody.secret}`;

    const socket = await openWebSocket(websocketUrl);
    socket.close();
    await expect(openWebSocket(websocketUrl)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects action client IDs that do not match the authenticated session", async () => {
    const { cookie, csrfToken } = await createDesktopSession(origin);
    const response = await fetch(`${origin}/api/rpc/chats/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-pidex-csrf": csrfToken,
      },
      body: JSON.stringify({
        json: {
          chatId: "missing_chat",
          clientId: "spoofed_client",
          actionId: "action_12345",
          expectedRevision: 0,
          text: "hello",
          delivery: "normal",
        },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      json: { code: "client_mismatch" },
    });
  });
});

async function createDesktopSession(origin: string) {
  const grantResponse = await fetch(`${origin}/api/auth/desktop-grant`, {
    method: "POST",
    headers: { authorization: "Bearer desktop-bootstrap-test-credential" },
  });
  const grantBody: unknown = await grantResponse.json();
  if (!isSecretResponse(grantBody)) throw new Error("Expected a desktop grant secret");
  const sessionResponse = await fetch(`${origin}/api/auth/desktop-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: grantBody.secret }),
  });
  const cookie = sessionResponse.headers.get("set-cookie");
  if (!cookie) throw new Error("Expected a desktop session cookie");
  const bootstrapResponse = await fetch(`${origin}/api/rpc/system/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: {} }),
  });
  const bootstrapBody: unknown = await bootstrapResponse.json();
  const csrfToken = rpcCsrfToken(bootstrapBody);
  if (typeof csrfToken !== "string") throw new Error("Expected a CSRF token");
  return { cookie, csrfToken };
}

function rpcCsrfToken(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("json" in value)) return undefined;
  const json = value.json;
  if (typeof json !== "object" || json === null || !("csrfToken" in json)) return undefined;
  return json.csrfToken;
}

function openWebSocket(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_, response) => {
      const error = new Error(`WebSocket rejected with ${response.statusCode}`);
      Object.assign(error, { statusCode: response.statusCode });
      reject(error);
    });
    socket.once("error", reject);
  });
}

function isSecretResponse(value: unknown): value is { readonly secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof value.secret === "string"
  );
}
