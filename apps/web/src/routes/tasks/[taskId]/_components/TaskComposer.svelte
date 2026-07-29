<script lang="ts">
  import type { ChatSnapshot, ContextUsage, Workspace } from "@pidex/api";
  import type { ConnectionState } from "../../../_components/AppShellConnection";
  import type {
    TaskConfigurationPatch,
    TaskDelivery,
    TaskStartMode,
  } from "../../../_components/AppShellContext.svelte";
  import ContextUsageMeter from "./ContextUsageMeter.svelte";
  import Icon from "../../../_components/Icon.svelte";

  const composerSelectClass =
    "h-full max-w-44 min-w-0 cursor-pointer border-0 border-none bg-transparent pr-5 text-[11px] font-semibold text-inherit outline-none disabled:cursor-not-allowed disabled:opacity-42 max-[560px]:max-w-27 max-[560px]:pr-3.5 max-[560px]:text-[10px] [@supports(appearance:base-select)]:flex [@supports(appearance:base-select)]:items-center [@supports(appearance:base-select)]:gap-1.5 [@supports(appearance:base-select)]:pr-1.5 [@supports(appearance:base-select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:max-h-[min(22rem,calc(100dvh-2rem))] [@supports(appearance:base-select)]:[&::picker(select)]:overflow-y-auto [@supports(appearance:base-select)]:[&::picker(select)]:[position-area:block-start_span-inline-end] [@supports(appearance:base-select)]:[&::picker(select)]:[position-try-fallbacks:flip-block] [@supports(appearance:base-select)]:[&::picker(select)]:mb-2 [@supports(appearance:base-select)]:[&::picker(select)]:rounded-xl [@supports(appearance:base-select)]:[&::picker(select)]:border [@supports(appearance:base-select)]:[&::picker(select)]:border-border-strong [@supports(appearance:base-select)]:[&::picker(select)]:bg-card [@supports(appearance:base-select)]:[&::picker(select)]:p-1 [@supports(appearance:base-select)]:[&::picker(select)]:text-foreground [@supports(appearance:base-select)]:[&::picker(select)]:shadow-[0_18px_48px_rgb(0_0_0/24%)] [@supports(appearance:base-select)]:[&::picker(select)]:[scrollbar-width:thin] [@supports(appearance:base-select)]:[&::picker-icon]:size-3 [@supports(appearance:base-select)]:[&::picker-icon]:ml-0.5 [@supports(appearance:base-select)]:[&::picker-icon]:text-faint [@supports(appearance:base-select)]:[&::picker-icon]:transition-[rotate] [@supports(appearance:base-select)]:[&::picker-icon]:duration-[140ms] [@supports(appearance:base-select)]:[&::picker-icon]:ease-[ease] [@supports(appearance:base-select)]:[&:open::picker-icon]:rotate-180 [@supports(appearance:base-select)]:[&_option]:flex [@supports(appearance:base-select)]:[&_option]:min-h-8 [@supports(appearance:base-select)]:[&_option]:items-center [@supports(appearance:base-select)]:[&_option]:rounded-lg [@supports(appearance:base-select)]:[&_option]:px-2 [@supports(appearance:base-select)]:[&_option]:py-[0.45rem] [@supports(appearance:base-select)]:[&_option]:text-xs [@supports(appearance:base-select)]:[&_option]:font-medium [@supports(appearance:base-select)]:[&_option]:text-muted [@supports(appearance:base-select)]:[&_option]:cursor-pointer [@supports(appearance:base-select)]:[&_option:hover]:bg-secondary [@supports(appearance:base-select)]:[&_option:hover]:text-foreground [@supports(appearance:base-select)]:[&_option:focus-visible]:bg-secondary [@supports(appearance:base-select)]:[&_option:focus-visible]:text-foreground [@supports(appearance:base-select)]:[&_option:checked]:bg-[color-mix(in_srgb,var(--primary)_12%,var(--secondary))] [@supports(appearance:base-select)]:[&_option:checked]:font-[650] [@supports(appearance:base-select)]:[&_option:checked]:text-foreground [@supports(appearance:base-select)]:[&_option::checkmark]:order-1 [@supports(appearance:base-select)]:[&_option::checkmark]:ml-auto [@supports(appearance:base-select)]:[&_option::checkmark]:text-primary";

  let {
    active,
    clearQueue,
    connection,
    contextUsage,
    creatingTask,
    delivery = $bindable(),
    draft = $bindable(),
    followUpCount,
    hasConfigurationDraft,
    models,
    persistDraft,
    projectName,
    requiresAcknowledgement,
    runStatus,
    selectedModel,
    selectedThinkingLevel,
    send,
    setStartMode,
    stageConfiguration,
    startMode,
    startModeEditable,
    stats,
    steeringCount,
    stop,
  }: {
    active: boolean;
    clearQueue: () => Promise<void>;
    connection: ConnectionState;
    contextUsage?: ContextUsage;
    creatingTask: boolean;
    delivery: TaskDelivery;
    draft: string;
    followUpCount: number;
    hasConfigurationDraft: boolean;
    models: Workspace["models"];
    persistDraft: () => void;
    projectName: string;
    requiresAcknowledgement: boolean;
    runStatus: ChatSnapshot["runStatus"];
    selectedModel: string;
    selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    send: () => Promise<void>;
    setStartMode: (mode: TaskStartMode) => void;
    stageConfiguration: (patch: TaskConfigurationPatch) => void;
    startMode: TaskStartMode;
    startModeEditable: boolean;
    stats: ChatSnapshot["stats"];
    steeringCount: number;
    stop: () => Promise<void>;
  } = $props();

  let promptInput = $state<HTMLTextAreaElement>();
  let startMenuOpen = $state(false);
  let startModeLabel = $derived(startMode === "worktree" ? "New worktree" : "Work locally");

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

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 821px)").matches) {
      event.preventDefault();
      void send();
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
  <div
    class="mx-auto w-full max-w-3xl overflow-visible rounded-[22px] border border-border-strong bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-[border-color,box-shadow,background-color] duration-[160ms] focus-within:border-[color-mix(in_srgb,var(--primary)_78%,var(--border-strong))] focus-within:shadow-[0_16px_40px_-22px_rgb(24_24_27/55%),0_0_0_3px_color-mix(in_srgb,var(--primary)_9%,transparent)] dark:bg-[color-mix(in_srgb,var(--card)_92%,transparent)] dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:shadow-[inset_0_1px_rgb(255_255_255/3%),0_0_0_3px_color-mix(in_srgb,var(--primary)_11%,transparent)] max-[560px]:rounded-[19px]"
    data-testid="chat-composer"
  >
    <div
      class="flex min-h-9 min-w-0 items-center gap-1 border-b border-border px-3 text-[11px] text-muted"
      aria-label="Task workspace"
    >
      <span class="inline-flex min-w-0 flex-none items-center gap-1.5 px-1.5">
        <Icon name="folder" size={13} />
        <span class="max-w-40 overflow-hidden text-ellipsis whitespace-nowrap">{projectName}</span>
      </span>
      <span class="mx-1 h-3.5 w-px flex-none bg-border" aria-hidden="true"></span>
      <div class="relative flex-none" data-start-menu>
        <button
          class="inline-flex h-7 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-[11px] font-medium text-muted hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-70"
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
            class="absolute bottom-full left-0 z-20 mb-2 w-48 rounded-xl border border-border-strong bg-card p-1.5 text-foreground shadow-xl"
            role="menu"
            aria-label="Start in"
          >
            <p class="m-0 px-2 py-1.5 text-[10px] font-medium text-faint">Start in</p>
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
    <textarea
      class="block min-h-22 max-h-52 w-full resize-none border-0 border-none bg-transparent px-4.5 pt-4 pb-2 text-sm leading-[1.5] text-foreground outline-none placeholder:text-[color-mix(in_srgb,var(--faint)_72%,transparent)] max-[560px]:min-h-18 max-[560px]:px-3.5 max-[560px]:pt-3.5 max-[560px]:pb-1.5 max-[560px]:text-base"
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
      aria-label="Prompt"></textarea>
    <div
      class="flex min-h-11.5 min-w-0 items-center justify-between gap-2.5 pt-0.5 pr-2.5 pb-2.5 pl-3 max-[560px]:min-h-10.5 max-[560px]:items-end max-[560px]:pr-1.75 max-[560px]:pb-1.75 max-[560px]:pl-2"
    >
      <div
        class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[560px]:gap-0"
      >
        <label
          class="flex h-7.5 min-w-0 flex-none items-center gap-1.5 rounded-lg pl-2 text-muted transition-colors duration-[140ms] hover:bg-secondary hover:text-foreground focus-within:bg-secondary focus-within:text-foreground max-[560px]:gap-1 max-[560px]:pl-1.5"
        >
          <select
            class={[
              composerSelectClass,
              "[@supports(appearance:base-select)]:[&::picker(select)]:min-w-56",
            ]}
            aria-label="Model"
            value={selectedModel}
            onchange={(event) => stageConfiguration({ model: event.currentTarget.value })}
            disabled={!models.length}
          >
            {#each models as model (model.id)}<option value={model.id}>{model.name}</option>{/each}
          </select>
        </label>
        <span class="mx-0.5 h-4 w-px flex-none bg-border max-[560px]:mx-0" aria-hidden="true"
        ></span>
        <label
          class="flex h-7.5 min-w-0 flex-none items-center gap-1.5 rounded-lg pl-2 text-muted transition-colors duration-[140ms] hover:bg-secondary hover:text-foreground focus-within:bg-secondary focus-within:text-foreground max-[560px]:gap-1 max-[560px]:pl-1.5"
        >
          <span
            class="grid w-4 flex-none place-items-center text-current max-[560px]:hidden"
            aria-hidden="true"><Icon name="activity" size={14} /></span
          >
          <select
            class={[
              composerSelectClass,
              "[@supports(appearance:base-select)]:[&::picker(select)]:min-w-36",
            ]}
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
        {#if hasConfigurationDraft}<span
            class="ml-1 flex-none rounded-full bg-primary/12 px-1.75 py-0.75 text-[10px] font-[650] tracking-[0.01em] whitespace-nowrap text-primary"
            >Next turn</span
          >{/if}
      </div>
      <div class="flex min-w-0 flex-none items-center gap-1">
        {#if contextUsage}<ContextUsageMeter usage={contextUsage} />{/if}
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
            disabled={!draft.trim() || connection !== "connected"}
            aria-label="Queue">Queue</button
          >
        {:else}
          <button
            class="inline-grid size-8.5 flex-none place-items-center rounded-[999px] border-0 border-none bg-primary text-primary-foreground shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_24%,transparent)] transition-[background-color,box-shadow,transform,opacity] duration-[140ms] hover:not-disabled:-translate-y-px hover:not-disabled:bg-primary-hover hover:not-disabled:shadow-[0_6px_16px_color-mix(in_srgb,var(--primary)_34%,transparent)] active:not-disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
            onclick={send}
            disabled={!draft.trim() ||
              !models.length ||
              connection !== "connected" ||
              creatingTask ||
              requiresAcknowledgement}
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
