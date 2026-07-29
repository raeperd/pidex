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
  let thinkingLabel = $derived.by(() => {
    if (!complete) return "Thinking";
    return (
      thinking
        ?.split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim() || "Thought"
    );
  });
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

<article class="group/assistant mb-2 min-w-0 px-2 py-1">
  {#if thinking}
    <details class="mb-1">
      <summary
        class="flex w-full cursor-pointer items-center gap-2 overflow-hidden py-2 font-mono text-[12px] leading-[1.5] text-ellipsis whitespace-nowrap italic text-faint [list-style:none]"
        >{#if !complete}<span class="inline-flex gap-0.5"
            ><i class="size-1 animate-pulse rounded-full bg-current"></i><i
              class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.2s]"
            ></i><i class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.4s]"
            ></i></span
          >{/if}{thinkingLabel}</summary
      >
      <pre
        class="mb-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-none border-0 bg-secondary px-2 py-2 font-mono text-[12px] leading-[1.55] text-muted">{thinking}</pre>
    </details>
  {/if}
  <div
    class="markdown terminal-markdown font-mono text-[12.5px] leading-[1.55] text-foreground/95 [overflow-wrap:anywhere]"
  >
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
          role="tooltip">{copied ? "Copied" : "Copy"}</span
        >
      </span>
      {#if sentAt && formattedTimestamp}
        <span aria-hidden="true">·</span>
        <time datetime={timestamp} title={sentAt.toLocaleString()}>{formattedTimestamp}</time>
      {/if}
    </footer>
  {/if}
</article>

<style>
  .terminal-markdown :global(h1),
  .terminal-markdown :global(h2),
  .terminal-markdown :global(h3),
  .terminal-markdown :global(h4),
  .terminal-markdown :global(h5),
  .terminal-markdown :global(h6) {
    margin: 1.15em 0 0.55em;
    color: var(--warning);
    font-size: 1em;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.55;
  }

  .terminal-markdown :global(p),
  .terminal-markdown :global(ul),
  .terminal-markdown :global(ol) {
    margin-block: 0.55em;
  }

  .terminal-markdown :global(li + li) {
    margin-top: 0.15em;
  }

  .terminal-markdown :global(code:not(pre code)) {
    padding: 1px 4px;
    border-radius: 2px;
    color: var(--tool-argument);
  }
</style>
