<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatToolDuration, toolCallHeader, toolCallPreview } from "./tool-call.js";

  let {
    name,
    argumentSummary,
    status,
    output,
    startedAt,
    endedAt,
    now,
    children,
  }: {
    name: string;
    argumentSummary: string;
    status: "running" | "success" | "error";
    output: string;
    startedAt?: number;
    endedAt?: number;
    now: number;
    children?: Snippet;
  } = $props();

  let expanded = $state(false);
  let header = $derived(toolCallHeader(name, argumentSummary));
  let preview = $derived(toolCallPreview(output));
  let lines = $derived(expanded ? output.replace(/\s+$/, "").split("\n") : preview.lines);
  let timing = $derived(
    startedAt === undefined
      ? undefined
      : `${status === "running" ? "Elapsed" : "Took"} ${formatToolDuration((endedAt ?? now) - startedAt)}`,
  );
</script>

<div class={`tool-call tool-call--${status}`}>
  <button
    type="button"
    class="tool-call__toggle"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <span class="tool-call__title"
      ><span class="tool-call__label">{header.label}</span>{" "}{#if header.detail}<span
          class={header.label === "$" ? "" : "tool-call__argument"}>{header.detail}</span
        >{/if}</span
    >
    {#if !expanded && preview.skipped > 0}
      <span class="tool-call__hint">… ({preview.skipped} earlier lines, click to expand)</span>
    {/if}
  </button>
  {#if output}
    <pre class="tool-call__output">{lines.join("\n")}</pre>
  {/if}
  {#if timing}<p class="tool-call__timing">{timing}</p>{/if}
  {@render children?.()}
</div>
