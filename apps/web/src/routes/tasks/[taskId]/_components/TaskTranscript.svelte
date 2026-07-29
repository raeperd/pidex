<script lang="ts" module>
  import type { TranscriptItem, ToolItem } from "@pidex/api";
  import { toolCallKind } from "./ToolCall.svelte";

  export type TranscriptRow =
    | { kind: "item"; item: Exclude<TranscriptItem, ToolItem> }
    | { kind: "tools"; id: string; items: ToolItem[] };

  export function groupTranscriptItems(items: TranscriptItem[]): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    for (const item of items) {
      if (item.type !== "tool") {
        rows.push({ kind: "item", item });
        continue;
      }

      const previous = rows.at(-1);
      if (previous?.kind === "tools") previous.items.push(item);
      else rows.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
    }
    return rows;
  }

  export function toolActivitySummary(items: ToolItem[]): string {
    const counts = { read: 0, shell: 0, search: 0, edit: 0, other: 0 };
    for (const item of items) {
      const kind = toolCallKind(item.name);
      if (kind === "generic") counts.other += 1;
      else counts[kind] += 1;
    }

    const phrases = [
      counts.read > 0 ? `read ${counts.read} ${counts.read === 1 ? "file" : "files"}` : "",
      counts.shell > 0 ? `ran ${counts.shell} ${counts.shell === 1 ? "command" : "commands"}` : "",
      counts.search > 0
        ? counts.search === 1
          ? "searched once"
          : `searched ${counts.search} times`
        : "",
      counts.edit > 0 ? `edited ${counts.edit} ${counts.edit === 1 ? "file" : "files"}` : "",
      counts.other > 0 ? `used ${counts.other} ${counts.other === 1 ? "tool" : "tools"}` : "",
    ].filter(Boolean);
    const summary = joinPhrases(phrases);
    return summary ? `${summary[0]?.toUpperCase()}${summary.slice(1)}` : "Tool activity";
  }

  function joinPhrases(phrases: string[]): string {
    if (phrases.length <= 1) return phrases[0] ?? "";
    if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
    return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
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
  const darkMode = new MediaQuery("prefers-color-scheme: dark");
  let rows = $derived(groupTranscriptItems(items));

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

{#snippet toolCall(item: ToolItem)}
  {@const output = (item.resourceId ? toolOutputs[item.resourceId]?.text : "") || item.preview}
  <ToolCall
    name={item.name}
    argumentSummary={item.argumentSummary}
    status={item.state}
    {output}
    startedAt={toolTimings[item.id]?.startedAt}
    endedAt={toolTimings[item.id]?.endedAt}
    now={toolElapsedNow}
    detailsAvailable={Boolean(output || item.resourceId)}
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

{#snippet toolGroup(row: Extract<TranscriptRow, { kind: "tools" }>)}
  {@const previous = row.items.slice(0, -1)}
  {@const latest = row.items.at(-1)}
  <div class="tool-activity-group my-3 space-y-2">
    {#if previous.length > 0}
      <details class="group/tool-history">
        <summary
          class="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1 font-sans text-[11px] text-faint transition-colors hover:bg-secondary hover:text-muted focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
        >
          <span class="transition-transform duration-150 group-open/tool-history:rotate-90"
            ><Icon name="chevron" size={12} /></span
          >
          <span>{previous.length} previous tool {previous.length === 1 ? "call" : "calls"}</span>
          <span aria-hidden="true">·</span>
          <span class="truncate">{toolActivitySummary(row.items)}</span>
        </summary>
        <div class="mt-2 space-y-2 border-l border-border pl-2">
          {#each previous as item (item.id)}
            {@render toolCall(item)}
          {/each}
        </div>
      </details>
    {/if}
    {#if latest}{@render toolCall(latest)}{/if}
  </div>
{/snippet}

<section
  class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
  bind:this={transcript}
  onscroll={onScroll}
  role="log"
  aria-live="polite"
  aria-relevant="additions text"
>
  <div
    class="mx-auto w-full max-w-3xl px-2 pt-2 pb-3.5 font-mono text-[12.5px] leading-[1.55] max-[350px]:px-1.5"
  >
    {#if transcriptStart > 0}<button
        class="mx-auto mb-6 block rounded-full border border-border bg-card px-2.5 py-1.5 text-[10.5px] text-muted hover:text-foreground disabled:opacity-40"
        onclick={prependEarlierMessages}
        disabled={loadingEarlier}
        >{loadingEarlier
          ? "Loading earlier messages…"
          : `Load earlier messages · ${transcriptStart.toLocaleString()} remaining`}</button
      >{/if}
    {#each rows as row (row.kind === "tools" ? row.id : row.item.id)}
      {#if row.kind === "tools"}
        {@render toolGroup(row)}
      {:else if row.item.type === "user"}
        <UserMessage text={row.item.text} />
      {:else if row.item.type === "assistant"}
        <AgentMessage
          complete={row.item.complete}
          text={row.item.text}
          thinking={row.item.thinking}
          timestamp={row.item.timestamp}
          theme={darkMode.current ? "dark" : "light"}
        />
      {:else if row.item.type === "notice"}
        <TaskNotice level={row.item.level} text={row.item.text} />
      {/if}
    {/each}
  </div>
</section>

{#if !nearBottom}<button
    class="absolute bottom-40 left-1/2 z-7 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10.5px] text-muted shadow-lg hover:text-foreground max-[560px]:bottom-33"
    onclick={scrollLatest}>Jump to latest <Icon name="arrow-down" size={13} /></button
  >{/if}
