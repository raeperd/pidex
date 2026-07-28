import { createContext } from "svelte";
import type { Bootstrap, ChatSnapshot, ToolItem, Workspace } from "@pidex/api";
import type { ConnectionState } from "./AppShellConnection";

export type TaskDelivery = "follow-up" | "steer";

export interface TaskConfigurationPatch {
  model?: string;
  thinkingLevel?: ChatSnapshot["thinkingLevel"];
}

export interface TaskToolOutput {
  text: string;
  nextOffset: number;
  total: number;
  complete: boolean;
  loading: boolean;
  sourceTruncated: boolean;
  error?: string;
}

export interface TaskToolTiming {
  startedAt: number;
  endedAt?: number;
}

export interface TaskComposerController {
  focus(): void;
  resize(): void;
}

export interface TaskTranscriptController {
  scrollIfNearBottom(): void;
  scrollLatest(): void;
}

export interface AppShellContext {
  readonly shell: {
    readonly bootstrap: Bootstrap | undefined;
    readonly bootstrapError: string;
    readonly connection: ConnectionState;
    readonly retryingConnection: boolean;
    readonly routeLoading: boolean;
    readonly workspace: Workspace | undefined;
  };
  readonly task: {
    readonly active: boolean;
    readonly delivery: TaskDelivery;
    readonly draft: string;
    readonly hasConfigurationDraft: boolean;
    readonly loadingEarlier: boolean;
    readonly selectedModel: string;
    readonly selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    readonly snapshot: ChatSnapshot | undefined;
    readonly toolElapsedNow: number;
    readonly toolOutputs: Readonly<Record<string, TaskToolOutput>>;
    readonly toolTimings: Readonly<Record<string, TaskToolTiming>>;
  };
  readonly taskActions: {
    attachComposer(controller: TaskComposerController | undefined): void;
    attachTranscript(controller: TaskTranscriptController | undefined): void;
    clearQueue(): Promise<void>;
    loadEarlier(): Promise<void>;
    loadToolOutput(item: ToolItem): Promise<void>;
    persistDraft(): void;
    send(): Promise<void>;
    setDelivery(delivery: TaskDelivery): void;
    setDraft(draft: string): void;
    stageConfiguration(patch: TaskConfigurationPatch): void;
    stop(): Promise<void>;
  };
  readonly projectActions: {
    openProjectPicker(): void;
    retryConnection(): Promise<void>;
  };
}

export interface TaskViewControllerRegistry {
  attachComposer(controller: TaskComposerController | undefined): void;
  attachTranscript(controller: TaskTranscriptController | undefined): void;
  dispose(): void;
  focusComposer(): void;
  resizeComposer(): void;
  scrollIfNearBottom(): void;
  scrollLatest(): void;
}

const [getAppShellContext, provideAppShellContext] = createContext<AppShellContext>();

export { getAppShellContext, provideAppShellContext };

export function createTaskViewControllerRegistry(): TaskViewControllerRegistry {
  let composer: TaskComposerController | undefined;
  let transcript: TaskTranscriptController | undefined;

  return {
    attachComposer: (controller) => (composer = controller),
    attachTranscript: (controller) => (transcript = controller),
    dispose: () => {
      composer = undefined;
      transcript = undefined;
    },
    focusComposer: () => composer?.focus(),
    resizeComposer: () => composer?.resize(),
    scrollIfNearBottom: () => transcript?.scrollIfNearBottom(),
    scrollLatest: () => transcript?.scrollLatest(),
  };
}
