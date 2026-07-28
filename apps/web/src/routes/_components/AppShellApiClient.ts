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
import { ResponseValidationPlugin } from "@orpc/contract/plugins";

type Delivery = "normal" | "steer" | "follow-up";
type ChatConfiguration = Partial<Pick<ChatSnapshot, "model" | "thinkingLevel">>;

export class PidexApiClient {
  private csrfToken = "";
  private readonly client: PidexApiContractClient;
  private readonly clientId: string;

  constructor() {
    const stored = localStorage.getItem("pidex:client-id");
    this.clientId = stored ?? this.createActionId();
    if (!stored) localStorage.setItem("pidex:client-id", this.clientId);

    const link = new RPCLink({
      url: new URL("/api/rpc", location.href),
      headers: () => ({ "X-Pidex-CSRF": this.csrfToken }),
      plugins: [new ResponseValidationPlugin(pidexApiContract)],
    });
    this.client = createORPCClient(link);
  }

  createActionId(): string {
    return crypto.randomUUID().replaceAll("-", "");
  }

  async bootstrap(): Promise<Bootstrap> {
    const result = await this.client.system.bootstrap({});
    this.csrfToken = result.csrfToken;
    return result;
  }

  openWorkspace(path: string, remember = true): Promise<Workspace> {
    return this.client.workspaces.open({ path, remember });
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<RecentWorkspace[]> {
    const result = await this.client.workspaces.reorder({ workspaceIds });
    return result.recentWorkspaces;
  }

  setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<Workspace> {
    return this.client.workspaces.trust({ workspaceId, trusted });
  }

  async listSessions(workspaceId: string): Promise<SessionSummary[]> {
    const result = await this.client.workspaces.sessions({ workspaceId });
    return result.sessions;
  }

  createChat(workspaceId: string): Promise<ChatSnapshot> {
    return this.client.chats.create({ workspaceId });
  }

  resumeTask(taskId: string): Promise<ChatSnapshot> {
    return this.client.chats.resume({ taskId });
  }

  getChat(chatId: string): Promise<ChatSnapshot> {
    return this.client.chats.get({ chatId });
  }

  async disposeChat(chatId: string): Promise<void> {
    await this.client.chats.dispose({ chatId });
  }

  sendMessage(
    chatId: string,
    text: string,
    delivery: Delivery,
    expectedRevision: number,
    runId?: string,
    actionId = this.createActionId(),
  ): Promise<ActionOutcome> {
    return this.client.chats.sendMessage({
      chatId,
      clientId: this.clientId,
      actionId,
      expectedRevision,
      text,
      delivery,
      ...(runId ? { runId } : {}),
    });
  }

  abort(
    chatId: string,
    runId: string,
    expectedRevision: number,
    actionId = this.createActionId(),
  ): Promise<ActionOutcome> {
    return this.client.chats.abort({
      chatId,
      clientId: this.clientId,
      actionId,
      expectedRevision,
      runId,
    });
  }

  acknowledgeInterrupted(
    chatId: string,
    expectedRevision: number,
    actionId = this.createActionId(),
  ): Promise<ActionOutcome> {
    return this.client.chats.acknowledgeInterrupted({
      chatId,
      clientId: this.clientId,
      actionId,
      expectedRevision,
    });
  }

  toolOutput(chatId: string, resourceId: string, offset: number): Promise<ToolOutputChunk> {
    return this.client.chats.toolOutput({ chatId, resourceId, offset, limit: 16_384 });
  }

  transcript(chatId: string, before: number): Promise<TranscriptPage> {
    return this.client.chats.transcript({ chatId, before, limit: 50 });
  }

  clearQueue(chatId: string, expectedRevision: number): Promise<ChatSnapshot> {
    return this.client.chats.clearQueue({
      chatId,
      ...this.actionFields(expectedRevision),
    });
  }

  configure(
    chatId: string,
    patch: ChatConfiguration,
    expectedRevision: number,
  ): Promise<ChatSnapshot> {
    return this.client.chats.configure({
      chatId,
      ...this.actionFields(expectedRevision),
      ...patch,
    });
  }

  rename(chatId: string, name: string, expectedRevision: number): Promise<ChatSnapshot> {
    return this.client.chats.rename({
      chatId,
      ...this.actionFields(expectedRevision),
      name,
    });
  }

  compact(chatId: string, expectedRevision: number, instructions?: string): Promise<ChatSnapshot> {
    return this.client.chats.compact({
      chatId,
      ...this.actionFields(expectedRevision),
      ...(instructions ? { instructions } : {}),
    });
  }

  async answerDialog(
    chatId: string,
    requestId: string,
    value: string | boolean | null,
    expectedRevision: number,
  ): Promise<void> {
    await this.client.chats.answerDialog({
      chatId,
      ...this.actionFields(expectedRevision),
      requestId,
      value,
    });
  }

  private actionFields(expectedRevision: number) {
    return { clientId: this.clientId, actionId: this.createActionId(), expectedRevision };
  }
}

export function dialogValue(
  dialog: ExtensionDialog,
  value: string | boolean,
  cancelled: boolean,
): string | boolean | null {
  if (cancelled) return null;
  return dialog.kind === "confirm" ? Boolean(value) : String(value);
}
