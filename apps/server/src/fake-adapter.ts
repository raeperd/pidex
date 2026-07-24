import { randomUUID } from "node:crypto";
import type { TextItem } from "@pidex/api";
import type {
  AdapterEvent,
  AdapterSession,
  AdapterSessionInfo,
  AdapterWorkspaceInfo,
  PiAdapter,
} from "./adapter.js";

const saved = new Map<string, AdapterSessionInfo[]>();
const transcripts = new Map<string, TextItem[]>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const taskSeeds = [
  "Audit the project architecture",
  "Improve the responsive navigation",
  "Fix the failing integration tests",
  "Review dependency boundaries",
  "Polish loading and empty states",
  "Add durable error recovery",
  "Simplify the deployment workflow",
  "Document the local development setup",
  "Investigate slow startup performance",
  "Refactor the API client",
  "Validate keyboard accessibility",
  "Prepare the next release",
];

function seedSessions(cwd: string) {
  const requested = Number(process.env.PIDEX_FAKE_SEED_SESSIONS ?? "0");
  const count = Number.isInteger(requested) ? Math.max(0, Math.min(requested, 50)) : 0;
  if (!count || saved.has(cwd)) return;
  const now = Date.now();
  saved.set(
    cwd,
    Array.from({ length: count }, (_, index) => {
      const nativeId = randomUUID().replaceAll("-", "");
      const title = taskSeeds[index % taskSeeds.length]!;
      return {
        id: nativeId,
        nativeId,
        nativePath: `fake://${nativeId}`,
        ...(index % 3 === 0 ? { name: title } : {}),
        firstMessage: title,
        createdAt: new Date(now - (index + 1) * 86_400_000).toISOString(),
        modifiedAt: new Date(now - index * 3_600_000).toISOString(),
        messageCount: 2 + index * 2,
      };
    }),
  );
}

