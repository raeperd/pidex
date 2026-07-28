<script lang="ts" module>
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
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import type { TranscriptItem, ToolItem } from "@pidex/api";
  import AgentMessage from "./AgentMessage.svelte";
  import Icon from "./Icon.svelte";
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
</script>

<section
  class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
  bind:this={transcript}
  onscroll={onScroll}
  role="log"
  aria-live="polite"
  aria-relevant="additions text"
>
  <div class="mx-auto w-full max-w-3xl px-5 pt-7.5 pb-12.5 max-[900px]:px-4 max-[350px]:px-3">
    {#if transcriptStart > 0}<button
        class="mx-auto mb-6 block rounded-full border border-border bg-card px-2.5 py-1.5 text-[10.5px] text-muted hover:text-foreground disabled:opacity-40"
        onclick={prependEarlierMessages}
        disabled={loadingEarlier}
        >{loadingEarlier
          ? "Loading earlier messages…"
          : `Load earlier messages · ${transcriptStart.toLocaleString()} remaining`}</button
      >{/if}
    {#each items as item (item.id)}
      {#if item.type === "user"}
        <UserMessage text={item.text} />
      {:else if item.type === "assistant"}
        <AgentMessage
          complete={item.complete}
          text={item.text}
          thinking={item.thinking}
          theme={darkMode.current ? "dark" : "light"}
        />
      {:else if item.type === "tool"}
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
      {:else if item.type === "notice"}
        <TaskNotice level={item.level} text={item.text} />
      {/if}
    {/each}
  </div>
</section>

{#if !nearBottom}<button
    class="absolute bottom-40 left-1/2 z-7 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10.5px] text-muted shadow-lg hover:text-foreground max-[560px]:bottom-33"
    onclick={scrollLatest}>Jump to latest <Icon name="arrow-down" size={13} /></button
  >{/if}
