<script lang="ts" module>
  export interface ToolCallHeader {
    label: string;
    detail: string;
  }

  export interface ToolCallPreview {
    lines: string[];
    skipped: number;
  }

  export const TOOL_PREVIEW_LINES = 5;

  /** Mirrors Pi's TUI headers: `$ <command>` for bash, `<tool> <path>` for path tools. */
  export function toolCallHeader(name: string, argumentSummary: string): ToolCallHeader {
    const args = parseArguments(argumentSummary);
    if (!args) return { label: name, detail: argumentSummary.trim() };
    if (name === "bash") return { label: "$", detail: text(args.command) || "…" };
    if (name === "read")
      return { label: "Read", detail: text(args.path) || text(args.file_path) || "…" };
    if (name === "grep")
      return {
        label: "Searched",
        detail: [text(args.pattern), text(args.path) || text(args.file_path)]
          .filter(Boolean)
          .join(" · "),
      };
    const detail = [text(args.pattern), text(args.path) || text(args.file_path)]
      .filter(Boolean)
      .join(" ");
    return { label: name, detail: detail || compactArguments(args) };
  }

  /** Keeps the trailing window of output, like Pi's collapsed tool result. */
  export function toolCallPreview(output: string, maxLines = TOOL_PREVIEW_LINES): ToolCallPreview {
    const lines = output.replace(/\s+$/, "").split("\n");
    if (lines.length <= maxLines) return { lines, skipped: 0 };
    return { lines: lines.slice(-maxLines), skipped: lines.length - maxLines };
  }

  export function toolCallOutputText(output: string): string {
    try {
      const parsed: unknown = JSON.parse(output);
      if (!parsed || typeof parsed !== "object" || !("content" in parsed)) return output;
      const content = (parsed as { content?: unknown }).content;
      if (!Array.isArray(content)) return output;
      const unwrapped = content
        .filter((part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string",
          ),
        )
        .map((part) => part.text)
        .join("\n");
      return unwrapped || output;
    } catch {
      return output;
    }
  }

  export function formatToolDuration(milliseconds: number): string {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  function parseArguments(argumentSummary: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(argumentSummary);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  function compactArguments(args: Record<string, unknown>): string {
    return Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value : "";
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

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
  let normalizedOutput = $derived(toolCallOutputText(output));
  let preview = $derived(toolCallPreview(normalizedOutput));
  let lines = $derived(expanded ? normalizedOutput.replace(/\s+$/, "").split("\n") : preview.lines);
  let timing = $derived(
    startedAt === undefined
      ? undefined
      : `${status === "running" ? "Elapsed" : "Took"} ${formatToolDuration((endedAt ?? now) - startedAt)}`,
  );
</script>

<div
  class={[
    "tool-call mx-1 my-2 rounded-lg px-3 py-2 font-mono text-[11.5px] leading-[1.55]",
    status === "success"
      ? "bg-[var(--tool-success)]"
      : status === "error"
        ? "bg-[var(--tool-error)]"
        : "bg-[var(--tool-pending)]",
  ]}
>
  <button
    type="button"
    class="block w-full cursor-pointer border-0 border-none bg-transparent p-0 text-left text-inherit"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <span class="block font-semibold whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
      ><span>{header.label}</span>{" "}{#if header.detail}<span
          class={header.label === "$" ? "" : "text-[var(--tool-argument)]"}>{header.detail}</span
        >{/if}</span
    >
    {#if !expanded && preview.skipped > 0}
      <span class="mt-[0.5em] block text-faint"
        >… ({preview.skipped} earlier lines, click to expand)</span
      >
    {/if}
  </button>
  {#if normalizedOutput}
    <pre
      class="tool-call__output mt-[0.5em] mb-0 max-h-88 overflow-auto whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{lines.join(
        "\n",
      )}</pre>
  {/if}
  {#if timing}<p class="tool-call__timing mt-[0.5em] mb-0 text-faint">{timing}</p>{/if}
  {@render children?.()}
</div>
