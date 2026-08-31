<script lang="ts" module>
  import type { HighlighterCore } from "shiki/core";

  export type HighlightTheme = "light" | "dark";

  interface HighlightedCode {
    lines: {
      content: string;
      color?: string;
      bold: boolean;
      italic: boolean;
      underline: boolean;
    }[][];
  }

  const MAX_CACHE_CHARACTERS = 200_000;
  const MAX_HIGHLIGHT_CHARACTERS = 100_000;
  const highlightCache = new Map<string, Promise<HighlightedCode | null>>();
  let cachedCharacters = 0;
  const languageLoads = new Map<string, Promise<void>>();
  let highlighterPromise: Promise<HighlighterCore> | undefined;

  const languageLoaders = {
    css: () => import("shiki/langs/css.mjs"),
    diff: () => import("shiki/langs/diff.mjs"),
    go: () => import("shiki/langs/go.mjs"),
    html: () => import("shiki/langs/html.mjs"),
    javascript: () => import("shiki/langs/javascript.mjs"),
    json: () => import("shiki/langs/json.mjs"),
    jsx: () => import("shiki/langs/jsx.mjs"),
    markdown: () => import("shiki/langs/markdown.mjs"),
    python: () => import("shiki/langs/python.mjs"),
    rust: () => import("shiki/langs/rust.mjs"),
    shellscript: () => import("shiki/langs/shellscript.mjs"),
    sql: () => import("shiki/langs/sql.mjs"),
    svelte: () => import("shiki/langs/svelte.mjs"),
    tsx: () => import("shiki/langs/tsx.mjs"),
    typescript: () => import("shiki/langs/typescript.mjs"),
    yaml: () => import("shiki/langs/yaml.mjs"),
  } as const;

  const languageAliases: Record<string, keyof typeof languageLoaders> = {
    bash: "shellscript",
    js: "javascript",
    md: "markdown",
    py: "python",
    sh: "shellscript",
    shell: "shellscript",
    ts: "typescript",
    yml: "yaml",
  };

  export function highlightCode(
    code: string,
    language: string,
    theme: HighlightTheme,
  ): Promise<HighlightedCode | null> {
    if (!code || code.length > MAX_HIGHLIGHT_CHARACTERS) return Promise.resolve(null);

    const normalizedLanguage = normalizeLanguage(language);
    const key = `${theme}:${normalizedLanguage}:${code}`;
    const cached = highlightCache.get(key);
    if (cached) {
      highlightCache.delete(key);
      highlightCache.set(key, cached);
      return cached;
    }

    const highlighted = tokenize(code, normalizedLanguage, theme);
    highlightCache.set(key, highlighted);
    cachedCharacters += key.length;
    while (cachedCharacters > MAX_CACHE_CHARACTERS) {
      const oldest = highlightCache.keys().next().value;
      if (oldest === undefined) break;
      highlightCache.delete(oldest);
      cachedCharacters -= oldest.length;
    }
    return highlighted;
  }

  async function tokenize(
    code: string,
    language: keyof typeof languageLoaders | "text",
    theme: HighlightTheme,
  ): Promise<HighlightedCode | null> {
    try {
      const highlighter = await getHighlighter();
      if (language !== "text") await loadLanguage(highlighter, language);
      const result = highlighter.codeToTokens(code, {
        lang: language,
        theme: theme === "dark" ? "github-dark" : "github-light",
        tokenizeMaxLineLength: 10_000,
        tokenizeTimeLimit: 100,
      });
      return {
        lines: result.tokens.map((line) =>
          line.map((token) => ({
            content: token.content,
            ...(token.color ? { color: token.color } : {}),
            italic: Boolean((token.fontStyle ?? 0) & 1),
            bold: Boolean((token.fontStyle ?? 0) & 2),
            underline: Boolean((token.fontStyle ?? 0) & 4),
          })),
        ),
      };
    } catch {
      return language === "text" ? null : tokenize(code, "text", theme);
    }
  }

  function getHighlighter(): Promise<HighlighterCore> {
    highlighterPromise ??= createHighlighter();
    return highlighterPromise;
  }

  async function createHighlighter(): Promise<HighlighterCore> {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, lightTheme, darkTheme] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ]);
    return createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [lightTheme.default, darkTheme.default],
      langs: [],
    });
  }

  function loadLanguage(
    highlighter: HighlighterCore,
    language: keyof typeof languageLoaders,
  ): Promise<void> {
    const loaded = languageLoads.get(language);
    if (loaded) return loaded;
    const loading = languageLoaders[language]().then(({ default: registration }) =>
      highlighter.loadLanguage(registration),
    );
    languageLoads.set(language, loading);
    return loading;
  }

  function normalizeLanguage(language: string): keyof typeof languageLoaders | "text" {
    const normalized = language.toLowerCase();
    if (normalized in languageLoaders) return normalized as keyof typeof languageLoaders;
    return languageAliases[normalized] ?? "text";
  }
</script>

<script lang="ts">
  import { Check, Copy, WrapText } from "@lucide/svelte";
  import { createCopyState } from "./copyState.svelte";

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
  const copyState = createCopyState();
  const newline = "\n";
  let highlighted = $derived(
    streaming ? Promise.resolve(null) : highlightCode(code, language, theme),
  );
</script>

<div class="markdown-codeblock" data-wrap={wrapped ? "true" : "false"}>
  <div class="markdown-codeblock__header">
    <span class="markdown-codeblock__title" title={title ?? language}>{title ?? language}</span>
    <span class="markdown-codeblock__actions">
      <span class="icon-tooltip relative inline-flex">
        <button
          type="button"
          class="markdown-codeblock__action"
          aria-label={wrapped ? "Disable line wrap" : "Wrap lines"}
          aria-pressed={wrapped}
          onclick={() => (wrapped = !wrapped)}
        >
          <WrapText size={13} />
        </button>
        <span
          class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-right"
          role="tooltip">{wrapped ? "Disable line wrap" : "Wrap lines"}</span
        >
      </span>
      <span class="icon-tooltip relative inline-flex">
        <button
          type="button"
          class="markdown-codeblock__action"
          aria-label={copyState.copied ? "Copied" : "Copy code"}
          onclick={() => void copyState.copy(code)}
        >
          {#if copyState.copied}<Check size={13} />{:else}<Copy size={13} />{/if}
        </button>
        <span
          class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-right"
          role="tooltip">{copyState.copied ? "Copied" : "Copy code"}</span
        >
      </span>
    </span>
  </div>
  <pre><code
      >{#await highlighted}{code}{:then result}{#if result}{#each result.lines as line, lineIndex (lineIndex)}{#each line as token, tokenIndex (tokenIndex)}<span
                style:color={token.color}
                class:italic={token.italic}
                class:font-bold={token.bold}
                class:underline={token.underline}>{token.content}</span
              >{/each}{#if lineIndex < result.lines.length - 1}{newline}{/if}{/each}{:else}{code}{/if}{/await}</code
    ></pre>
</div>
