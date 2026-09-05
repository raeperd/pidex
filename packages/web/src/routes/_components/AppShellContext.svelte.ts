import { createContext } from "svelte";
import type { Bootstrap, ChatSnapshot, ToolItem, Workspace } from "@pidex/api";
import type { ConnectionState } from "./AppShellConnection";

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

export interface AppShellContext {
  readonly shell: {
    readonly bootstrap: Bootstrap | undefined;
    readonly bootstrapError: string;
    readonly connection: ConnectionState;
    readonly retryingConnection: boolean;
    readonly routeReady: boolean;
    readonly routeLoading: boolean;
    readonly workspace: Workspace | undefined;
  };
  readonly task: {
    readonly compactPending: boolean;
    readonly configurationPending: boolean;
    readonly creatingTask: boolean;
    readonly draft: string;
    readonly loadingEarlier: boolean;
    readonly snapshot: ChatSnapshot | undefined;
    readonly startMode: TaskStartMode;
    readonly startModeEditable: boolean;
    readonly toolElapsedNow: number;
    readonly toolOutputs: Readonly<Record<string, TaskToolOutput>>;
    readonly toolTimings: Readonly<Record<string, TaskToolTiming>>;
  };
  readonly taskActions: {
    attachComposer(controller: TaskComposerController | undefined): void;
    clearQueue(): Promise<void>;
    compact(instructions?: string): Promise<boolean>;
    configure(patch: TaskConfigurationPatch): Promise<boolean>;
    loadEarlier(): Promise<void>;
    loadToolOutput(item: ToolItem): Promise<void>;
    persistDraft(): void;
    send(): Promise<void>;
    start(draft: string, configuration: TaskConfigurationPatch): Promise<void>;
    setDraft(draft: string): void;
    setStartMode(mode: TaskStartMode): void;
    stop(): Promise<void>;
  };
  readonly projectActions: {
    openProjectPicker(): void;
    retryConnection(): Promise<void>;
  };
}

const [getAppShellContext, provideAppShellContext] = createContext<AppShellContext>();

export { getAppShellContext, provideAppShellContext };

export function createTaskViewControllerRegistry(
  scheduleTask: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
): {
  attachComposer(controller: TaskComposerController | undefined): void;
  dispose(): void;
  focusComposer(): void;
  resizeComposer(): void;
} {
  let composer: TaskComposerController | undefined;
  let composerFocusPending = false;

  return {
    attachComposer: (controller) => {
      composer = controller;
      if (!controller || !composerFocusPending) return;
      composerFocusPending = false;
      scheduleTask(() => {
        if (composer === controller) controller.focus();
      });
    },
    dispose: () => {
      composer = undefined;
      composerFocusPending = false;
    },
    focusComposer: () => {
      if (composer) composer.focus();
      else composerFocusPending = true;
    },
    resizeComposer: () => composer?.resize(),
  };
}
