import type { ExtensionDialog, ModelInfo, SessionSummary, TextItem, ToolItem } from "@pidex/api";

export type AdapterEvent =
  | { type: "message"; item: TextItem }
  | { type: "delta"; itemId: string; delta: string; channel: "text" | "thinking" }
  | { type: "tool"; item: ToolItem }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "settled" }
  | { type: "dialog"; dialog?: ExtensionDialog };

export interface AdapterSessionInfo extends SessionSummary { nativeId: string; nativePath?: string }
export interface AdapterWorkspaceInfo {
  models: ModelInfo[];
  sessions: AdapterSessionInfo[];
  trusted: boolean | null;
  protectedResourcesSkipped: boolean;
  commands: Array<{ name: string; description?: string }>;
}
export interface AdapterSession {
  readonly nativeId: string;
  readonly nativePath: string | undefined;
  readonly messages: TextItem[];
  readonly model: string | undefined;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly activeTools: string[];
  readonly sessionName: string | undefined;
  readonly isIdle: boolean;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue(kind?: "steering" | "follow-up" | "all"): void;
  configure(input: { model?: string; thinkingLevel?: AdapterSession["thinkingLevel"]; toolMode?: "read-only" | "full" }): Promise<void>;
  rename(name: string): void;
  compact(instructions?: string): Promise<void>;
  getStats(): { messages: number; toolCalls: number; tokens: number; cost: number };
  respondToDialog(requestId: string, value: string | boolean | null): void;
  dispose(): void;
}
export interface PiAdapter {
  readonly name: "fake" | "real";
  inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo>;
  createSession(cwd: string, toolMode: "read-only" | "full"): Promise<AdapterSession>;
  resumeSession(cwd: string, nativePath: string): Promise<AdapterSession>;
}
export function bounded(value: unknown, max = 12_000): { text: string; truncated: boolean } {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = "[unserializable output]"; }
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}\n… output truncated`, truncated: true };
}
