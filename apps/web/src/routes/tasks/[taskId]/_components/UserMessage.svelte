<script lang="ts">
  import Icon from "../../../_components/Icon.svelte";
  import { createCopyState } from "./copyState.svelte";

  let { text }: { text: string } = $props();

  const copyState = createCopyState();
</script>

<article class="group/user my-6 flex flex-col items-end px-2">
  <div
    class="w-fit max-w-[85%] rounded-composer bg-secondary px-4 py-3 font-sans text-ui leading-[1.55] font-medium whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] max-[560px]:max-w-[92%] max-[560px]:px-3.5 max-[560px]:py-2.5"
  >
    {text}
  </div>
  {#if text.trim()}
    <footer
      class="mt-2 flex items-center gap-2 text-meta text-faint opacity-70 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100"
    >
      <span class="group/copy relative inline-flex">
        <button
          type="button"
          class="grid size-6 place-items-center rounded text-faint hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={copyState.copied ? "Message copied" : "Copy message"}
          onclick={() => void copyState.copy(text)}
        >
          <Icon name={copyState.copied ? "check" : "copy"} size={13} />
        </button>
        <span
          class="pointer-events-none absolute bottom-[calc(100%+0.375rem)] left-1/2 z-20 -translate-x-1/2 rounded-md border border-border-strong bg-card px-2 py-1 text-meta leading-none whitespace-nowrap text-foreground opacity-0 shadow-raised transition-opacity duration-100 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100"
          role="tooltip">{copyState.copied ? "Copied" : "Copy"}</span
        >
      </span>
    </footer>
  {/if}
</article>
