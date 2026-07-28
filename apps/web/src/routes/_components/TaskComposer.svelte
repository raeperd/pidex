<script lang="ts">
  import type { ChatSnapshot, ContextUsage, Workspace } from "@pidex/api";
  import type { ConnectionState } from "./AppShellConnection";
  import ContextUsageMeter from "./ContextUsageMeter.svelte";
  import Icon from "./Icon.svelte";

  type Delivery = "follow-up" | "steer";
  type TaskConfiguration = {
    model?: string;
    thinkingLevel?: ChatSnapshot["thinkingLevel"];
  };

  let {
    active,
    clearQueue,
    connection,
    contextUsage,
    delivery = $bindable(),
    draft = $bindable(),
    followUpCount,
    hasConfigurationDraft,
    models,
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
  }: {
    active: boolean;
    clearQueue: () => Promise<void>;
    connection: ConnectionState;
    contextUsage?: ContextUsage;
    delivery: Delivery;
    draft: string;
    followUpCount: number;
    hasConfigurationDraft: boolean;
    models: Workspace["models"];
    persistDraft: () => void;
    requiresAcknowledgement: boolean;
    runStatus: ChatSnapshot["runStatus"];
    selectedModel: string;
    selectedThinkingLevel: ChatSnapshot["thinkingLevel"];
    send: () => Promise<void>;
    stageConfiguration: (patch: TaskConfiguration) => void;
    stats: ChatSnapshot["stats"];
    steeringCount: number;
    stop: () => Promise<void>;
  } = $props();

  let promptInput = $state<HTMLTextAreaElement>();

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
  <div class="chat-composer mx-auto" data-testid="chat-composer">
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
            class="chat-composer__send"
            onclick={send}
            disabled={!draft.trim() ||
              !models.length ||
              connection !== "connected" ||
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
