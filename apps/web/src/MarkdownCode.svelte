<script lang="ts">
  import { Check, Copy, WrapText } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { highlightCode, type HighlightTheme } from "./highlight.js";

  let {
    code,
    language,
    title,
    streaming = false,
    theme,
  }: {
    code: string;
    language: string;
    title?: string;
    streaming?: boolean;
    theme: HighlightTheme;
  } = $props();

  let wrapped = $state(false);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const newline = "\n";
  let highlighted = $derived(
    streaming ? Promise.resolve(null) : highlightCode(code, language, theme),
  );

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
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

<div class="markdown-codeblock" data-wrap={wrapped ? "true" : "false"}>
  <div class="markdown-codeblock__header">
    <span class="markdown-codeblock__title" title={title ?? language}>{title ?? language}</span>
    <span class="markdown-codeblock__actions">
      <button
        type="button"
        class="markdown-codeblock__action"
        aria-label={wrapped ? "Disable line wrap" : "Wrap lines"}
        aria-pressed={wrapped}
        onclick={() => (wrapped = !wrapped)}
      >
        <WrapText size={13} />
      </button>
      <button
        type="button"
        class="markdown-codeblock__action"
        aria-label={copied ? "Copied" : "Copy code"}
        onclick={() => void copyCode()}
      >
        {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
      </button>
    </span>
  </div>
  <pre><code
      >{#await highlighted}{code}{:then result}{#if result}{#each result.lines as line, lineIndex (`${lineIndex}:${line.map((token) => token.content).join("")}`)}{#each line as token, tokenIndex (`${tokenIndex}:${token.content}`)}<span
                style:color={token.color}
                style:font-style={token.italic ? "italic" : undefined}
                style:font-weight={token.bold ? "700" : undefined}
                style:text-decoration={token.underline ? "underline" : undefined}
                >{token.content}</span
              >{/each}{#if lineIndex < result.lines.length - 1}{newline}{/if}{/each}{:else}{code}{/if}{/await}</code
    ></pre>
</div>
