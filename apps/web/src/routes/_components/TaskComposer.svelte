<script lang="ts" module>
  import type { ChatSnapshot, Workspace } from "@pidex/api";
  import type { ConnectionState } from "./AppShellConnection";

  export const composerSurfaceClass =
    "relative mx-auto w-full max-w-transcript overflow-visible rounded-composer border border-border-strong bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-[border-color,box-shadow,background-color] duration-[160ms] focus-within:border-[color-mix(in_srgb,var(--primary)_78%,var(--border-strong))] focus-within:shadow-[0_16px_40px_-22px_rgb(24_24_27/55%),0_0_0_3px_color-mix(in_srgb,var(--primary)_9%,transparent)] dark:bg-[color-mix(in_srgb,var(--card)_92%,transparent)] dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:shadow-[inset_0_1px_rgb(255_255_255/3%),0_0_0_3px_color-mix(in_srgb,var(--primary)_11%,transparent)]";
  export const composerTextareaClass =
    "block min-h-16 max-h-52 w-full resize-none border-0 border-none bg-transparent px-4.5 pt-4 pb-2 text-ui leading-[1.5] text-foreground outline-none placeholder:text-faint max-[560px]:px-3.5 max-[560px]:pt-3.5 max-[560px]:pb-1.5 max-[560px]:text-base";
  export const composerFooterClass =
    "flex min-h-11.5 min-w-0 items-center justify-between gap-2.5 pt-0.5 pr-2.5 pb-2.5 pl-3 max-[560px]:min-h-12 max-[560px]:items-end max-[560px]:pr-1.75 max-[560px]:pb-1.75 max-[560px]:pl-2";
  export const composerControlsClass =
    "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[560px]:gap-0";
  export const composerSendButtonClass =
    "inline-grid size-8.5 flex-none place-items-center rounded-full border-0 border-none bg-primary text-primary-foreground shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_24%,transparent)] transition-[background-color,box-shadow,transform,opacity] duration-[140ms] hover:not-disabled:-translate-y-px hover:not-disabled:bg-primary-hover hover:not-disabled:shadow-[0_6px_16px_color-mix(in_srgb,var(--primary)_34%,transparent)] active:not-disabled:translate-y-0 max-[900px]:size-10 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";
  export type ComposerCommand = Workspace["commands"][number];

  export function composerCommands(commands: ComposerCommand[]): ComposerCommand[] {
    return [
      { name: "compact", description: "Manually compact the session context" },
      ...commands.filter((command) => command.name !== "compact"),
    ];
  }

  export function slashCommandSuggestions(
    draft: string,
    commands: ComposerCommand[],
  ): ComposerCommand[] {
    const slashMatch = /^\/([^\s]*)$/.exec(draft);
    if (!slashMatch) return [];
    const query = slashMatch[1].toLowerCase();
    if (!query) return commands;
    return commands
      .map((command) => ({ command, score: fuzzyCommandScore(query, command.name) }))
      .filter(
        (result): result is { command: ComposerCommand; score: number } =>
          result.score !== undefined,
      )
      .toSorted((left, right) => left.score - right.score)
      .map(({ command }) => command);
  }

  function fuzzyCommandScore(query: string, text: string): number | undefined {
    let score = 0;
    for (const token of query.split(/[\s/]+/).filter(Boolean)) {
      const tokenScore = fuzzyMatchScore(token, text);
      if (tokenScore === undefined) return undefined;
      score += tokenScore;
    }
    return score;
  }

  function fuzzyMatchScore(query: string, text: string): number | undefined {
    const primaryScore = fuzzyOrderedMatchScore(query.toLowerCase(), text.toLowerCase());
    if (primaryScore !== undefined) return primaryScore;
    const alphaNumericMatch = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(query);
    const numericAlphaMatch = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(query);
    const swappedQuery = alphaNumericMatch
      ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
      : numericAlphaMatch
        ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
        : undefined;
    if (!swappedQuery) return undefined;
    const swappedScore = fuzzyOrderedMatchScore(swappedQuery, text.toLowerCase());
    return swappedScore === undefined ? undefined : swappedScore + 5;
  }

  function fuzzyOrderedMatchScore(query: string, normalizedText: string): number | undefined {
    if (query.length > normalizedText.length) return undefined;
    let queryIndex = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    let score = 0;
    for (let index = 0; index < normalizedText.length && queryIndex < query.length; index += 1) {
      if (normalizedText[index] !== query[queryIndex]) continue;
      const wordBoundary = index === 0 || /[\s\-_./:]/.test(normalizedText[index - 1]);
      if (lastMatchIndex === index - 1) {
        consecutiveMatches += 1;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2;
      }
      if (wordBoundary) score -= 10;
      score += index * 0.1;
      lastMatchIndex = index;
      queryIndex += 1;
    }
    if (queryIndex < query.length) return undefined;
    return query === normalizedText ? score - 100 : score;
  }

  export function nextSlashCommand(
    commands: ComposerCommand[],
    current: ComposerCommand | undefined,
    direction: -1 | 1,
  ): ComposerCommand | undefined {
    if (commands.length === 0) return undefined;
    const currentIndex = current
      ? commands.findIndex((command) => command.name === current.name)
      : -1;
    if (currentIndex < 0) return commands[0];
    return commands[(currentIndex + direction + commands.length) % commands.length];
  }

  function parseCompactCommand(draft: string): { instructions?: string } | undefined {
    const match = /^\/compact(?:\s+(.*?))?\s*$/s.exec(draft);
    if (!match) return undefined;
    const instructions = match[1]?.trim();
    return instructions ? { instructions } : {};
  }

  /**
   * Cascades the composer's disabled-state reason into the textarea placeholder and the
   * send/stop button's aria-label + title. First match wins; the order encodes why each
   * reason outranks the ones below it:
   *
   * 1. disconnected/reconnecting — a connection failure invalidates everything downstream
   *    (you cannot acknowledge, configure, or send while disconnected), so it wins even
   *    while the stop button is showing (the stop button is itself disabled by the same
   *    connection check).
   * 2. requiresAcknowledgement — blocks every submission path and needs a user action, so
   *    it outranks the passive setup states below it.
   * 3. no models — sending can never work regardless of any transient pending state.
   * 4. creatingTask — the task's worktree does not exist yet; nothing else can be true
   *    until it is.
   * 5. configurationPending — a model/thinking-level change is being saved; a transient
   *    wait that can only happen once the task exists.
   * 6. compactPending — a context compaction is in flight; can coexist with `active`, and
   *    wins over it since it is the more specific, more recent reason.
   * 7. active — not an error at all; drafting the next message is allowed, so it only
   *    applies once nothing above blocks.
   * 8. default idle — healthy composer, ready to send (or empty draft, which intentionally
   *    gets no special-cased message: a disabled-but-labeled-"Send" button for an empty
   *    draft is expected UX).
   */
  export function composerAffordances(state: {
    active: boolean;
    compactPending: boolean;
    configurationPending: boolean;
    connection: ConnectionState;
    creatingTask: boolean;
    hasModels: boolean;
    requiresAcknowledgement: boolean;
  }): { placeholder: string; sendLabel: string } {
    if (state.connection !== "connected") {
      return {
        placeholder: "Draft locally while the host reconnects…",
        sendLabel: "Environment disconnected",
      };
    }
    if (state.requiresAcknowledgement) {
      const reason = "Acknowledge the interrupted run above to continue";
      return { placeholder: reason, sendLabel: reason };
    }
    if (!state.hasModels) {
      const reason = "Run pi and /login to enable models";
      return { placeholder: reason, sendLabel: reason };
    }
    if (state.creatingTask) {
      return { placeholder: "Preparing worktree…", sendLabel: "Preparing worktree" };
    }
    if (state.configurationPending) {
      return { placeholder: "Saving configuration…", sendLabel: "Saving configuration" };
    }
    if (state.compactPending) {
      return { placeholder: "Compacting session context…", sendLabel: "Compacting context" };
    }
    if (state.active) {
      return { placeholder: "Draft your next message…", sendLabel: "Stop" };
    }
    return { placeholder: "Ask Pi to work on this project…", sendLabel: "Send" };
  }

  export function runStatusLabel(status: ChatSnapshot["runStatus"]): string {
    switch (status) {
      case "running":
        return "Working";
      case "stopping":
        return "Stopping";
      case "compacting":
        return "Compacting context";
      default:
        return "Idle";
    }
  }

  export function queueSummary(steeringCount: number, followUpCount: number): string {
    const parts: string[] = [];
    if (steeringCount > 0) parts.push(`${steeringCount} steering`);
    if (followUpCount > 0) parts.push(`${followUpCount} follow-up`);
    return parts.length > 0 ? `${parts.join(" · ")} queued` : "";
  }

  export function formatRunElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  export async function submitComposerDraft(
    draft: string,
    actions: {
      compact: (instructions?: string) => Promise<boolean>;
      send: () => Promise<void>;
    },
  ): Promise<"compact" | "compact-failed" | "prompt"> {
    const command = parseCompactCommand(draft);
    if (!command) {
      await actions.send();
      return "prompt";
    }
    const compacted = await actions.compact(command.instructions);
    return compacted ? "compact" : "compact-failed";
  }
