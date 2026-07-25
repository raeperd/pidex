import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

test("serves the Pi host and branded assets", async ({ request }) => {
  const health = await rpcRequest(request, "system/health", {});
  expect(health.response.status()).toBe(200);
  expect(health.result).toEqual({
    ok: true,
    protocolVersion: 3,
  });

  const png = await request.get("/pidex-icon.png");
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toBe("image/png");
  expect([...(await png.body()).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const icon = await request.get("/favicon.ico");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/x-icon");
  expect([...(await icon.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
});

test("serves the contract through oRPC's native transport", async ({ request }) => {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  const { csrfToken } = bootstrap.result;

  const invalid = await rpcRequest(request, "chats/create", {}, csrfToken);
  expect(invalid.response.status()).toBe(400);
  expect(invalid.result).toEqual(
    expect.objectContaining({ code: "BAD_REQUEST", message: "Input validation failed" }),
  );

  const malformed = await request.post("/api/rpc/chats/create", {
    headers: { "X-Pidex-CSRF": csrfToken, "Content-Type": "application/json" },
    data: Buffer.from("{"),
  });
  expect(malformed.status()).toBe(400);
  await expect(rpcResult(malformed)).resolves.toEqual(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );

  const missingCsrf = await rpcRequest(request, "chats/create", {
    workspaceId: "workspace_12345",
  });
  expect(missingCsrf.response.status()).toBe(403);
  expect(missingCsrf.result).toEqual(
    expect.objectContaining({ code: "csrf", message: "Invalid CSRF token" }),
  );

  const oversized = await rpcRequest(
    request,
    "chats/create",
    { workspaceId: "x".repeat(70 * 1024) },
    csrfToken,
  );
  expect(oversized.response.status()).toBe(413);
  expect(oversized.result).toEqual(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));

  const opened = await rpcRequest<{ id: string }>(
    request,
    "workspaces/open",
    { path: process.cwd(), remember: false },
    csrfToken,
  );
  expect(opened.response.ok()).toBe(true);

  const created = await rpcRequest<{ chatId: string; revision: number }>(
    request,
    "chats/create",
    { workspaceId: opened.result.id },
    csrfToken,
  );
  expect(created.response.status()).toBe(200);

  const transcript = await rpcRequest(
    request,
    "chats/transcript",
    { chatId: created.result.chatId, before: 0, limit: 50 },
    csrfToken,
  );
  expect(transcript.response.status()).toBe(200);
  expect(transcript.result).toEqual(
    expect.objectContaining({ items: expect.any(Array), start: 0, total: 0 }),
  );

  const cleared = await rpcRequest(
    request,
    "chats/clearQueue",
    {
      chatId: created.result.chatId,
      clientId: "e2e_client_12345",
      actionId: crypto.randomUUID().replaceAll("-", ""),
      expectedRevision: created.result.revision,
    },
    csrfToken,
  );
  expect(cleared.response.status()).toBe(200);

  const disposed = await rpcRequest(
    request,
    "chats/dispose",
    { chatId: created.result.chatId },
    csrfToken,
  );
  expect(disposed.response.status()).toBe(200);
  expect(disposed.result).toEqual({ ok: true });
});

async function rpcRequest<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
  csrfToken?: string,
) {
  const response = await request.post(`/api/rpc/${procedure}`, {
    headers: csrfToken ? { "X-Pidex-CSRF": csrfToken } : undefined,
    data: { json: input },
  });
  return { response, result: (await rpcResult(response)) as T };
}

async function rpcResult(response: APIResponse) {
  const payload = (await response.json()) as { json: unknown };
  return payload.json;
}
