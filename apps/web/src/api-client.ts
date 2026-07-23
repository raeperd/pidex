import {
  acceptedResponseSchema,
  apiErrorSchema,
  bootstrapSchema,
  chatSnapshotSchema,
  okResponseSchema,
  sessionsResponseSchema,
  workspaceSchema,
  type Bootstrap,
  type ChatSnapshot,
  type ExtensionDialog,
  type SessionSummary,
  type Workspace,
} from "@pidex/api";
import type { ZodType } from "zod";

type Delivery = "normal" | "steer" | "follow-up";
type ChatConfiguration = Partial<Pick<ChatSnapshot, "model" | "thinkingLevel" | "toolMode">>;

export class PidexApiClient {
  private csrfToken = "";

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

  async sendMessage(chatId: string, text: string, delivery: Delivery): Promise<void> {
    await this.request(`/api/chats/${chatId}/messages`, acceptedResponseSchema, { method: "POST", body: JSON.stringify({ text, delivery }) });
  }

  async abort(chatId: string): Promise<void> {
    await this.request(`/api/chats/${chatId}/abort`, acceptedResponseSchema, { method: "POST", body: "{}" });
  }

  async clearQueue(chatId: string): Promise<void> {
    await this.request(`/api/chats/${chatId}/queue`, okResponseSchema, { method: "DELETE", body: "{}" });
  }

  configure(chatId: string, patch: ChatConfiguration): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/config`, chatSnapshotSchema, { method: "PATCH", body: JSON.stringify(patch) });
  }

  rename(chatId: string, name: string): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/rename`, chatSnapshotSchema, { method: "POST", body: JSON.stringify({ name }) });
  }

  compact(chatId: string): Promise<ChatSnapshot> {
    return this.request(`/api/chats/${chatId}/compact`, chatSnapshotSchema, { method: "POST", body: "{}" });
  }

  async answerDialog(chatId: string, requestId: string, value: string | boolean | null): Promise<void> {
    await this.request(`/api/chats/${chatId}/dialog`, okResponseSchema, { method: "POST", body: JSON.stringify({ requestId, value }) });
  }
}

export function dialogValue(dialog: ExtensionDialog, value: string | boolean, cancelled: boolean): string | boolean | null {
  if (cancelled) return null;
  return dialog.kind === "confirm" ? Boolean(value) : String(value);
}
