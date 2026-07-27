import type { HighlighterCore } from "shiki/core";

export type HighlightTheme = "light" | "dark";

export interface HighlightToken {
  content: string;
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface HighlightedCode {
  lines: HighlightToken[][];
}

const MAX_CACHE_ENTRIES = 200;
const MAX_HIGHLIGHT_CHARACTERS = 100_000;
const highlightCache = new Map<string, Promise<HighlightedCode | null>>();
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
  html: "html",
  js: "javascript",
  javascript: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
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
  while (highlightCache.size > MAX_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value;
    if (oldest === undefined) break;
    highlightCache.delete(oldest);
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
