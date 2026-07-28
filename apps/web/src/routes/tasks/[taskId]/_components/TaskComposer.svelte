<script lang="ts" module>
  import type { Workspace } from "@pidex/api";

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
    const match = /^\/([^\s]*)$/.exec(draft);
    if (!match) return [];
    const query = match[1].toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().startsWith(query));
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
  import type { ConnectionState } from "../../../_components/AppShellConnection";
  import type {
    TaskConfigurationPatch,
    TaskDelivery,
  } from "../../../_components/AppShellContext.svelte";
  import ContextUsageMeter from "./ContextUsageMeter.svelte";
  import Icon from "../../../_components/Icon.svelte";

  let {
    active,
    clearQueue,
    commands,
    compact,
    connection,
    contextUsage,
    delivery = $bindable(),
    draft = $bindable(),
    followUpCount,
    hasConfigurationDraft,
    models,
    openCompact,
    persistDraft,
    requiresAcknowledgement,
    runStatus,
    selectedModel,
    selectedThinkingLevel,
    send,
    stageConfiguration,
    stats,
    steeringCount,
    stop,
    taskId,
  }: {
    active: boolean;
    clearQueue: () => Promise<void>;
    commands: Workspace["commands"];
    compact: (instructions?: string) => Promise<boolean>;
    connection: ConnectionState;
    contextUsage?: ContextUsage;
    delivery: TaskDelivery;
    draft: string;
    followUpCount: number;
    hasConfigurationDraft: boolean;
    models: Workspace["models"];
    openCompact: () => void;
    persistDraft: () => void;
    requiresAcknowledgement: boolean;
    runStatus: ChatSnapshot["runStatus"];
    selectedModel: string;
    selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    send: () => Promise<void>;
    stageConfiguration: (patch: TaskConfigurationPatch) => void;
    stats: ChatSnapshot["stats"];
    steeringCount: number;
    stop: () => Promise<void>;
    taskId: string;
  } = $props();

  let promptInput = $state<HTMLTextAreaElement>();
  let compactPendingByTask = $state<Record<string, boolean>>({});
  let compactPending = $derived(compactPendingByTask[taskId] ?? false);
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
    const submittedTaskId = taskId;
    const isCompaction = parseCompactCommand(submittedDraft) !== undefined;
    if (isCompaction) compactPendingByTask[submittedTaskId] = true;
    try {
      const result = await submitComposerDraft(submittedDraft, { compact, send });
      if (result !== "compact" || draft !== submittedDraft) return;
      draft = "";
      persistDraft();
      await tick();
      resize();
    } finally {
      if (isCompaction) delete compactPendingByTask[submittedTaskId];
    }
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
      if (compactPending) return;
      void (active ? send() : submitDraft());
    }
  }
</script>

<footer
  class="relative z-7 flex-none bg-[linear-gradient(to_bottom,transparent_0,var(--background)_20px,var(--background)_100%)] px-5 pt-2.5 pb-[max(9px,env(safe-area-inset-bottom))] max-[900px]:px-2.5 max-[560px]:px-2 max-[560px]:pt-2 max-[560px]:pb-[max(7px,env(safe-area-inset-bottom))]"
