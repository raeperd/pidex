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

async function waitForFakeEventStream(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            pidexTestEventStreams?: Array<{ open: boolean }>;
          }
        ).pidexTestEventStreams?.some((stream) => stream.open),
      ),
    )
    .toBe(true);
}

async function installFakeEventStream(page: Page) {
  await page.addInitScript(() => {
    type FakeEventStreamState = {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      open: boolean;
    };

    const realFetch = globalThis.fetch.bind(globalThis);
    const encoder = new TextEncoder();
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (!url.pathname.endsWith("/api/rpc/live/events")) return realFetch(input, init);

      const state: FakeEventStreamState = { open: true };
      const scope = globalThis as typeof globalThis & {
        pidexTestEventStreams?: FakeEventStreamState[];
      };
      (scope.pidexTestEventStreams ??= []).push(state);
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller;
          controller.enqueue(encoder.encode(": connected\n\n"));
          signal?.addEventListener(
            "abort",
            () => {
              state.open = false;
              controller.close();
            },
            { once: true },
          );
        },
        cancel() {
          state.open = false;
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "standard-server": "event-stream",
        },
      });
    };
  });
}

async function emitServerEvent(page: Page, event: unknown) {
  await page.evaluate((serverEvent) => {
    const scope = globalThis as typeof globalThis & {
      pidexTestEventStreams?: FakeEventStream[];
    };
    const stream = scope.pidexTestEventStreams?.findLast((candidate) => candidate.open);
    if (!stream?.controller) throw new Error("Expected an active HTTP event stream");
    stream.controller.enqueue(
      new TextEncoder().encode(
        `event: message\ndata: ${JSON.stringify({ json: serverEvent })}\n\n`,
      ),
    );
  }, event);
}

type FakeEventStream = {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  open: boolean;
};

export {
  captureCreatedChat,
  createTask,
  emitServerEvent,
  fulfillAccepted,
  installFakeEventStream,
  installIntegratedTitleBar,
  makeChatSnapshot,
  openTasks,
  patchRpcResponse,
  rememberWorkspace,
  rpcRequest,
  startNewTask,
  waitForFakeEventStream,
};
