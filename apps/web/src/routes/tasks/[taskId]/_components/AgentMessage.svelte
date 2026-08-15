<script lang="ts">
  import Icon from "../../../_components/Icon.svelte";
  import AgentMessageBody from "./AgentMessageBody.svelte";
  import { parseAgentMessage } from "./AgentMessageParser";
  import type { HighlightTheme } from "./AgentMessageCodeBlock.svelte";
  import { createCopyState } from "./copyState.svelte";

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
  let thinkingNodes = $derived(parseAgentMessage(thinking ?? ""));
  const copyState = createCopyState();
  let sentAt = $derived.by(() => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? undefined : date;
  });
  let formattedTimestamp = $derived(
    sentAt
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(sentAt)
      : undefined,
  );
</script>

<article class="group/assistant my-6 min-w-0 px-2 py-1">
  {#if thinking}
    <div
      class="thinking-markdown mb-2 font-sans text-control italic text-faint [overflow-wrap:anywhere]"
    >
      {#if !complete}<span class="mb-2 inline-flex gap-0.5" aria-label="Thinking"
          ><i class="size-1 animate-status-pulse rounded-full bg-current"></i><i
            class="size-1 animate-status-pulse rounded-full bg-current [animation-delay:0.2s]"
          ></i><i class="size-1 animate-status-pulse rounded-full bg-current [animation-delay:0.4s]"
          ></i></span
        >{/if}
      <AgentMessageBody nodes={thinkingNodes} streaming={!complete} {theme} />
    </div>
  {/if}
  <div
    class="markdown terminal-markdown font-sans text-body text-foreground/95 [overflow-wrap:anywhere]"
  >
    <AgentMessageBody {nodes} streaming={!complete} {theme} />
  </div>
  {#if complete && text.trim()}
    <footer
      class="mt-2 flex items-center gap-2 text-meta text-faint opacity-70 transition-opacity group-hover/assistant:opacity-100 focus-within:opacity-100"
    >
      <span class="group/copy relative inline-flex">
        <button
          type="button"
          class="grid size-6 place-items-center rounded text-faint hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={copyState.copied ? "Response copied" : "Copy response"}
          onclick={() => void copyState.copy(text)}
        >
          <Icon name={copyState.copied ? "check" : "copy"} size={13} />
        </button>
        <span
          class="pointer-events-none absolute bottom-[calc(100%+0.375rem)] left-1/2 z-20 -translate-x-1/2 rounded-md border border-border-strong bg-card px-2 py-1 text-meta leading-none whitespace-nowrap text-foreground opacity-0 shadow-raised transition-opacity duration-100 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100"
          role="tooltip">{copyState.copied ? "Copied" : "Copy"}</span
        >
      </span>
      {#if formattedTimestamp}
        <span aria-hidden="true">·</span>
        <time datetime={timestamp} title={sentAt?.toLocaleString()}>{formattedTimestamp}</time>
      {/if}
    </footer>
  {/if}
</article>

<style>
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

  .thinking-markdown :global(p) {
    margin: 0 0 1rem;
  }

  .thinking-markdown :global(p:last-child) {
    margin-bottom: 0;
  }
</style>
