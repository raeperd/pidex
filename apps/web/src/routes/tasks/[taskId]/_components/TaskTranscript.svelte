<script lang="ts">
  import { tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import type { TranscriptItem, ToolItem } from "@pidex/api";
  import AgentMessage from "./AgentMessage.svelte";
  import type { TaskToolOutput, TaskToolTiming } from "../../../_components/AppShellContext.svelte";
  import Icon from "../../../_components/Icon.svelte";
  import TaskNotice from "./TaskNotice.svelte";
  import ToolCall from "./ToolCall.svelte";
  import UserMessage from "./UserMessage.svelte";

  let {
    items,
    loadEarlier,
    loadToolOutput,
    loadingEarlier,
    toolElapsedNow,
    toolOutputs,
    toolTimings,
    transcriptStart,
  }: {
    items: TranscriptItem[];
    loadEarlier: () => Promise<void>;
    loadToolOutput: (item: ToolItem) => Promise<void>;
    loadingEarlier: boolean;
    toolElapsedNow: number;
    toolOutputs: Record<string, TaskToolOutput>;
    toolTimings: Record<string, TaskToolTiming>;
    transcriptStart: number;
  } = $props();

  let transcript = $state<HTMLElement>();
  let nearBottom = $state(true);
  let expandedToolGroups = $state<Record<string, boolean>>({});
  let rows = $derived(buildTranscriptRows(items));
  const darkMode = new MediaQuery("prefers-color-scheme: dark");

  export function scrollLatest() {
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
    nearBottom = true;
  }

  export function scrollIfNearBottom() {
    if (nearBottom) requestAnimationFrame(scrollLatest);
  }

  async function prependEarlierMessages() {
    const previousScrollHeight = transcript?.scrollHeight;
    const previousScrollTop = transcript?.scrollTop;
    await loadEarlier();
    if (transcript && previousScrollHeight !== undefined && previousScrollTop !== undefined) {
      await tick();
      transcript.scrollTop = previousScrollTop + transcript.scrollHeight - previousScrollHeight;
    }
  }

  function onScroll() {
    if (transcript)
      nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
  }

  type TranscriptRow =
    | { type: "item"; id: string; item: Exclude<TranscriptItem, ToolItem> }
    | { type: "tools"; id: string; items: ToolItem[] };

  function buildTranscriptRows(sourceItems: TranscriptItem[]): TranscriptRow[] {
    const result: TranscriptRow[] = [];
    for (let index = 0; index < sourceItems.length;) {
      const item = sourceItems[index];
      if (!item) break;
      if (item.type !== "tool") {
        result.push({ type: "item", id: item.id, item });
        index += 1;
        continue;
      }

      const tools: ToolItem[] = [];
      while (sourceItems[index]?.type === "tool") {
        tools.push(sourceItems[index] as ToolItem);
        index += 1;
      }
      result.push({ type: "tools", id: `tools:${tools[0]?.id}`, items: tools });
    }
    return result;
  }
</script>

{#snippet toolCall(item: ToolItem)}
  <ToolCall
    name={item.name}
    argumentSummary={item.argumentSummary}
    status={item.state}
    output={(item.resourceId ? toolOutputs[item.resourceId]?.text : "") || item.preview}
    startedAt={toolTimings[item.id]?.startedAt}
    endedAt={toolTimings[item.id]?.endedAt}
    now={toolElapsedNow}
  >
    {#if item.resourceId && !toolOutputs[item.resourceId]?.complete}
      <button
        class="mt-2 rounded-lg border border-border bg-card px-2 py-1.5 text-[10px] font-semibold text-primary disabled:opacity-40"
        onclick={() => loadToolOutput(item)}
        disabled={toolOutputs[item.resourceId]?.loading}
        >{toolOutputs[item.resourceId]?.loading
          ? "Loading bounded chunk…"
          : toolOutputs[item.resourceId]?.text
            ? `Load more · ${toolOutputs[item.resourceId]?.nextOffset.toLocaleString()} / ${toolOutputs[item.resourceId]?.total.toLocaleString()}`
            : `Load complete output · ${(item.outputSize ?? 0).toLocaleString()} chars`}</button
      >
    {/if}
    {#if item.resourceId && toolOutputs[item.resourceId]?.sourceTruncated}<p
        class="mt-2 text-[10px] text-faint"
      >
        The host bounded this output at its safety limit.
      </p>{/if}
    {#if item.resourceId && toolOutputs[item.resourceId]?.error}<p
        class="mt-2 text-[10px] text-danger"
      >
        {toolOutputs[item.resourceId]?.error}
      </p>{/if}
  </ToolCall>
{/snippet}

<section
  class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
  bind:this={transcript}
  onscroll={onScroll}
  role="log"
  aria-live="polite"
  aria-relevant="additions text"
>
  <div class="mx-auto w-full max-w-3xl px-5 pt-7.5 pb-3.5 max-[900px]:px-4 max-[350px]:px-3">
    {#if transcriptStart > 0}<button
        class="mx-auto mb-6 block rounded-full border border-border bg-card px-2.5 py-1.5 text-[10.5px] text-muted hover:text-foreground disabled:opacity-40"
        onclick={prependEarlierMessages}
        disabled={loadingEarlier}
        >{loadingEarlier
          ? "Loading earlier messages…"
          : `Load earlier messages · ${transcriptStart.toLocaleString()} remaining`}</button
      >{/if}
    {#each rows as row (row.id)}
      {#if row.type === "item"}
        {@const item = row.item}
        {#if item.type === "user"}
          <UserMessage text={item.text} />
        {:else if item.type === "assistant"}
          <AgentMessage
            complete={item.complete}
            text={item.text}
            thinking={item.thinking}
            timestamp={item.timestamp}
            theme={darkMode.current ? "dark" : "light"}
          />
        {:else if item.type === "notice"}
          <TaskNotice level={item.level} text={item.text} />
        {/if}
      {:else}
        {@const collapsibleItems = row.items
          .slice(0, -2)
          .filter((item) => item.state === "success")}
        {@const collapsibleIds = new Set(collapsibleItems.map((item) => item.id))}
        {@const hiddenCount = collapsibleItems.length}
        {@const expanded = Boolean(expandedToolGroups[row.id])}
        {#if hiddenCount > 0}
          <button
            type="button"
            class="mx-1 my-1 flex items-center gap-1 rounded-md px-1 py-1 text-[11px] font-medium text-muted hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`}
            onclick={() => (expandedToolGroups = { ...expandedToolGroups, [row.id]: !expanded })}
          >
            {expanded ? "Hide" : "Show"}
            {hiddenCount} previous tool {hiddenCount === 1 ? "call" : "calls"}
          </button>
        {/if}
        {#each row.items as item (item.id)}
          {#if expanded || !collapsibleIds.has(item.id)}
            {@render toolCall(item)}
          {/if}
        {/each}
      {/if}
    {/each}
  </div>
</section>

{#if !nearBottom}<button
    class="absolute bottom-40 left-1/2 z-7 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10.5px] text-muted shadow-lg hover:text-foreground max-[560px]:bottom-33"
    onclick={scrollLatest}>Jump to latest <Icon name="arrow-down" size={13} /></button
  >{/if}
