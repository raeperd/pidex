<script lang="ts" module>
  type ToolCallKind = "shell" | "read" | "search" | "edit" | "generic";

  interface ToolCallHeader {
    kind: ToolCallKind;
    label: string;
    detail: string;
    range?: string;
  }

  interface ToolCallPreview {
    lines: string[];
    skipped: number;
  }

  const KIND_ICONS = {
    shell: "terminal",
    read: "file",
    search: "search",
    edit: "compose",
    generic: "tool",
  } as const;

  export function toolCallExpanded(override: boolean | undefined, status: string): boolean {
    return override ?? status === "error";
  }

  export function toolCallHeader(name: string, argumentSummary: string): ToolCallHeader {
    const kind = toolCallKind(name);
    const args = parseArguments(argumentSummary);
    if (!args)
      return {
        kind,
        label: toolCallLabel(name, kind),
        detail: argumentSummary.trim(),
      };
    if (kind === "shell")
      return { kind, label: "$", detail: text(args.command) || compactArguments(args) || "…" };
    if (kind === "read") return { kind, label: "Read", ...readDetail(args) };
    if (kind === "search")
      return {
        kind,
        label: "Search",
        detail: [text(args.pattern), text(args.path) || text(args.file_path)]
          .filter(Boolean)
          .join(" · "),
      };
    if (kind === "edit")
      return {
        kind,
        label: name === "write" ? "Write" : "Edit",
        detail:
          text(args.path) || text(args.file_path) || text(args.patch) || compactArguments(args),
      };
    const detail = [text(args.pattern), text(args.path) || text(args.file_path)]
      .filter(Boolean)
      .join(" ");
    return { kind, label: humanizeToolName(name), detail: detail || compactArguments(args) };
  }

  /** Keeps the trailing window of output, like Pi's collapsed tool result. */
  export function toolCallPreview(output: string, maxLines = 5): ToolCallPreview {
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

  export function toolCallKind(name: string): ToolCallKind {
    if (["bash", "shell", "exec", "exec_command"].includes(name)) return "shell";
    if (name === "read") return "read";
    if (["grep", "find", "search"].includes(name)) return "search";
    if (["edit", "write", "apply_patch"].includes(name)) return "edit";
    return "generic";
  }

  function toolCallLabel(name: string, kind: ToolCallKind): string {
    if (kind === "shell") return "$";
    if (kind === "read") return "Read";
    if (kind === "search") return "Search";
    if (kind === "edit") return name === "write" ? "Write" : "Edit";
    return humanizeToolName(name);
  }

  function humanizeToolName(name: string): string {
    const words = name.replaceAll(/[_-]+/g, " ").trim();
    return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : "Tool";
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

  function readDetail(args: Record<string, unknown>): Pick<ToolCallHeader, "detail" | "range"> {
    const path = text(args.path) || text(args.file_path) || "…";
    const offset = number(args.offset);
    const limit = number(args.limit);
    if (offset === undefined && limit === undefined) return { detail: path };
    const start = offset ?? 1;
    return {
      detail: path,
      range: `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`,
    };
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "../../../_components/Icon.svelte";

  let {
    name,
    argumentSummary,
    status,
    output,
    startedAt,
    endedAt,
    now,
    detailsAvailable,
    children,
  }: {
    name: string;
    argumentSummary: string;
    status: "running" | "success" | "error";
    output: string;
    startedAt?: number;
    endedAt?: number;
    now: number;
    detailsAvailable?: boolean;
    children?: Snippet;
  } = $props();

  let expandedOverride = $state<boolean | undefined>(undefined);
  let expanded = $derived(toolCallExpanded(expandedOverride, status));
  let header = $derived(toolCallHeader(name, argumentSummary));
  let normalizedOutput = $derived(toolCallOutputText(output));
  let preview = $derived(toolCallPreview(normalizedOutput));
  let hasDetails = $derived(detailsAvailable ?? Boolean(normalizedOutput));
  let timing = $derived(
    startedAt === undefined
      ? undefined
      : `${status === "running" ? "Elapsed" : "Took"} ${formatToolDuration((endedAt ?? now) - startedAt)}`,
  );
  let icon = $derived(KIND_ICONS[header.kind]);
  let accessibleLabel = $derived(
    `${header.label}${header.detail ? ` ${header.detail}${header.range ?? ""}` : ""}`,
  );
</script>

<div
  class={[
    "tool-call min-w-0 text-control leading-[1.5]",
    header.kind === "shell"
      ? "tool-call--shell rounded-lg bg-secondary/70 px-2 py-2 font-mono"
      : "tool-call--activity font-sans",
  ]}
  data-tool-kind={header.kind}
  data-tool-status={status}
>
  {#snippet headerContent()}
    <span
      class={[
        "grid size-5.5 flex-none place-items-center text-faint",
        status === "running" && "text-primary",
        status === "error" && "text-danger",
      ]}
    >
      <Icon name={icon} size={14} />
    </span>
    <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span class="flex-none font-semibold text-foreground">{header.label}</span>
      {#if header.detail}<span
          class={[
            "min-w-0 truncate font-mono font-normal",
            header.kind === "shell" ? "text-foreground" : "text-muted",
          ]}
          title={header.detail}>{header.detail}</span
        >{/if}
      {#if header.range}<span
          class="tool-call__range flex-none font-mono font-semibold text-warning-text"
          >{header.range}</span
        >{/if}
    </span>
    <span class="ml-auto flex flex-none items-center gap-1.5 text-meta text-faint">
      {#if timing}<span class="tool-call__timing">{timing}</span>{/if}
      {#if status === "running"}
        <span class="animate-spin text-primary" aria-label="Running"
          ><Icon name="loader" size={13} /></span
        >
      {:else if status === "error"}
        <span class="inline-flex items-center gap-1 text-danger"
          ><Icon name="x" size={13} /><span>Failed</span></span
        >
      {:else}
        <span class="text-faint" aria-label="Complete"><Icon name="check" size={13} /></span>
      {/if}
      {#if hasDetails}<span
          class={["transition-transform duration-150", expanded && "rotate-90"]}
          aria-hidden="true"><Icon name="chevron" size={13} /></span
        >{/if}
    </span>
  {/snippet}

  {#if hasDetails}
    <button
      type="button"
      class={[
        "flex min-h-8 w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent text-left text-inherit outline-none",
        header.kind === "shell"
          ? "rounded-md p-0 focus-visible:ring-2 focus-visible:ring-primary"
          : "rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary",
      ]}
      aria-label={accessibleLabel}
      aria-expanded={expanded}
      onclick={() => (expandedOverride = !expanded)}
    >
      {@render headerContent()}
    </button>
  {:else}
    <div
      class={[
        "flex min-h-8 w-full items-center gap-1.5",
        header.kind === "shell" ? "p-0" : "rounded-lg px-2 py-1.5",
      ]}
      aria-label={accessibleLabel}
    >
      {@render headerContent()}
    </div>
  {/if}

  {#if header.kind === "shell" && normalizedOutput && !expanded}
    {#if preview.skipped > 0}<p class="mt-1 mb-0 text-faint">
        … {preview.skipped} earlier {preview.skipped === 1 ? "line" : "lines"}
      </p>{/if}
    <pre
      class="tool-call__output mt-1 mb-0 max-h-32 overflow-auto whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{preview.lines.join(
        "\n",
      )}</pre>
  {/if}

  {#if expanded && hasDetails}
    <div
      class={[
        "tool-call__details mt-1.5 min-w-0",
        header.kind === "shell"
          ? "border-t border-border pt-2"
          : "ml-7 rounded-r-lg border-l border-border-strong bg-secondary/45 px-3 py-2 font-mono",
      ]}
    >
      {#if normalizedOutput}<pre
          class="tool-call__output m-0 max-h-88 overflow-auto whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{normalizedOutput.replace(
            /\s+$/,
            "",
          )}</pre>{/if}
      {@render children?.()}
    </div>
  {/if}
</div>
