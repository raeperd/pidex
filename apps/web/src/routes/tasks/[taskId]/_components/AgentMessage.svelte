<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "../../../_components/Icon.svelte";
  import AgentMessageBody from "./AgentMessageBody.svelte";
  import { parseAgentMessage } from "./AgentMessageParser";
  import type { HighlightTheme } from "./AgentMessageCodeBlock.svelte";

  let {
    complete,
    text,
    theme,
    thinking,
    timestamp,
  }: {
    complete: boolean;
    text: string;
    theme: HighlightTheme;
    thinking?: string;
    timestamp: string;
  } = $props();

  let nodes = $derived(parseAgentMessage(text));
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let sentAt = $derived.by(() => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? undefined : date;
  });
  let formattedTimestamp = $derived(
    sentAt
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(sentAt)
      : undefined,
  );

  async function copyResponse() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1_500);
    } catch {
      copied = false;
    }
  }

  onDestroy(() => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });
</script>

<article class="group/assistant mb-5 min-w-0 px-1 pt-0.5 pb-1">
  {#if thinking}
    <details class="mb-2.5 border-b border-border/70">
      <summary
        class="flex w-max cursor-pointer items-center gap-2 pt-1 pb-2 text-[11px] text-faint [list-style:none]"
        >{#if !complete}<span class="inline-flex gap-0.5"
            ><i class="size-1 animate-pulse rounded-full bg-current"></i><i
              class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.2s]"
            ></i><i class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.4s]"
            ></i></span
          >{/if}{complete ? "Thought" : "Thinking"}</summary
      >
      <pre
        class="mb-2.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/70 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted dark:bg-[#111113]">{thinking}</pre>
    </details>
  {/if}
  <div class="markdown text-sm leading-[1.72] text-foreground/95 [overflow-wrap:anywhere]">
    <AgentMessageBody {nodes} streaming={!complete} {theme} />
  </div>
  {#if complete && text.trim()}
    <footer
      class="mt-2 flex items-center gap-2 text-[10.5px] text-faint opacity-70 transition-opacity group-hover/assistant:opacity-100 focus-within:opacity-100"
    >
      <span class="group/copy relative inline-flex">
        <button
          type="button"
          class="grid size-6 place-items-center rounded text-faint hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={copied ? "Response copied" : "Copy response"}
          onclick={() => void copyResponse()}
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
        </button>
        <span
          class="pointer-events-none absolute bottom-[calc(100%+0.375rem)] left-1/2 z-20 -translate-x-1/2 rounded-md border border-border-strong bg-card px-2 py-1 text-[10.5px] leading-none whitespace-nowrap text-foreground opacity-0 shadow-lg transition-opacity duration-100 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100"
          role="tooltip"
        >{copied ? "Copied" : "Copy"}</span>
      </span>
      {#if sentAt && formattedTimestamp}
        <span aria-hidden="true">·</span>
        <time datetime={timestamp} title={sentAt.toLocaleString()}>{formattedTimestamp}</time>
      {/if}
    </footer>
  {/if}
</article>
