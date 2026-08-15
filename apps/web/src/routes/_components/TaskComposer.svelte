<script lang="ts" module>
  import type { Workspace } from "@pidex/api";

  export const composerSurfaceClass =
    "relative mx-auto w-full max-w-transcript overflow-visible rounded-composer border border-border-strong bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-[border-color,box-shadow,background-color] duration-[160ms] focus-within:border-[color-mix(in_srgb,var(--primary)_78%,var(--border-strong))] focus-within:shadow-[0_16px_40px_-22px_rgb(24_24_27/55%),0_0_0_3px_color-mix(in_srgb,var(--primary)_9%,transparent)] dark:bg-[color-mix(in_srgb,var(--card)_92%,transparent)] dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:shadow-[inset_0_1px_rgb(255_255_255/3%),0_0_0_3px_color-mix(in_srgb,var(--primary)_11%,transparent)]";
  export const composerTextareaClass =
    "block min-h-16 max-h-52 w-full resize-none border-0 border-none bg-transparent px-4.5 pt-4 pb-2 text-sm leading-[1.5] text-foreground outline-none placeholder:text-faint max-[560px]:min-h-18 max-[560px]:px-3.5 max-[560px]:pt-3.5 max-[560px]:pb-1.5 max-[560px]:text-base";
  export const composerFooterClass =
    "flex min-h-11.5 min-w-0 items-center justify-between gap-2.5 pt-0.5 pr-2.5 pb-2.5 pl-3 max-[560px]:min-h-12 max-[560px]:items-end max-[560px]:pr-1.75 max-[560px]:pb-1.75 max-[560px]:pl-2";
  export const composerControlsClass =
    "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[560px]:gap-0";
  export const composerSendButtonClass =
    "inline-grid size-8.5 flex-none place-items-center rounded-full border-0 border-none bg-primary text-primary-foreground shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_24%,transparent)] transition-[background-color,box-shadow,transform,opacity] duration-[140ms] hover:not-disabled:-translate-y-px hover:not-disabled:bg-primary-hover hover:not-disabled:shadow-[0_6px_16px_color-mix(in_srgb,var(--primary)_34%,transparent)] active:not-disabled:translate-y-0 max-[900px]:size-10 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none";
  export const composerSelectLabelClass =
    "flex h-7.5 min-w-0 flex-none items-center gap-1.5 overflow-hidden rounded-lg pl-2 text-muted transition-colors duration-[140ms] hover:bg-secondary hover:text-foreground focus-within:bg-secondary focus-within:text-foreground max-[560px]:h-9 max-[560px]:gap-1 max-[560px]:pl-1.5";
  export const composerSelectClass =
    "h-full max-w-44 min-w-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 border-none bg-transparent pr-5 text-control font-semibold text-inherit outline-none disabled:cursor-not-allowed disabled:opacity-42 max-[560px]:pr-3.5 max-[560px]:text-control [@supports(appearance:base-select)]:flex [@supports(appearance:base-select)]:items-center [@supports(appearance:base-select)]:gap-1.5 [@supports(appearance:base-select)]:pr-1.5 [@supports(appearance:base-select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:max-h-[min(22rem,calc(100dvh-2rem))] [@supports(appearance:base-select)]:[&::picker(select)]:overflow-y-auto [@supports(appearance:base-select)]:[&::picker(select)]:[position-area:block-start_span-inline-end] [@supports(appearance:base-select)]:[&::picker(select)]:[position-try-fallbacks:flip-block] [@supports(appearance:base-select)]:[&::picker(select)]:mb-2 [@supports(appearance:base-select)]:[&::picker(select)]:rounded-xl [@supports(appearance:base-select)]:[&::picker(select)]:border [@supports(appearance:base-select)]:[&::picker(select)]:border-border-strong [@supports(appearance:base-select)]:[&::picker(select)]:bg-card [@supports(appearance:base-select)]:[&::picker(select)]:p-1 [@supports(appearance:base-select)]:[&::picker(select)]:text-foreground [@supports(appearance:base-select)]:[&::picker(select)]:shadow-popover [@supports(appearance:base-select)]:[&::picker(select)]:[scrollbar-width:thin] [@supports(appearance:base-select)]:[&::picker-icon]:size-3 [@supports(appearance:base-select)]:[&::picker-icon]:ml-0.5 [@supports(appearance:base-select)]:[&::picker-icon]:text-faint [@supports(appearance:base-select)]:[&::picker-icon]:transition-[rotate] [@supports(appearance:base-select)]:[&::picker-icon]:duration-[140ms] [@supports(appearance:base-select)]:[&::picker-icon]:ease-[ease] [@supports(appearance:base-select)]:[&:open::picker-icon]:rotate-180 [@supports(appearance:base-select)]:[&_option]:flex [@supports(appearance:base-select)]:[&_option]:min-h-8 [@supports(appearance:base-select)]:[&_option]:items-center [@supports(appearance:base-select)]:[&_option]:rounded-lg [@supports(appearance:base-select)]:[&_option]:px-2 [@supports(appearance:base-select)]:[&_option]:py-[0.45rem] [@supports(appearance:base-select)]:[&_option]:text-xs [@supports(appearance:base-select)]:[&_option]:font-medium [@supports(appearance:base-select)]:[&_option]:text-muted [@supports(appearance:base-select)]:[&_option]:cursor-pointer [@supports(appearance:base-select)]:[&_option:hover]:bg-secondary [@supports(appearance:base-select)]:[&_option:hover]:text-foreground [@supports(appearance:base-select)]:[&_option:focus-visible]:bg-secondary [@supports(appearance:base-select)]:[&_option:focus-visible]:text-foreground [@supports(appearance:base-select)]:[&_option:checked]:bg-[color-mix(in_srgb,var(--primary)_12%,var(--secondary))] [@supports(appearance:base-select)]:[&_option:checked]:font-[650] [@supports(appearance:base-select)]:[&_option:checked]:text-foreground [@supports(appearance:base-select)]:[&_option::checkmark]:order-1 [@supports(appearance:base-select)]:[&_option::checkmark]:ml-auto [@supports(appearance:base-select)]:[&_option::checkmark]:text-primary-text";

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

  export function completeSlashCommand(command: ComposerCommand): string {
    return `/${command.name} `;
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

  export function parseCompactCommand(draft: string): { instructions?: string } | undefined {
    const match = /^\/compact(?:\s+(.*?))?\s*$/s.exec(draft);
    if (!match) return undefined;
    const instructions = match[1]?.trim();
    return instructions ? { instructions } : {};
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
  import type { ChatSnapshot, ContextUsage } from "@pidex/api";
  import { tick } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ConnectionState } from "./AppShellConnection";
  import type { TaskConfigurationPatch, TaskStartMode } from "./AppShellContext.svelte";
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
  const componentId = $props.id();
  const commandListId = `${componentId}-commands`;
  let commandCatalog = $derived(composerCommands(commands));
  let commandSuggestions = $derived(active ? [] : slashCommandSuggestions(draft, commandCatalog));
  let selectedCommandName = $state("");
  let selectedSuggestion = $derived(
    commandSuggestions.find((command) => command.name === selectedCommandName) ??
      commandSuggestions[0],
  );

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
    draft = completeSlashCommand(command);
    selectedCommandName = "";
    persistDraft();
    resize();
    promptInput?.focus();
  }

  async function updateConfiguration(patch: TaskConfigurationPatch) {
    if (configurationPending || active || creatingTask || connection !== "connected") return;
    await configure(patch);
  }

  function updateThinkingLevel(value: string) {
    if (
      value !== "off" &&
      value !== "minimal" &&
      value !== "low" &&
      value !== "medium" &&
      value !== "high" &&
      value !== "xhigh" &&
      value !== "max"
    )
      return;
    void updateConfiguration({ thinkingLevel: value });
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
  {#if active}
    <div
      class="mx-auto flex w-full max-w-transcript items-center justify-between gap-2.5 px-2 pb-2 text-meta text-faint"
    >
      <span class="flex items-center gap-1.5"
        ><span class="size-1.5 animate-pulse rounded-full bg-primary"></span>{runStatus} · {steeringCount}
        steer · {followUpCount} follow-up</span
      >
      {#if steeringCount + followUpCount > 0}<button
          class="border-0 bg-transparent p-0 text-meta text-primary-text"
          onclick={clearQueue}>Clear queues</button
        >{/if}
    </div>
  {/if}
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
            <span class="w-30 flex-none font-mono text-xs font-medium text-primary-text"
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
                class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-xs text-muted hover:bg-secondary hover:text-foreground"
                role="menuitemradio"
                aria-checked={startMode === "local"}
                onclick={() => chooseStartMode("local")}
              >
                <Icon name="folder" size={14} />
                <span class="flex-1">Work locally</span>
                {#if startMode === "local"}<Icon name="check" size={13} />{/if}
              </button>
              <button
                class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-xs text-muted hover:bg-secondary hover:text-foreground"
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
      placeholder={connection !== "connected"
        ? "Draft locally while the host reconnects…"
        : active
          ? "Draft your next message…"
          : "Ask Pi to work on this project…"}
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
        <label class={composerSelectLabelClass}>
          <select
            class={[
              composerSelectClass,
              "max-[560px]:w-36 max-[560px]:max-w-36 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-56",
            ]}
            aria-label="Model"
            value={selectedModel}
            onchange={(event) => void updateConfiguration({ model: event.currentTarget.value })}
            disabled={!models.length ||
              active ||
              creatingTask ||
              configurationPending ||
              connection !== "connected"}
          >
            {#each models as model (model.id)}<option value={model.id}>{model.name}</option>{/each}
          </select>
        </label>
        <span class="mx-0.5 h-4 w-px flex-none bg-border max-[560px]:mx-0" aria-hidden="true"
        ></span>
        <label class={composerSelectLabelClass}>
          <span
            class="grid w-4 flex-none place-items-center text-current max-[560px]:hidden"
            aria-hidden="true"><Icon name="activity" size={14} /></span
          >
          <select
            class={[
              composerSelectClass,
              "max-[560px]:max-w-27 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-36",
            ]}
            aria-label="Thinking level"
            value={selectedThinkingLevel}
            onchange={(event) => updateThinkingLevel(event.currentTarget.value)}
            disabled={active || creatingTask || configurationPending || connection !== "connected"}
          >
            <option value="off">Off</option><option value="minimal">Minimal</option><option
              value="low">Low</option
            ><option value="medium">Medium</option><option value="high">High</option><option
              value="xhigh">Extra high</option
            ><option value="max">Max</option>
          </select>
        </label>
      </div>
      <div class="flex min-w-0 flex-none items-center gap-1">
        {#if contextUsage}<ContextUsageMeter usage={contextUsage} />{/if}
        {#if active}
          <button
            class="inline-grid size-8.5 place-items-center rounded-full border-0 bg-danger/15 text-danger hover:bg-danger/20 max-[900px]:size-9.5 disabled:opacity-40"
            onclick={stop}
            disabled={connection !== "connected"}
            aria-label="Stop"><Icon name="stop" /></button
          >
        {:else}
          <button
            class={composerSendButtonClass}
            onclick={submitDraft}
            disabled={idleSubmissionDisabled}
            aria-label="Send"><Icon name="send" /></button
          >
        {/if}
      </div>
    </div>
  </div>
</footer>