</script>

<script lang="ts">
  import type { ContextUsage } from "@pidex/api";
  import { tick } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { TaskConfigurationPatch, TaskStartMode } from "./AppShellContext.svelte";
  import ComposerModelControls from "./ComposerModelControls.svelte";
  import ContextUsageMeter from "./ContextUsageMeter.svelte";
  import Icon from "./Icon.svelte";

  let {
    active,
    clearQueue,
    commands,
    compact,
    compactPending,
    configure,
    configurationPending,
    connection,
    contextUsage,
    creatingTask,
    draft = $bindable(),
    followUpCount,
    models,
    persistDraft,
    projectName,
    requiresAcknowledgement,
    runStatus,
    selectedModel,
    selectedThinkingLevel,
    send,
    setStartMode,
    startMode,
    startModeEditable,
    steeringCount,
    stop,
    taskId,
  }: {
    active: boolean;
    clearQueue: () => Promise<void>;
    commands: Workspace["commands"];
    compact: (instructions?: string) => Promise<boolean>;
    compactPending: boolean;
    configure: (patch: TaskConfigurationPatch) => Promise<boolean>;
    configurationPending: boolean;
    connection: ConnectionState;
    contextUsage?: ContextUsage;
    creatingTask: boolean;
    draft: string;
    followUpCount: number;
    models: Workspace["models"];
    persistDraft: () => void;
    projectName: string;
    requiresAcknowledgement: boolean;
    runStatus: ChatSnapshot["runStatus"];
    selectedModel: string;
    selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    send: () => Promise<void>;
    setStartMode: (mode: TaskStartMode) => void;
    startMode: TaskStartMode;
    startModeEditable: boolean;
    steeringCount: number;
    stop: () => Promise<void>;
    /** Identifies the task whose run is being timed, so switching between two already-active tasks restarts the elapsed clock. */
    taskId: string;
  } = $props();

  let promptInput: HTMLTextAreaElement | undefined;
  let startMenuOpen = $state(false);
  let startModeLabel = $derived(startMode === "worktree" ? "New worktree" : "Work locally");
  let idleSubmissionDisabled = $derived(
    !draft.trim() ||
      !models.length ||
      connection !== "connected" ||
      requiresAcknowledgement ||
      creatingTask ||
      configurationPending ||
      compactPending,
  );
  let affordances = $derived(
    composerAffordances({
      active,
      compactPending,
      configurationPending,
      connection,
      creatingTask,
      hasModels: models.length > 0,
      requiresAcknowledgement,
    }),
  );
  const componentId = $props.id();
  const commandListId = `${componentId}-commands`;
  let commandCatalog = $derived(composerCommands(commands));
  let commandSuggestions = $derived(active ? [] : slashCommandSuggestions(draft, commandCatalog));
  let selectedCommandName = $state("");
  let selectedSuggestion = $derived(
    commandSuggestions.find((command) => command.name === selectedCommandName) ??
      commandSuggestions[0],
  );
  let runStartedAt = $state<number>();
  let runNow = $state(Date.now());
  let statusLabel = $derived(runStatusLabel(runStatus));
  let elapsedLabel = $derived(
    runStartedAt === undefined ? undefined : formatRunElapsed(runNow - runStartedAt),
  );
  let queueLabel = $derived(queueSummary(steeringCount, followUpCount));

  /**
   * Times the run in the client, the way `recordToolTiming` times tools: no start timestamp is on
   * the wire. Also depends on `taskId` so navigating directly between two already-active tasks
   * restarts the clock instead of carrying over the previous task's start time.
   */
  $effect(() => {
    void taskId;
    if (active) runStartedAt = Date.now();
    else runStartedAt = undefined;
  });

  $effect(() => {
    if (!active) return;
    const interval = window.setInterval(() => (runNow = Date.now()), 1_000);
    return () => window.clearInterval(interval);
  });

  export function focus() {
    promptInput?.focus();
  }

  export function resize() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 210)}px`;
  }

  const attachPromptInput: Attachment<HTMLTextAreaElement> = (element) => {
    promptInput = element;
    return () => {
      if (promptInput === element) promptInput = undefined;
    };
  };

  function draftInput() {
    persistDraft();
    resize();
  }

  function completeCommand(command: ComposerCommand) {
    draft = `/${command.name} `;
    selectedCommandName = "";
    persistDraft();
    resize();
    promptInput?.focus();
  }

  async function updateConfiguration(patch: TaskConfigurationPatch) {
    if (configurationPending || active || creatingTask || connection !== "connected") return;
    await configure(patch);
  }

  async function moveCommandSelection(direction: -1 | 1) {
    const nextCommand = nextSlashCommand(commandSuggestions, selectedSuggestion, direction);
    selectedCommandName = nextCommand?.name ?? "";
    if (!nextCommand) return;
    await tick();
    document
      .getElementById(`${commandListId}-${nextCommand.name}`)
      ?.scrollIntoView({ block: "nearest" });
  }

  async function submitDraft() {
    if (compactPending) return;
    const submittedDraft = draft;
    const result = await submitComposerDraft(submittedDraft, { compact, send });
    if (result !== "compact" || draft !== submittedDraft) return;
    draft = "";
    persistDraft();
    await tick();
    resize();
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (selectedSuggestion && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      void moveCommandSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      selectedSuggestion &&
      ((event.key === "Tab" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey) ||
        (event.key === "Enter" && !event.shiftKey && draft !== `/${selectedSuggestion.name}`))
    ) {
      event.preventDefault();
      completeCommand(selectedSuggestion);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 821px)").matches) {
      event.preventDefault();
      if (active || compactPending || idleSubmissionDisabled) return;
      void submitDraft();
    }
  }

  function dismissStartMenu(event: MouseEvent) {
    if (
      startMenuOpen &&
      event.target instanceof Element &&
      !event.target.closest("[data-start-menu]")
    )
      startMenuOpen = false;
  }

  function startMenuKeydown(event: KeyboardEvent) {
    if (startMenuOpen && event.key === "Escape") {
      startMenuOpen = false;
      promptInput?.focus();
    }
  }

  function chooseStartMode(mode: TaskStartMode) {
    setStartMode(mode);
    startMenuOpen = false;
  }
</script>

<svelte:window onclick={dismissStartMenu} onkeydown={startMenuKeydown} />

<footer
  class="relative z-7 flex-none bg-[linear-gradient(to_bottom,transparent_0,var(--background)_20px,var(--background)_100%)] px-5 pt-2.5 pb-[max(9px,env(safe-area-inset-bottom))] max-[900px]:px-2.5 max-[560px]:px-2 max-[560px]:pt-2 max-[560px]:pb-[max(7px,env(safe-area-inset-bottom))]"
>
  <div
    class={[
      "mx-auto flex w-full max-w-transcript min-h-6 items-center justify-between gap-2.5 px-2 pb-2 text-meta text-faint",
      !active && "invisible",
    ]}
  >
    <span class="flex items-center gap-1.5"
      ><span class="size-1.5 animate-pulse rounded-full bg-primary"
      ></span>{statusLabel}{#if elapsedLabel}{" "}for
        <span class="font-mono tabular-nums">{elapsedLabel}</span>{/if}{#if queueLabel}{" "}· {queueLabel}{/if}</span
    >
    {#if steeringCount + followUpCount > 0}<button
        class="border-0 bg-transparent p-0 text-meta text-primary-text"
        onclick={clearQueue}>Clear queues</button
      >{/if}
  </div>
  <div class={composerSurfaceClass} data-testid="chat-composer">
    {#if commandSuggestions.length > 0}
      <div
        class="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 max-h-64 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-popover"
        id={commandListId}
        role="listbox"
        aria-label="Commands"
      >
        {#each commandSuggestions as command (command.name)}
          <button
            class={[
              "flex w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left hover:bg-secondary",
              command === selectedSuggestion && "bg-secondary",
            ]}
            id={`${commandListId}-${command.name}`}
            type="button"
            role="option"
            aria-selected={command === selectedSuggestion}
            onclick={() => completeCommand(command)}
          >
            <span class="w-30 flex-none font-mono text-control font-medium text-primary-text"
              >/{command.name}</span
            >
            <span class="min-w-0 text-control text-muted"
              >{command.description ?? "Pi command"}</span
            >
          </button>
        {/each}
      </div>
    {/if}
    {#if startModeEditable || creatingTask}
      <div
        class="flex min-h-9 min-w-0 items-center gap-1 border-b border-border px-3 text-control text-muted"
        aria-label="Task workspace"
      >
        <span class="inline-flex min-w-0 flex-none items-center gap-1.5 px-1.5">
          <Icon name="folder" size={13} />
          <span class="max-w-40 overflow-hidden text-ellipsis whitespace-nowrap">{projectName}</span
          >
        </span>
        <span class="mx-1 h-3.5 w-px flex-none bg-border" aria-hidden="true"></span>
        <div class="relative flex-none" data-start-menu>
          <button
            class="inline-flex h-7 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-control font-medium text-muted enabled:hover:bg-secondary enabled:hover:text-foreground disabled:cursor-default disabled:opacity-70"
            onclick={() => (startMenuOpen = !startMenuOpen)}
            disabled={!startModeEditable || active || creatingTask}
            aria-label={`Start in ${startModeLabel}`}
            aria-haspopup="menu"
            aria-expanded={startMenuOpen}
            title={startModeEditable
              ? "Choose where to start this task"
              : `Started in ${startModeLabel}`}
          >
            <Icon name={startMode === "worktree" ? "folder-git" : "folder"} size={13} />
            {creatingTask ? "Creating worktree…" : startModeLabel}
            {#if startModeEditable}<Icon name="arrow-down" size={11} />{/if}
          </button>
          {#if startMenuOpen}
            <div
              class="absolute bottom-full left-0 z-20 mb-2 w-48 rounded-xl border border-border-strong bg-card p-1.5 text-foreground shadow-popover"
              role="menu"
              aria-label="Start in"
            >
              <p class="m-0 px-2 py-1.5 text-meta font-medium text-faint">Start in</p>
              <button
                class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-control text-muted hover:bg-secondary hover:text-foreground"
                role="menuitemradio"
                aria-checked={startMode === "local"}
                onclick={() => chooseStartMode("local")}
              >
                <Icon name="folder" size={14} />
                <span class="flex-1">Work locally</span>
                {#if startMode === "local"}<Icon name="check" size={13} />{/if}
              </button>
              <button
                class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-control text-muted hover:bg-secondary hover:text-foreground"
                role="menuitemradio"
                aria-checked={startMode === "worktree"}
                onclick={() => chooseStartMode("worktree")}
              >
                <Icon name="folder-git" size={14} />
                <span class="flex-1">New worktree</span>
                {#if startMode === "worktree"}<Icon name="check" size={13} />{/if}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
    <textarea
      class={composerTextareaClass}
      {@attach attachPromptInput}
      bind:value={draft}
      oninput={draftInput}
      onkeydown={keydown}
      rows="2"
      placeholder={affordances.placeholder}
      aria-autocomplete="list"
      aria-controls={commandSuggestions.length > 0 ? commandListId : undefined}
      aria-activedescendant={selectedSuggestion
        ? `${commandListId}-${selectedSuggestion.name}`
        : undefined}
      aria-expanded={commandSuggestions.length > 0}
      aria-haspopup="listbox"
      role="combobox"
      aria-label="Prompt"></textarea>
    <div class={composerFooterClass}>
      <div class={composerControlsClass}>
        <ComposerModelControls
          {models}
          {selectedModel}
          thinkingLevel={selectedThinkingLevel}
          modelDisabled={!models.length ||
            active ||
            creatingTask ||
            configurationPending ||
            connection !== "connected"}
          thinkingDisabled={active ||
            creatingTask ||
            configurationPending ||
            connection !== "connected"}
          onModel={(model) => void updateConfiguration({ model })}
          onThinking={(thinkingLevel) => void updateConfiguration({ thinkingLevel })}
        />
      </div>
      <div class="flex min-w-0 flex-none items-center gap-1">
        {#if contextUsage}<ContextUsageMeter usage={contextUsage} />{/if}
        {#if active}
          <button
            class="inline-grid size-8.5 place-items-center rounded-full border-0 bg-danger/15 text-danger hover:bg-danger/20 max-[900px]:size-9.5 disabled:opacity-40"
            onclick={stop}
            disabled={connection !== "connected"}
            aria-label={affordances.sendLabel}
            title={affordances.sendLabel}><Icon name="stop" /></button
          >
        {:else}
          <button
            class={composerSendButtonClass}
            onclick={submitDraft}
            disabled={idleSubmissionDisabled}
            aria-label={affordances.sendLabel}
            title={affordances.sendLabel}><Icon name="send" /></button
          >
        {/if}
      </div>
    </div>
  </div>
</footer>
