<script lang="ts">
  import { safeMarkdown } from "./markdown.js";

  let { text }: { text: string } = $props();
  let html = $derived(safeMarkdown(text));
</script>

<div class="markdown text-sm leading-[1.72] text-foreground/95 [overflow-wrap:anywhere]">
  {@html html}
</div>
