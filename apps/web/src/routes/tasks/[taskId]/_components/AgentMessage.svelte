<script lang="ts">
  import AgentMessageBody from "./AgentMessageBody.svelte";
  import { parseAgentMessage } from "./AgentMessageParser";
  import type { HighlightTheme } from "./AgentMessageCodeBlock.svelte";

  let {
    complete,
    text,
    theme,
    thinking,
  }: {
    complete: boolean;
    text: string;
    theme: HighlightTheme;
    thinking?: string;
  } = $props();

  let nodes = $derived(parseAgentMessage(text));
</script>

<article class="mb-5 min-w-0 px-1 pt-0.5 pb-1">
  {#if thinking}
    <details class="mb-2.5 border-b border-border/70">
      <summary
        class="flex w-max cursor-pointer items-center gap-2 pt-1 pb-2 text-[11px] text-faint [list-style:none]"
        ><span class="inline-flex gap-0.5"
          ><i class="size-1 animate-pulse rounded-full bg-current"></i><i
            class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.2s]"
          ></i><i class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.4s]"
          ></i></span
        >Thinking</summary
      >
      <pre
        class="mb-2.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/70 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted dark:bg-[#111113]">{thinking}</pre>
    </details>
  {/if}
  <div class="markdown text-sm leading-[1.72] text-foreground/95 [overflow-wrap:anywhere]">
    <AgentMessageBody {nodes} streaming={!complete} {theme} />
  </div>
</article>
