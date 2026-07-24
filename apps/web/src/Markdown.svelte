<script lang="ts">
  import { safeMarkdown } from "./markdown.js";
  export let text: string;
</script>

<div class="markdown text-sm leading-[1.72] text-foreground/95 [overflow-wrap:anywhere]">
  {@html safeMarkdown(text)}
</div>
