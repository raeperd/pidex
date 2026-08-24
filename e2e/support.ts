import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { basename } from "node:path";

export const workspaceName = basename(process.cwd());

export const e2eModel = { id: "e2e/model", provider: "e2e", name: "E2E model", reasoning: true };

export const fulfillJson = (route: Route, payload: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", json: { json: payload } });

export const routeInput = <T = Record<string, unknown>>(route: Route): T =>
  (route.request().postDataJSON() as { json: T }).json;

function patchRpcResponse(
  page: Page,
  procedure: string,
  patch: (
    json: Record<string, unknown>,
    route: Route,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  return page.route(`**/api/rpc/${procedure}`, async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { ...payload, json: await patch(payload.json, route) } });
  });
}

function fulfillAccepted(route: Route, input: Record<string, unknown>, runId: string) {
  return fulfillJson(route, {
    accepted: true,
    actionId: input.actionId,
    runId,
    status: "accepted",
    revision: Number(input.expectedRevision) + 1,
    replayed: false,
  });
}

const makeChatSnapshot = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  revision: 0,
  runStatus: "idle",
  thinkingLevel: "high",
  items: [],
  transcriptStart: 0,
  transcriptTotal: 0,
  steeringQueue: [],
  followUpQueue: [],
  stats: { messages: 0, toolCalls: 0, tokens: 0, cost: 0, subscription: false },
  ...overrides,
});

function installIntegratedTitleBar(page: Page) {
  return page.addInitScript(() => {
    Object.defineProperty(window, "pidexDesktop", {
      value: {
        usesIntegratedTitleBar: true,
        pickProject: () => Promise.resolve(null),
      },
    });
  });
}

async function startNewTask(page: Page, request: APIRequestContext) {
  await rememberWorkspace(request, process.cwd());
  await page.goto("/");
  await openTasks(page);
  const newTaskButton = page.getByRole("button", { name: `New task in ${workspaceName}` });
  await expect(newTaskButton).toBeEnabled();
  await newTaskButton.evaluate((button: HTMLButtonElement) => button.click());
}

async function createTask(request: APIRequestContext, workspacePath: string) {
  const { csrfToken, workspace } = await rememberWorkspace(request, workspacePath);
  const created = await rpcRequest<Record<string, unknown> & { taskId: string }>(
    request,
    "chats/create",
    { workspaceId: workspace.id },
    csrfToken,
  );
  return { csrfToken, workspace, task: created.result };
}

const authenticatedRequests = new WeakSet<APIRequestContext>();

async function rememberWorkspace(request: APIRequestContext, workspacePath: string) {
  const bootstrap = await rpcRequest<{ csrfToken: string }>(request, "system/bootstrap", {});
  expect(bootstrap.response.ok()).toBe(true);
  const opened = await rpcRequest<Record<string, unknown> & { id: string; path: string }>(
    request,
    "workspaces/open",
    { path: workspacePath },
    bootstrap.result.csrfToken,
  );
  expect(opened.response.ok()).toBe(true);
  return { csrfToken: bootstrap.result.csrfToken, workspace: opened.result };
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

async function captureCreatedChat(page: Page) {
  const captured: { current?: Record<string, unknown> } = {};
  await page.route("**/api/rpc/chats/create", async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as { json: Record<string, unknown> };
    captured.current = payload.json;
    await route.fulfill({ response, json: payload });
  });
  return captured;
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
  captureCreatedChat,
  createTask,
  emitServerEvent,
  fulfillAccepted,
  installFakeWebSocket,
  installIntegratedTitleBar,
  makeChatSnapshot,
  openTasks,
  patchRpcResponse,
  rememberWorkspace,
  rpcRequest,
  startNewTask,
  waitForFakeWebSocket,
};
