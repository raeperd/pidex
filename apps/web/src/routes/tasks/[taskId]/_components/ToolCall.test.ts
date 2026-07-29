import { describe, expect, it } from "vitest";
import {
  formatToolDuration,
  toolCallHeader,
  toolCallOutputText,
  toolCallPreview,
} from "./ToolCall.svelte";

describe("toolCallHeader", () => {
  it("renders bash calls as a shell prompt", () => {
    expect(toolCallHeader("bash", JSON.stringify({ command: "ls -la", timeout: 30 }))).toEqual({
      label: "$",
      detail: "ls -la",
    });
  });

  it("renders path tools as concise actions and targets", () => {
    expect(
      toolCallHeader("read", JSON.stringify({ path: "README.md", offset: 1, limit: 800 })),
    ).toEqual({
      label: "read",
      detail: "README.md",
      range: ":1-800",
    });
    expect(toolCallHeader("grep", JSON.stringify({ pattern: "TODO", path: "src" }))).toEqual({
      label: "Searched",
      detail: "TODO · src",
    });
  });

  it("falls back to compact arguments and to truncated summaries", () => {
    expect(toolCallHeader("custom", JSON.stringify({ limit: 5, mode: "fast" }))).toEqual({
      label: "custom",
      detail: "limit=5 mode=fast",
    });
    expect(toolCallHeader("bash", '{"command": "ls -')).toEqual({
      label: "bash",
      detail: '{"command": "ls -',
    });
  });
});

describe("toolCallPreview", () => {
  it("unwraps Pi text results before presenting tool output", () => {
    expect(
      toolCallOutputText(
        JSON.stringify({ content: [{ type: "text", text: "ok\tgithub.com/example/project\n" }] }),
      ),
    ).toBe("ok\tgithub.com/example/project\n");
  });

  it("keeps the trailing window and counts what it hid", () => {
    const preview = toolCallPreview("1\n2\n3\n4\n5\n6\n7\n");

    expect(preview.lines).toEqual(["3", "4", "5", "6", "7"]);
    expect(preview.skipped).toBe(2);
  });

  it("keeps short output whole", () => {
    expect(toolCallPreview("one\ntwo")).toEqual({ lines: ["one", "two"], skipped: 0 });
  });
});

describe("formatToolDuration", () => {
  it("reports one decimal of seconds", () => {
    expect(formatToolDuration(96)).toBe("0.1s");
    expect(formatToolDuration(12_340)).toBe("12.3s");
  });
});
