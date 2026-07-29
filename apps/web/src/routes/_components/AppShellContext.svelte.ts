import { createContext } from "svelte";
import type { Bootstrap, ChatSnapshot, ToolItem, Workspace } from "@pidex/api";
import type { ConnectionState } from "./AppShellConnection";

export type TaskDelivery = "follow-up" | "steer";
export type TaskStartMode = "local" | "worktree";

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
    readonly creatingTask: boolean;
    readonly delivery: TaskDelivery;
    readonly draft: string;
    readonly hasConfigurationDraft: boolean;
    readonly loadingEarlier: boolean;
    readonly selectedModel: string;
    readonly selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    readonly snapshot: ChatSnapshot | undefined;
    readonly startMode: TaskStartMode;
    readonly startModeEditable: boolean;
    readonly toolElapsedNow: number;
    readonly toolOutputs: Readonly<Record<string, TaskToolOutput>>;
    readonly toolTimings: Readonly<Record<string, TaskToolTiming>>;
  };
  readonly taskActions: {
    attachComposer(controller: TaskComposerController | undefined): void;
    attachTranscript(controller: TaskTranscriptController | undefined): void;
    clearQueue(): Promise<void>;
    compact(instructions?: string): Promise<boolean>;
    loadEarlier(): Promise<void>;
    loadToolOutput(item: ToolItem): Promise<void>;
    persistDraft(): void;
    send(): Promise<void>;
    setDelivery(delivery: TaskDelivery): void;
    setDraft(draft: string): void;
    setStartMode(mode: TaskStartMode): void;
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

export function createTaskViewControllerRegistry(
  scheduleTask: (callback: () => void) => void = scheduleOnNextFrame,
): TaskViewControllerRegistry {
  let composer: TaskComposerController | undefined;
  let composerFocusPending = false;
  let transcript: TaskTranscriptController | undefined;

  return {
    attachComposer: (controller) => {
      composer = controller;
      if (!controller || !composerFocusPending) return;
      composerFocusPending = false;
      scheduleTask(() => {
        if (composer === controller) controller.focus();
      });
    },
    attachTranscript: (controller) => (transcript = controller),
    dispose: () => {
      composer = undefined;
      composerFocusPending = false;
      transcript = undefined;
    },
    focusComposer: () => {
      if (composer) composer.focus();
      else composerFocusPending = true;
    },
    resizeComposer: () => composer?.resize(),
    scrollIfNearBottom: () => transcript?.scrollIfNearBottom(),
    scrollLatest: () => transcript?.scrollLatest(),
  };
}

function scheduleOnNextFrame(callback: () => void) {
  requestAnimationFrame(callback);
}
