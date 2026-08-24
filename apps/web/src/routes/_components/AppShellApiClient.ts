import {
  pidexApiContract,
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

type ChatConfiguration = Partial<Pick<ChatSnapshot, "model" | "thinkingLevel">>;

export function makePidexApiClient() {
  let csrfToken = "";

  const stored = localStorage.getItem("pidex:client-id");
  const clientId = stored ?? createActionId();
  if (!stored) localStorage.setItem("pidex:client-id", clientId);

  const link = new RPCLink({
    url: "/api/rpc",
    headers: () => ({ "X-Pidex-CSRF": csrfToken }),
    plugins: [new ResponseValidationLinkPlugin(pidexApiContract)],
  });
  const client: PidexApiContractClient = createORPCClient(link);

  async function bootstrap(): Promise<Bootstrap> {
    const result = await client.system.bootstrap({});
    csrfToken = result.csrfToken;
    return result;
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
    expectedRevision: number,
    actionId: string,
  ): Promise<ActionOutcome> {
    return client.chats.sendMessage({
      chatId,
      clientId,
      actionId,
      expectedRevision,
      text,
      delivery: "normal",
    });
  }

  function abort(chatId: string, runId: string, expectedRevision: number): Promise<ActionOutcome> {
    return client.chats.abort({
      chatId,
      ...actionFields(expectedRevision),
      runId,
    });
  }

  function acknowledgeInterrupted(
    chatId: string,
    expectedRevision: number,
  ): Promise<ActionOutcome> {
    return client.chats.acknowledgeInterrupted({
      chatId,
      ...actionFields(expectedRevision),
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
    return { clientId, actionId: createActionId(), expectedRevision };
  }
  return {
    createActionId,
    bootstrap,
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