>
  {#if active}
    <div
      class="mx-auto flex w-full max-w-3xl items-center justify-between gap-2.5 px-2 pb-2 text-[10.5px] text-faint"
    >
      <span class="flex items-center gap-1.5"
        ><span class="size-1.5 animate-pulse rounded-full bg-primary"></span>{runStatus} · {steeringCount}
        steer · {followUpCount} follow-up</span
      >
      {#if steeringCount + followUpCount > 0}<button
          class="border-0 bg-transparent p-0 text-[10.5px] text-primary"
          onclick={clearQueue}>Clear queues</button
        >{/if}
    </div>
  {/if}
  <div class="chat-composer relative mx-auto" data-testid="chat-composer">
    {#if commandSuggestions.length > 0}
      <div
        class="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 max-h-64 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-[0_18px_48px_rgb(0_0_0/24%)]"
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
            <span class="w-30 flex-none font-mono text-xs font-medium text-primary"
              >/{command.name}</span
            >
            <span class="min-w-0 text-[11px] text-muted">{command.description ?? "Pi command"}</span
            >
          </button>
        {/each}
      </div>
    {/if}
    <textarea
      class="chat-composer__input"
      bind:this={promptInput}
      bind:value={draft}
      oninput={draftInput}
      onkeydown={keydown}
      rows="2"
      placeholder={connection !== "connected"
        ? "Draft locally while the host reconnects…"
        : active
          ? "Add guidance while Pi works…"
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
    <div class="chat-composer__toolbar">
      <div class="chat-composer__controls">
        <label class="chat-composer__control">
          <select
            class="chat-composer__select"
            aria-label="Model"
            value={selectedModel}
            onchange={(event) => stageConfiguration({ model: event.currentTarget.value })}
            disabled={!models.length}
          >
            {#each models as model (model.id)}<option value={model.id}>{model.name}</option>{/each}
          </select>
        </label>
        <span class="chat-composer__divider" aria-hidden="true"></span>
        <label class="chat-composer__control">
          <span class="chat-composer__control-icon" aria-hidden="true"
            ><Icon name="activity" size={14} /></span
          >
          <select
            class="chat-composer__select"
            aria-label="Thinking level"
            value={selectedThinkingLevel}
            onchange={(event) =>
              stageConfiguration({
                thinkingLevel: event.currentTarget.value as ChatSnapshot["thinkingLevel"],
              })}
          >
            <option value="off">Off</option><option value="minimal">Minimal</option><option
              value="low">Low</option
            ><option value="medium">Medium</option><option value="high">High</option><option
              value="xhigh">Extra high</option
            ><option value="max">Max</option>
          </select>
        </label>
        {#if hasConfigurationDraft}<span class="chat-composer__next-turn">Next turn</span>{/if}
      </div>
      <div class="flex min-w-0 flex-none items-center gap-1">
        {#if contextUsage}<ContextUsageMeter
            usage={contextUsage}
            onclick={openCompact}
            disabled={active}
          />{/if}
        {#if active}
          <select
            class="h-7 max-w-20 flex-none rounded-lg border-0 bg-transparent pr-4 pl-2 text-[10.5px] font-medium text-muted outline-none hover:bg-secondary hover:text-foreground"
            bind:value={delivery}
            aria-label="Delivery mode"
            ><option value="steer">Steer</option><option value="follow-up">Follow-up</option
            ></select
          >
          <button
            class="inline-grid size-8.5 place-items-center rounded-full border-0 bg-danger/15 text-danger hover:bg-danger/20 disabled:opacity-40"
            onclick={stop}
            disabled={connection !== "connected"}
            aria-label="Stop"><Icon name="stop" /></button
          >
          <button
            class="inline-grid h-8.5 place-items-center rounded-lg border-0 bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
            onclick={send}
            disabled={!draft.trim() || connection !== "connected" || compactPending}
            aria-label="Queue">Queue</button
          >
        {:else}
          <button
            class="chat-composer__send"
            onclick={submitDraft}
            disabled={!draft.trim() ||
              !models.length ||
              connection !== "connected" ||
              requiresAcknowledgement ||
              compactPending}
            aria-label="Send"><Icon name="send" /></button
          >
        {/if}
      </div>
    </div>
  </div>
  <div
    class="mx-auto w-full max-w-3xl px-2 pt-1.5 font-mono text-[9.5px] leading-tight text-faint max-[560px]:pt-1 max-[560px]:text-[8.5px]"
  >
    <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
      >{stats.messages} messages · {stats.tokens.toLocaleString()} tokens · ${stats.cost.toFixed(
        4,
      )}</span
    >
  </div>
</footer>
