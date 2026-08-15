import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { basename } from "node:path";

export const workspaceName = basename(process.cwd());

export const fulfillJson = (route: Route, payload: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", json: { json: payload } });

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
  const response = await request.post(`/api/rpc/${procedure}`, {
    headers: csrfToken ? { "X-Pidex-CSRF": csrfToken } : undefined,
    data: { json: input },
  });
  return { response, result: ((await response.json()) as { json: T }).json };
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
  installFakeWebSocket,
  openTasks,
  rememberWorkspace,
  rpcRequest,
  startNewTask,
  waitForFakeWebSocket,
};
