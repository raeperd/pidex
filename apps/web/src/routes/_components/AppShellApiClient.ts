import {
  authGrantSchema,
  pidexApiContract,
  safeParse,
  type ActionOutcome,
  type Bootstrap,
  type ChatSnapshot,
  type ExtensionDialog,
  type PidexApiContractClient,
  type RecentWorkspace,
  type SessionSummary,
  type ToolOutputChunk,
  type TranscriptPage,
  type Workspace,
} from "@pidex/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ResponseValidationLinkPlugin } from "@orpc/contract/plugins";

type Delivery = "normal" | "steer" | "follow-up";
type ChatConfiguration = Partial<Pick<ChatSnapshot, "model" | "thinkingLevel">>;
let desktopSessionEstablished = false;

export function makePidexApiClient() {
  let csrfToken = "";
  let clientId = "";

  const link = new RPCLink({
    url: "/api/rpc",
    headers: () => ({ "X-Pidex-CSRF": csrfToken }),
    plugins: [new ResponseValidationLinkPlugin(pidexApiContract)],
  });
  const client: PidexApiContractClient = createORPCClient(link);

  async function bootstrap(): Promise<Bootstrap> {
    await ensureDesktopSession();
    const result = await client.system.bootstrap({});
    csrfToken = result.csrfToken;
    clientId = result.clientId;
    return result;
  }

  async function websocketTicket(): Promise<string> {
    const response = await fetch("/api/auth/websocket-ticket", {
      method: "POST",
      headers: { "X-Pidex-CSRF": csrfToken },
    });
    if (!response.ok) throw new Error("Pidex could not authorize the live connection");
    const body: unknown = await response.json();
    const result = safeParse(authGrantSchema, body);
    if (!result.success) throw new Error("Pidex returned an invalid live-connection ticket");
    return result.output.secret;
  }

  function openWorkspace(path: string, remember = true): Promise<Workspace> {
    return client.workspaces.open({ path, remember });
  }

  function createWorktree(workspaceId: string): Promise<Workspace> {
    return client.workspaces.createWorktree({ workspaceId });
  }

  async function removeWorktree(workspaceId: string): Promise<void> {
    await client.workspaces.removeWorktree({ workspaceId });
  }

  async function reorderWorkspaces(workspaceIds: string[]): Promise<RecentWorkspace[]> {
    const result = await client.workspaces.reorder({ workspaceIds });
    return result.recentWorkspaces;
  }

  function setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<Workspace> {
    return client.workspaces.trust({ workspaceId, trusted });
  }

  async function listSessions(workspaceId: string): Promise<SessionSummary[]> {
    const result = await client.workspaces.sessions({ workspaceId });
    return result.sessions;
  }

  function createChat(workspaceId: string): Promise<ChatSnapshot> {
    return client.chats.create({ workspaceId });
  }

  function resumeTask(taskId: string): Promise<ChatSnapshot> {
    return client.chats.resume({ taskId });
  }

  function getChat(chatId: string): Promise<ChatSnapshot> {
    return client.chats.get({ chatId });
  }

  async function disposeChat(chatId: string): Promise<void> {
    await client.chats.dispose({ chatId });
  }

  function sendMessage(
    chatId: string,
    text: string,
    delivery: Delivery,
    expectedRevision: number,
    runId?: string,
    actionId = createActionId(),
  ): Promise<ActionOutcome> {
    return client.chats.sendMessage({
      chatId,
      clientId: clientId,
      actionId,
      expectedRevision,
      text,
      delivery,
      ...(runId ? { runId } : {}),
    });
  }

  function abort(
    chatId: string,
    runId: string,
    expectedRevision: number,
    actionId = createActionId(),
  ): Promise<ActionOutcome> {
    return client.chats.abort({
      chatId,
      clientId: clientId,
      actionId,
      expectedRevision,
      runId,
    });
  }

  function acknowledgeInterrupted(
    chatId: string,
    expectedRevision: number,
    actionId = createActionId(),
  ): Promise<ActionOutcome> {
    return client.chats.acknowledgeInterrupted({
      chatId,
      clientId: clientId,
      actionId,
      expectedRevision,
    });
  }

  function toolOutput(
    chatId: string,
    resourceId: string,
    offset: number,
  ): Promise<ToolOutputChunk> {
    return client.chats.toolOutput({ chatId, resourceId, offset, limit: 16_384 });
  }

  function transcript(chatId: string, before: number): Promise<TranscriptPage> {
    return client.chats.transcript({ chatId, before, limit: 50 });
  }

  function clearQueue(chatId: string, expectedRevision: number): Promise<ChatSnapshot> {
    return client.chats.clearQueue({
      chatId,
      ...actionFields(expectedRevision),
    });
  }

  function configure(
    chatId: string,
    patch: ChatConfiguration,
    expectedRevision: number,
  ): Promise<ChatSnapshot> {
    return client.chats.configure({
      chatId,
      ...actionFields(expectedRevision),
      ...patch,
    });
  }

  function rename(chatId: string, name: string, expectedRevision: number): Promise<ChatSnapshot> {
    return client.chats.rename({
      chatId,
      ...actionFields(expectedRevision),
      name,
    });
  }

  function compact(
    chatId: string,
    expectedRevision: number,
    instructions?: string,
  ): Promise<ChatSnapshot> {
    return client.chats.compact({
      chatId,
      ...actionFields(expectedRevision),
      ...(instructions ? { instructions } : {}),
    });
  }

  async function answerDialog(
    chatId: string,
    requestId: string,
    value: string | boolean | null,
    expectedRevision: number,
  ): Promise<void> {
    await client.chats.answerDialog({
      chatId,
      ...actionFields(expectedRevision),
      requestId,
      value,
    });
  }

  function actionFields(expectedRevision: number) {
    return { clientId: clientId, actionId: createActionId(), expectedRevision };
  }
  return {
    createActionId,
    bootstrap,
    websocketTicket,
    openWorkspace,
    createWorktree,
    removeWorktree,
    reorderWorkspaces,
    setWorkspaceTrust,
    listSessions,
    createChat,
    resumeTask,
    getChat,
    disposeChat,
    sendMessage,
    abort,
    acknowledgeInterrupted,
    toolOutput,
    transcript,
    clearQueue,
    configure,
    rename,
    compact,
    answerDialog,
  };
}

