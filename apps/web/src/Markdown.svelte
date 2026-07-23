<script lang="ts">
  import { safeMarkdown } from "./markdown.js";
  export let text: string;
</script>
<div class="markdown">{@html safeMarkdown(text)}</div>
