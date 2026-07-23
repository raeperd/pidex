import {
  actionOutcomeSchema,
  apiErrorSchema,
  bootstrapSchema,
  chatSnapshotSchema,
  okResponseSchema,
  sessionsResponseSchema,
  toolOutputChunkSchema,
  transcriptPageSchema,
  workspaceSchema,
  type Bootstrap,
  type ActionOutcome,
  type ChatSnapshot,
  type ExtensionDialog,
  type SessionSummary,
  type ToolOutputChunk,
  type TranscriptPage,
  type Workspace,
} from "@pidex/api";
import type { ZodType } from "zod";

type Delivery = "normal" | "steer" | "follow-up";
type ChatConfiguration = Partial<Pick<ChatSnapshot, "model" | "thinkingLevel" | "toolMode">>;

export class PidexApiClient {
  private csrfToken = "";
  private readonly clientId: string;

  constructor() {
    const stored = localStorage.getItem("pidex:client-id");
    this.clientId = stored ?? this.createActionId();
    if (!stored) localStorage.setItem("pidex:client-id", this.clientId);
  }

  createActionId(): string { return crypto.randomUUID().replaceAll("-", ""); }
  private actionFields(expectedRevision: number) { return { clientId: this.clientId, actionId: this.createActionId(), expectedRevision }; }

  private async request<T>(url: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (init.method && init.method !== "GET") headers.set("X-Pidex-CSRF", this.csrfToken);

    const response = await fetch(url, { ...init, headers });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      throw new Error(error.success ? error.data.error.message : "Request failed");
    }
    return schema.parse(body);
  }

  async bootstrap(): Promise<Bootstrap> {
    const result = await this.request("/api/bootstrap", bootstrapSchema);
    this.csrfToken = result.csrfToken;
    return result;
  }

  openWorkspace(path: string): Promise<Workspace> {
    return this.request("/api/workspaces/open", workspaceSchema, { method: "POST", body: JSON.stringify({ path }) });
  }

  setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<Workspace> {
    return this.request(`/api/workspaces/${workspaceId}/trust`, workspaceSchema, { method: "POST", body: JSON.stringify({ trusted }) });
  }

  async listSessions(workspaceId: string): Promise<SessionSummary[]> {
    const result = await this.request(`/api/workspaces/${workspaceId}/sessions`, sessionsResponseSchema);
    return result.sessions;
  }

  createChat(workspaceId: string): Promise<ChatSnapshot> {
    return this.request("/api/chats", chatSnapshotSchema, { method: "POST", body: JSON.stringify({ workspaceId }) });
  }

  resumeChat(workspaceId: string, sessionId: string): Promise<ChatSnapshot> {
    return this.request("/api/chats/resume", chatSnapshotSchema, { method: "POST", body: JSON.stringify({ workspaceId, sessionId }) });
  }

  getChat(chatId: string): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}`, chatSnapshotSchema);
  }

  sendMessage(chatId: string, text: string, delivery: Delivery, expectedRevision: number, runId?: string, actionId = this.createActionId()): Promise<ActionOutcome> {
    return this.request(`/api/chats/${chatId}/messages`, actionOutcomeSchema, { method: "POST", body: JSON.stringify({ clientId: this.clientId, actionId, expectedRevision, text, delivery, ...(runId ? { runId } : {}) }) });
  }

  abort(chatId: string, runId: string, expectedRevision: number, actionId = this.createActionId()): Promise<ActionOutcome> {
    return this.request(`/api/chats/${chatId}/abort`, actionOutcomeSchema, { method: "POST", body: JSON.stringify({ clientId: this.clientId, actionId, expectedRevision, runId }) });
  }

  acknowledgeInterrupted(chatId: string, expectedRevision: number, actionId = this.createActionId()): Promise<ActionOutcome> {
    return this.request(`/api/chats/${chatId}/interrupted/acknowledge`, actionOutcomeSchema, { method: "POST", body: JSON.stringify({ clientId: this.clientId, actionId, expectedRevision }) });
  }

  toolOutput(chatId: string, resourceId: string, offset: number): Promise<ToolOutputChunk> {
    return this.request(`/api/chats/${chatId}/tools/${resourceId}?offset=${offset}&limit=16384`, toolOutputChunkSchema);
  }

  transcript(chatId: string, before: number): Promise<TranscriptPage> {
    return this.request(`/api/chats/${chatId}/transcript?before=${before}&limit=50`, transcriptPageSchema);
  }

  clearQueue(chatId: string, expectedRevision: number): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/queue`, chatSnapshotSchema, { method: "DELETE", body: JSON.stringify(this.actionFields(expectedRevision)) });
  }

  configure(chatId: string, patch: ChatConfiguration, expectedRevision: number): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/config`, chatSnapshotSchema, { method: "PATCH", body: JSON.stringify({ ...this.actionFields(expectedRevision), ...patch }) });
  }

  rename(chatId: string, name: string, expectedRevision: number): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/rename`, chatSnapshotSchema, { method: "POST", body: JSON.stringify({ ...this.actionFields(expectedRevision), name }) });
  }

  compact(chatId: string, expectedRevision: number): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/compact`, chatSnapshotSchema, { method: "POST", body: JSON.stringify(this.actionFields(expectedRevision)) });
  }

  async answerDialog(chatId: string, requestId: string, value: string | boolean | null, expectedRevision: number): Promise<void> {
    await this.request(`/api/chats/${chatId}/dialog`, okResponseSchema, { method: "POST", body: JSON.stringify({ ...this.actionFields(expectedRevision), requestId, value }) });
  }
}

export function dialogValue(dialog: ExtensionDialog, value: string | boolean, cancelled: boolean): string | boolean | null {
  if (cancelled) return null;
  return dialog.kind === "confirm" ? Boolean(value) : String(value);
}