class FakeSession implements AdapterSession {
  readonly nativeId: string;
  readonly nativePath: string;
  messages: TextItem[];
  model = "fake/deterministic";
  thinkingLevel: AdapterSession["thinkingLevel"] = "medium";
  activeTools = ["read", "grep", "find", "ls"];
  sessionName: string | undefined;
  isIdle = true;
  private listeners = new Set<(event: AdapterEvent) => void>();
  private stopped = false;
  private steering: string[] = [];
  private followUps: string[] = [];
  private dialogResolve: ((value: string | boolean | null) => void) | undefined;
  constructor(
    private readonly cwd: string,
    info?: AdapterSessionInfo,
  ) {
    this.nativeId = info?.nativeId ?? randomUUID().replaceAll("-", "");
    this.nativePath = `fake://${this.nativeId}`;
    this.messages = [...(transcripts.get(this.nativeId) ?? [])];
    this.sessionName = info?.name;
    if (!info) {
      const record: AdapterSessionInfo = {
        id: this.nativeId,
        nativeId: this.nativeId,
        nativePath: this.nativePath,
        firstMessage: "New session",
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
      };
      saved.set(cwd, [record, ...(saved.get(cwd) ?? [])]);
    }
  }
  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: AdapterEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async prompt(text: string): Promise<void> {
    if (!this.isIdle) throw new Error("A run is already active");
    this.isIdle = false;
    this.stopped = false;
    const now = Date.now();
    const user: TextItem = {
      type: "user",
      id: `u-${now}`,
      text,
      complete: true,
      timestamp: new Date(now).toISOString(),
    };
    this.messages.push(user);
    this.emit({ type: "message", item: user });
    if (text === "DIALOG") {
      const id = randomUUID().replaceAll("-", "");
      const answer = await new Promise<string | boolean | null>((resolve) => {
        this.dialogResolve = resolve;
        this.emit({
          type: "dialog",
          dialog: {
            id,
            kind: "confirm",
            title: "Extension confirmation",
            message: "Continue the deterministic extension?",
          },
        });
      });
      this.dialogResolve = undefined;
      this.emit({ type: "dialog" });
      this.emit({
        type: "notice",
        level: answer === true ? "info" : "warning",
        text: answer === true ? "Extension confirmed." : "Extension cancelled safely.",
      });
    }
    if (text === "RETRY")
      this.emit({
        type: "notice",
        level: "warning",
        text: "Retry 1/2: deterministic transient failure",
      });
    const assistant: TextItem = {
      type: "assistant",
      id: `a-${now}`,
      text: "",
      thinking: "",
      complete: false,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(assistant);
    this.emit({ type: "message", item: { ...assistant } });
    const chunks = text.startsWith("MARKDOWN:")
      ? [text.slice("MARKDOWN:".length)]
      : text === "stop this"
        ? Array.from({ length: 20 }, () => "working ")
        : [
            "I’ll inspect the project safely. ",
            "The deterministic Pi adapter is streaming this response. ",
          ];
    for (const chunk of chunks) {
      if (this.stopped) break;
      await delay(80);
      assistant.thinking = `${assistant.thinking ?? ""}checking `;
      this.emit({ type: "delta", itemId: assistant.id, delta: "checking ", channel: "thinking" });
      await delay(80);
      assistant.text += chunk;
      this.emit({ type: "delta", itemId: assistant.id, delta: chunk, channel: "text" });
    }
    if (!this.stopped) {
      const tool = {
        type: "tool" as const,
        id: `tool-${now}`,
        name: "read",
        argumentSummary: "README.md",
        state: "running" as const,
        preview: "",
        truncated: false,
      };
      this.emit({ type: "tool", item: tool });
      await delay(100);
      const fullOutput =
        text === "LARGE_TOOL"
          ? `${"bounded tool output line\n".repeat(1_200)}end of complete output`
          : "# Pidex\nLocal Pi dashboard";
      const truncated = fullOutput.length > 12_000;
      this.emit({
        type: "tool",
        item: {
          ...tool,
          state: "success",
          preview: truncated ? `${fullOutput.slice(0, 12_000)}\n… output truncated` : fullOutput,
          truncated,
        },
        output: { text: fullOutput, sourceTruncated: false },
      });
      assistant.text += "Ready for the next instruction.";
      this.emit({
        type: "delta",
        itemId: assistant.id,
        delta: "Ready for the next instruction.",
        channel: "text",
      });
    } else {
      assistant.text += "Stopped.";
      this.emit({ type: "delta", itemId: assistant.id, delta: "Stopped.", channel: "text" });
    }
    assistant.complete = true;
    this.emit({ type: "message", item: { ...assistant } });
    transcripts.set(this.nativeId, [...this.messages]);
    const record = saved.get(this.cwd)?.find((entry) => entry.nativeId === this.nativeId);
    if (record) {
      record.firstMessage =
        this.messages.find((m) => m.type === "user")?.text.slice(0, 500) ?? "New session";
      record.messageCount = this.messages.length;
      record.modifiedAt = new Date().toISOString();
    }
    this.steering = [];
    this.followUps = [];
    this.isIdle = true;
    this.emit({ type: "queue", steering: [], followUp: [] });
    this.emit({ type: "settled" });
  }
  async steer(text: string) {
    if (this.isIdle) throw new Error("Steer is only available during a run");
    this.steering.push(text);
    this.emit({ type: "queue", steering: [...this.steering], followUp: [...this.followUps] });
  }
  async followUp(text: string) {
    if (this.isIdle) throw new Error("Follow-up is only available during a run");
    this.followUps.push(text);
    this.emit({ type: "queue", steering: [...this.steering], followUp: [...this.followUps] });
  }
  async abort() {
    this.stopped = true;
    this.clearQueue();
  }
  clearQueue(kind: "steering" | "follow-up" | "all" = "all") {
    if (kind !== "follow-up") this.steering = [];
    if (kind !== "steering") this.followUps = [];
    this.emit({ type: "queue", steering: [...this.steering], followUp: [...this.followUps] });
  }
  async configure(input: {
    model?: string;
    thinkingLevel?: AdapterSession["thinkingLevel"];
    toolMode?: "read-only" | "full";
  }) {
    if (!this.isIdle) throw new Error("Configuration can only change while idle");
    if (input.model) this.model = input.model;
    if (input.thinkingLevel) this.thinkingLevel = input.thinkingLevel;
    if (input.toolMode)
      this.activeTools =
        input.toolMode === "read-only"
          ? ["read", "grep", "find", "ls"]
          : ["read", "bash", "edit", "write", "grep", "find", "ls"];
  }
  rename(name: string) {
    this.sessionName = name;
    const record = saved.get(this.cwd)?.find((entry) => entry.nativeId === this.nativeId);
    if (record) record.name = name;
  }
  async compact() {
    if (!this.isIdle) throw new Error("Compact is only available while idle");
    this.emit({
      type: "notice",
      level: "info",
      text: "Session compacted by deterministic adapter.",
    });
  }
  getStats() {
    return {
      messages: this.messages.length,
      toolCalls: Math.floor(this.messages.length / 2),
      tokens: this.messages.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0),
      cost: 0,
    };
  }
  respondToDialog(_requestId: string, value: string | boolean | null) {
    if (!this.dialogResolve) throw new Error("No extension dialog is pending");
    this.dialogResolve(value);
  }
  dispose() {
    this.stopped = true;
    this.dialogResolve?.(null);
    this.dialogResolve = undefined;
    this.listeners.clear();
  }
}

export class FakePiAdapter implements PiAdapter {
  readonly name = "fake" as const;
  async inspectWorkspace(cwd: string): Promise<AdapterWorkspaceInfo> {
    seedSessions(cwd);
    return {
      models: [
        {
          id: "fake/deterministic",
          provider: "fake",
          name: "Deterministic (no model spend)",
          reasoning: true,
        },
      ],
      sessions: [...(saved.get(cwd) ?? [])],
      trusted: true,
      protectedResourcesSkipped: false,
      resourceDiagnostics: [],
      commands: [{ name: "review", description: "Fake prompt template" }],
    };
  }
  async createSession(cwd: string) {
    return new FakeSession(cwd);
  }
  async resumeSession(cwd: string, nativePath: string) {
    const id = nativePath.replace("fake://", "");
    const info = saved.get(cwd)?.find((entry) => entry.nativeId === id);
    if (!info) throw new Error("Session no longer exists");
    return new FakeSession(cwd, info);
  }
  async setWorkspaceTrust() {}
}
