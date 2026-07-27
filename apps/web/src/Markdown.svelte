<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import type { HighlightTheme } from "./MarkdownCode.svelte";
  import MarkdownNodes, { parseMarkdown } from "./MarkdownNodes.svelte";

  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();
  const darkMode = new MediaQuery("prefers-color-scheme: dark");
  let nodes = $derived(parseMarkdown(text));
  let theme = $derived<HighlightTheme>(darkMode.current ? "dark" : "light");
</script>

<div class="markdown text-sm leading-[1.72] text-foreground/95 [overflow-wrap:anywhere]">
  <MarkdownNodes {nodes} {streaming} {theme} />
</div>
