import { expect, type APIRequestContext, type Page } from "@playwright/test";

const authenticatedRequests = new WeakSet<APIRequestContext>();

async function rememberWorkspace(request: APIRequestContext, workspacePath: string) {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  expect(bootstrap.response.ok()).toBe(true);
  const opened = await rpcRequest(
    request,
    "workspaces/open",
    { path: workspacePath },
    bootstrap.result.csrfToken,
  );
  expect(opened.response.ok()).toBe(true);
}

async function rpcRequest<T = unknown>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
  csrfToken?: string,
) {
  await ensureAuthenticated(request);
  const response = await request.post(`/api/rpc/${procedure}`, {
    headers: csrfToken ? { "X-Pidex-CSRF": csrfToken } : undefined,
    data: { json: input },
  });
  return { response, result: ((await response.json()) as { json: T }).json };
}

async function ensureAuthenticated(request: APIRequestContext) {
  if (authenticatedRequests.has(request)) return;
  const bootstrapCredential = process.env.PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL;
  if (!bootstrapCredential) throw new Error("The E2E desktop bootstrap credential is missing");
  const grantResponse = await request.post("/api/auth/desktop-grant", {
    headers: { authorization: `Bearer ${bootstrapCredential}` },
  });
  if (!grantResponse.ok()) throw new Error("The E2E host rejected its desktop bootstrap");
  const grant: unknown = await grantResponse.json();
  if (!hasSecret(grant)) throw new Error("The E2E host returned an invalid desktop grant");
  const sessionResponse = await request.post("/api/auth/desktop-session", {
    data: { secret: grant.secret },
  });
  if (!sessionResponse.ok()) throw new Error("The E2E host rejected its desktop grant");
  authenticatedRequests.add(request);
}

function hasSecret(value: unknown): value is { readonly secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof value.secret === "string"
  );
}

async function openTasks(page: Page) {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 900) {
    const button = page.getByRole("button", { name: "Open tasks" });
    await expect(button).toBeVisible();
    await button.click();
  }
  await expect(page.getByRole("status", { name: "Loading project" })).toHaveCount(0);
  await expect(page.getByLabel("Add project", { exact: true })).toBeInViewport();
}

async function waitForFakeWebSocket(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              pidexTestSocket?: WebSocket;
            }
          ).pidexTestSocket?.readyState,
      ),
    )
    .toBe(1);
}

async function installFakeWebSocket(page: Page) {
  await page.route("**/api/auth/websocket-ticket", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      json: { secret: "e2e_fake_websocket_ticket_00000001", expiresAt: Date.now() + 60_000 },
    }),
  );
  await page.addInitScript(() => {
    const OPEN = 1;
    const CLOSED = 3;
    type FakeWebSocket = EventTarget & {
      readyState: number;
      send: () => void;
      close: () => void;
    };

    const makeFakeWebSocket = (): FakeWebSocket => {
      const socket = Object.assign(new EventTarget(), {
        readyState: 0,
        send() {},
        close() {
          if (socket.readyState === CLOSED) return;
          socket.readyState = CLOSED;
          socket.dispatchEvent(new CloseEvent("close", { code: 1000 }));
        },
      });
      const scope = globalThis as typeof globalThis & { pidexTestSocket?: FakeWebSocket };
      scope.pidexTestSocket = socket;
      setTimeout(() => {
        socket.readyState = OPEN;
        socket.dispatchEvent(new Event("open"));
      });
      return socket;
    };

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: function () {
        return makeFakeWebSocket();
      },
    });
  });
}

async function emitServerEvent(page: Page, event: unknown) {
  await page.evaluate((serverEvent) => {
    const scope = globalThis as typeof globalThis & { pidexTestSocket?: EventTarget };
    scope.pidexTestSocket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(serverEvent) }),
    );
  }, event);
}

export {
  emitServerEvent,
  installFakeWebSocket,
  openTasks,
  rememberWorkspace,
  rpcRequest,
  waitForFakeWebSocket,
};