async function ensureDesktopSession() {
  if (desktopSessionEstablished) return;
  const grant = await window.pidexDesktop?.takeAuthGrant?.();
  const bootstrapCredential = grant ?? PIDEX_DEV_BOOTSTRAP_CREDENTIAL;
  if (!bootstrapCredential) return;
  const grantResponse = grant
    ? { secret: grant }
    : await createDevelopmentGrant(bootstrapCredential);
  const response = await fetch("/api/auth/desktop-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grantResponse),
  });
  if (!response.ok) throw new Error("Pidex could not authenticate this desktop window");
  desktopSessionEstablished = true;
}

async function createDevelopmentGrant(bootstrapCredential: string) {
  const response = await fetch("/api/auth/desktop-grant", {
    method: "POST",
    headers: { authorization: `Bearer ${bootstrapCredential}` },
  });
  const body: unknown = await response.json();
  const result = safeParse(authGrantSchema, body);
  if (!response.ok || !result.success)
    throw new Error("Pidex could not create a development desktop grant");
  return result.output;
}

declare const PIDEX_DEV_BOOTSTRAP_CREDENTIAL: string;

export type PidexApiClient = ReturnType<typeof makePidexApiClient>;

function createActionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function dialogValue(
  dialog: ExtensionDialog,
  value: string | boolean,
  cancelled: boolean,
): string | boolean | null {
  if (cancelled) return null;
  return dialog.kind === "confirm" ? Boolean(value) : String(value);
}
