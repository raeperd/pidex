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
